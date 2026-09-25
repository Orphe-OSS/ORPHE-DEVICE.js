/**
 * FifoRecorder — 収集ループの統合テスト（fake FW）
 *
 * DEVICE_INFORMATION への write に反応して SENSOR_VALUES notify を返す
 * fake FW を mock characteristic 上に実装し、実プロトコルの往復で
 * ハンドシェイク・回収・再要求・欠損計上・停止時回収（catch-up/drain）を検証する。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FifoRecorder } from '../../src/fifo/recorder.ts';
import { FIFO_CSV_HEADER, decodeFifoPacket, rawStoreToCSV } from '../../src/fifo/protocol.ts';
import type { FifoDataLossInfo, FifoStoppedInfo, FifoRecorderOptions } from '../../src/fifo/recorder.ts';
import { OrpheCoreInsole } from '../../src/device/orphe-core-insole.ts';
import type { BeginContext, DeviceProfile, SensorSample } from '../../src/device/profile.ts';
import type { BleRequestDeviceOptions } from '../../src/ble/web-bluetooth.ts';
import type { CharacteristicId } from '../../src/protocol/uuids.ts';
import { MemoryStorage, MockBluetooth, MockCharacteristic, MockDevice } from '../helpers/mock-bluetooth.ts';

const SERVICE_A = '01a9d6b5-ff6e-444a-b266-0be75e85c064';
const CHAR_INFO = '24354f22-1c46-430e-a4ab-a1eeabbcdfc0';
const SERVICE_B = 'db1b7aca-cda5-4453-a49b-33a53d3f0833';
const CHAR_SENSOR = 'f3f9c7ce-46ee-4205-89ac-abe64e626c0f';

class FakeInsoleProfile implements DeviceProfile {
  readonly kind = 'insole';
  readonly defaultNotificationType = 'SENSOR_VALUES';
  streaming_mode: number | null = 4;

  storageKey(id: number): string {
    return `orphe_fifo_test_device_${id}`;
  }

  requestDeviceOptions(): BleRequestDeviceOptions {
    return { filters: [{ namePrefix: 'INS' }] };
  }

  characteristics(): Record<string, CharacteristicId> {
    return {
      DEVICE_INFORMATION: { serviceUUID: SERVICE_A, characteristicUUID: CHAR_INFO },
      SENSOR_VALUES: { serviceUUID: SERVICE_B, characteristicUUID: CHAR_SENSOR },
    };
  }

  async begin(context: BeginContext): Promise<string> {
    await context.transport.startNotify('SENSOR_VALUES');
    return 'ok';
  }

  parse(): SensorSample[] | null {
    return null;
  }
}

/**
 * core プロファイル相当の fake（streaming_mode プロパティを持たない）。
 * FIFO の FW コマンド仕様は insole と共通（対応 FW が必要）。
 */
class FakeCoreProfile implements DeviceProfile {
  readonly kind = 'core';
  readonly defaultNotificationType = 'SENSOR_VALUES';

  storageKey(id: number): string {
    return `orphe_fifo_core_test_device_${id}`;
  }

  requestDeviceOptions(): BleRequestDeviceOptions {
    return { filters: [{ namePrefix: 'CR-' }] };
  }

  characteristics(): Record<string, CharacteristicId> {
    return {
      DEVICE_INFORMATION: { serviceUUID: SERVICE_A, characteristicUUID: CHAR_INFO },
      SENSOR_VALUES: { serviceUUID: SERVICE_B, characteristicUUID: CHAR_SENSOR },
    };
  }

  async begin(context: BeginContext): Promise<string> {
    await context.transport.startNotify('SENSOR_VALUES');
    return 'ok';
  }

  parse(): SensorSample[] | null {
    return null;
  }
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 決定的な 104byte FIFO データパケット */
function makeFifoPacketBytes(serial: number): Uint8Array {
  const random = mulberry32(0x5eed ^ serial);
  const bytes = new Uint8Array(104);
  bytes[0] = 0x36;
  bytes[1] = (serial >> 8) & 0xff;
  bytes[2] = serial & 0xff;
  const totalMs = (serial * 20) % 86400000;
  bytes[3] = Math.floor(totalMs / 3600000);
  bytes[4] = Math.floor(totalMs / 60000) % 60;
  bytes[5] = Math.floor(totalMs / 1000) % 60;
  const ms = totalMs % 1000;
  bytes[6] = (ms >> 8) & 0xff;
  bytes[7] = ms & 0xff;
  for (let i = 8; i < 104; i++) bytes[i] = Math.floor(random() * 256);
  return bytes;
}

/**
 * FW リングバッファのふるまいを模倣する fake FW。
 * DEVICE_INFORMATION への write を解釈し、SENSOR_VALUES へ notify を返す。
 */
class FakeInsoleFw {
  readonly sensor: MockCharacteristic;
  currentSerial = 0;
  accumulated = 0;
  store = new Map<number, Uint8Array>();
  readMode: number | null = null;
  monitorRunning = false;
  /** 現在シリアル問い合わせに応答するか */
  respondToSerialQuery = true;
  /** データ範囲要求に応答するか（false なら完全沈黙） */
  respondToDataRequests = true;
  /** 1回だけ「BLE で落ちた」ことにするシリアル（応答から抜くが FW には残る） */
  dropOnce = new Set<number>();
  /** 常に「BLE で落ちた」ことにするシリアル */
  dropAlways = new Set<number>();
  /** モニタ停止コマンドをこの回数だけ落とす（未処理・ACK なし） */
  failStopMonitor = 0;

  constructor(info: MockCharacteristic, sensor: MockCharacteristic) {
    this.sensor = sensor;
    info.onWriteValue = (bytes) => this.handle(bytes);
  }

  /** n パケットぶん FW がデータを生成する */
  advance(n: number): void {
    for (let i = 0; i < n; i++) {
      this.currentSerial = (this.currentSerial + 1) % 65536;
      if (this.monitorRunning) {
        this.store.set(this.currentSerial, makeFifoPacketBytes(this.currentSerial));
        this.accumulated = Math.min(this.accumulated + 1, 1500);
      }
    }
  }

  private emit(bytes: number[] | Uint8Array): void {
    const array = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes);
    this.sensor.emit(new DataView(array.buffer.slice(0)));
  }

  private handle(bytes: Uint8Array): void {
    if (bytes[0] === 0x0d) {
      this.readMode = bytes[1] ?? null;
      return;
    }
    if (bytes[0] !== 0x0b) return;
    const sub = bytes[1];
    if (sub === 0x01) {
      if (!this.respondToSerialQuery) return;
      this.emit([0x35, 0x01, (this.currentSerial >> 8) & 0xff, this.currentSerial & 0xff, 0, (this.accumulated >> 8) & 0xff, this.accumulated & 0xff]);
      return;
    }
    if (sub === 0x03) {
      this.store.clear();
      this.accumulated = 0;
      this.emit([0x35, 0x03]);
      return;
    }
    if (sub === 0x04) {
      this.monitorRunning = true;
      this.emit([0x35, 0x04]);
      return;
    }
    if (sub === 0x06) {
      if (this.failStopMonitor > 0) {
        this.failStopMonitor -= 1;
        return;
      }
      this.monitorRunning = false;
      this.emit([0x35, 0x06]);
      return;
    }
    if (sub === 0x02) {
      if (!this.respondToDataRequests) return;
      const noData: number[] = [];
      for (let p = 2; p + 3 < bytes.length; p += 4) {
        const start = ((bytes[p]! << 8) | bytes[p + 1]!) & 0xffff;
        const count = ((bytes[p + 2]! << 8) | bytes[p + 3]!) & 0xffff;
        for (let i = 0; i < count; i++) {
          const serial = (start + i) % 65536;
          const packet = this.store.get(serial);
          if (!packet) {
            noData.push(serial);
            continue;
          }
          if (this.dropOnce.delete(serial)) continue; // BLE ロス: 応答が空中で消えた
          if (this.dropAlways.has(serial)) continue;
          this.emit(packet);
        }
      }
      // no-data は連番の塊ごとに 0x35 0x02 start count で返す
      let runStart: number | null = null;
      let runLen = 0;
      const flush = () => {
        if (runStart === null || runLen === 0) return;
        this.emit([0x35, 0x02, (runStart >> 8) & 0xff, runStart & 0xff, (runLen >> 8) & 0xff, runLen & 0xff]);
        runStart = null;
        runLen = 0;
      };
      for (const serial of noData) {
        if (runStart !== null && serial === (runStart + runLen) % 65536) {
          runLen += 1;
        } else {
          flush();
          runStart = serial;
          runLen = 1;
        }
      }
      flush();
    }
  }
}

const FAST_TIMING: FifoRecorderOptions = {
  startupDelayMs: 0,
  timing: {
    pollingIntervalMs: 1,
    currentSerialTimeoutMs: 20,
    oneShotTimeoutMs: 60,
    oneShotIdleTimeoutMs: 15,
    commandAckTimeoutMs: 20,
    modeSwitchDelayMs: 0,
    fifoModeSettleMs: 0,
    retryIntervalMs: 1,
  },
};

async function makeHarnessWith<P extends DeviceProfile>(profile: P) {
  const bluetooth = new MockBluetooth();
  const storage = new MemoryStorage();
  const device = new MockDevice('ins-1', 'INS-01');
  bluetooth.chooserQueue.push(device);
  const infoCharacteristic = device.gatt.getOrCreateService(SERVICE_A).getOrCreate(CHAR_INFO);
  const sensorCharacteristic = device.gatt.getOrCreateService(SERVICE_B).getOrCreate(CHAR_SENSOR);
  const fw = new FakeInsoleFw(infoCharacteristic, sensorCharacteristic);
  const errors: unknown[] = [];
  const ble = new OrpheCoreInsole({
    profile,
    id: 0,
    bluetooth,
    storage,
    events: { onError: (error) => errors.push(error) },
    wait: async () => {},
  });
  await ble.begin();
  return { ble, profile, fw, infoCharacteristic, errors };
}

async function makeHarness() {
  return makeHarnessWith(new FakeInsoleProfile());
}

async function waitUntil(condition: () => boolean, label: string, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`waitUntil timeout: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

test('FIFO: 正常系 — 収集・onSamples・stop でモード復帰と CSV', async () => {
  const h = await makeHarness();
  const fifo = new FifoRecorder(h.ble, FAST_TIMING);
  const sampleBatches: number[] = [];
  const stopped: FifoStoppedInfo[] = [];
  fifo.onSamples = (_id, samples) => sampleBatches.push(samples.length);
  fifo.onStopped = (info) => stopped.push(info);

  assert.equal(await fifo.start(), true);
  assert.equal(h.fw.readMode, 0x02); // FIFO モードへ切替済み
  assert.equal(h.fw.monitorRunning, true);

  h.fw.advance(10);
  await waitUntil(() => fifo.collectedCount >= 10, 'collect 10');

  const store = await fifo.stop();
  assert.equal(store.size, 10);
  assert.equal(fifo.droppedCount, 0);
  assert.deepEqual(stopped, [{ reason: 'manual', dropped: 0, collected: 10, drainRecovered: 0, catchupRecovered: 0 }]);

  // サンプルは 1 パケット = 4 フレーム
  assert.equal(sampleBatches.reduce((a, b) => a + b, 0), 40);

  // モード復帰（0x0D 0x04 が stop 後に飛び、profile.streaming_mode も復元）
  assert.equal(h.fw.readMode, 4);
  assert.equal(h.profile.streaming_mode, 4);
  assert.equal(h.fw.monitorRunning, false);

  // CSV は回収した 10 パケット × 4 行
  const csv = fifo.toCSV();
  assert.equal(csv, rawStoreToCSV(store));
  const lines = csv.trimEnd().split('\n');
  assert.equal(lines[0], FIFO_CSV_HEADER);
  assert.equal(lines.length, 1 + 40);

  // sink が解除されている（再設定できる）
  const release = h.ble.setNotifySink('SENSOR_VALUES', () => {});
  release();
});

test('FIFO: デコード結果が decodeFifoPacket と一致し serial 順で揃う', async () => {
  const h = await makeHarness();
  const fifo = new FifoRecorder(h.ble, FAST_TIMING);
  const seen = new Map<number, number>(); // serial -> sample count
  fifo.onSamples = (_id, samples) => {
    for (const sample of samples) seen.set(sample.serial_number, (seen.get(sample.serial_number) ?? 0) + 1);
  };
  await fifo.start();
  h.fw.advance(5);
  await waitUntil(() => fifo.collectedCount >= 5, 'collect 5');
  const store = await fifo.stop();

  for (const [serial, dv] of store) {
    const decoded = decodeFifoPacket(dv);
    assert.equal(decoded.serial, serial);
    assert.equal(seen.get(serial), 4);
    // fake FW の生成パケットと一致
    assert.deepEqual(new Uint8Array(dv.buffer), makeFifoPacketBytes(serial));
  }
});

test('FIFO: BLE ロスは carryOver 再要求で回復し dropped 0', async () => {
  const h = await makeHarness();
  const fifo = new FifoRecorder(h.ble, FAST_TIMING);
  const anomalies: unknown[] = [];
  fifo.onAnomaly = (info) => anomalies.push(info);
  await fifo.start();

  h.fw.dropOnce.add(3).add(4); // serial 3,4 の応答が1回だけ空中で消える
  h.fw.advance(8);
  await waitUntil(() => fifo.collectedCount >= 8, 'collect 8 after re-request');

  const store = await fifo.stop();
  assert.equal(store.size, 8);
  assert.ok(store.has(3) && store.has(4));
  assert.equal(fifo.droppedCount, 0);
  assert.ok(anomalies.length >= 1); // 取りこぼしサイクルが観測されている
});

test('FIFO: FW から消えたシリアルは fw_nodata として dropped 計上', async () => {
  const h = await makeHarness();
  const fifo = new FifoRecorder(h.ble, FAST_TIMING);
  const losses: FifoDataLossInfo[] = [];
  fifo.onDataLoss = (info) => losses.push(info);
  await fifo.start();

  // serial 2 は BLE で落ち続け carryOver で再要求される。他 5 件の回収を待ってから
  // FW バッファから消す → 次の再要求で no-data → fw_nodata として1回だけ計上される
  h.fw.dropAlways.add(2);
  h.fw.advance(6);
  await waitUntil(() => fifo.collectedCount >= 5, 'collect 5');
  h.fw.store.delete(2); // FW リングバッファから消えた（上書き相当）
  await waitUntil(() => fifo.droppedCount === 1, 'dropped 1');

  await fifo.stop();
  assert.equal(fifo.droppedCount, 1);
  assert.equal(losses[0]!.reason, 'fw_nodata');
  assert.equal(losses[0]!.cumulative, 1);
  // 不変条件: 収録スパン = 回収数 + dropped
  assert.equal(fifo.state.storedSpanMax + 1, fifo.collectedCount + fifo.droppedCount);
});

test('FIFO: stopOnLoss で欠損時に自動停止し onStopped reason=loss', async () => {
  const h = await makeHarness();
  const fifo = new FifoRecorder(h.ble, { ...FAST_TIMING, stopOnLoss: true });
  const stopped: FifoStoppedInfo[] = [];
  fifo.onStopped = (info) => stopped.push(info);
  await fifo.start();

  h.fw.advance(4);
  h.fw.store.delete(2);
  await waitUntil(() => stopped.length > 0, 'auto stop');

  assert.equal(stopped[0]!.reason, 'loss');
  assert.equal(fifo.isRunning, false);
  await fifo.stop(); // 冪等
});

test('FIFO: stop 時の catch-up が未要求バックログを回収する', async () => {
  const h = await makeHarness();
  const fifo = new FifoRecorder(h.ble, {
    ...FAST_TIMING,
    timing: { ...FAST_TIMING.timing!, pollingIntervalMs: 60 }, // 停止ウィンドウを作る
  });
  const stopped: FifoStoppedInfo[] = [];
  fifo.onStopped = (info) => stopped.push(info);
  await fifo.start();

  h.fw.advance(5);
  await waitUntil(() => fifo.collectedCount >= 5, 'collect 5');

  // ループが 60ms 眠っている間にバックログを作って即 stop
  h.fw.advance(20);
  const store = await fifo.stop();

  assert.equal(store.size, 25);
  assert.equal(fifo.droppedCount, 0);
  assert.equal(stopped[0]!.catchupRecovered, 20);
  assert.equal(fifo.state.storedSpanMax + 1, 25);
});

test('FIFO: 回収しきれなかった末尾は stopped_pending として必ず計上される', async () => {
  const h = await makeHarness();
  const fifo = new FifoRecorder(h.ble, {
    ...FAST_TIMING,
    drainTimeoutMs: 40,
    timing: { ...FAST_TIMING.timing!, pollingIntervalMs: 60, oneShotTimeoutMs: 30 },
  });
  const losses: FifoDataLossInfo[] = [];
  fifo.onDataLoss = (info) => losses.push(info);
  await fifo.start();

  h.fw.advance(5);
  await waitUntil(() => fifo.collectedCount >= 5, 'collect 5');

  // バックログを作るが、FW はデータ要求に沈黙（現在シリアルには応答する）
  h.fw.advance(20);
  h.fw.respondToDataRequests = false;
  await fifo.stop();

  // 末尾 20 件は回収不能 → stopped_pending で dropped に計上（黙った切り捨てにしない）
  assert.equal(fifo.collectedCount, 5);
  assert.equal(fifo.droppedCount, 20);
  assert.ok(losses.some((loss) => loss.reason === 'stopped_pending' && loss.dropped === 20));
  // 不変条件: スパン内シリアル数 = 回収数 + dropped
  assert.equal(fifo.state.storedSpanMax + 1, fifo.collectedCount + fifo.droppedCount);
});

test('FIFO: 未接続では start できない', async () => {
  const h = await makeHarness();
  h.ble.stop();
  const fifo = new FifoRecorder(h.ble, FAST_TIMING);
  assert.equal(await fifo.start(), false);
  assert.ok(h.errors.some((error) => String(error).includes('not connected')));
});

test('FIFO: SENSOR_VALUES が他モジュールに横取りされていたら start は失敗する', async () => {
  const h = await makeHarness();
  const release = h.ble.setNotifySink('SENSOR_VALUES', () => {});
  const fifo = new FifoRecorder(h.ble, FAST_TIMING);
  assert.equal(await fifo.start(), false);
  assert.ok(h.errors.some((error) => String(error).includes('already installed')));
  release();
});

test('FIFO: start をやり直すと状態がリセットされ captureId が進む', async () => {
  const h = await makeHarness();
  const fifo = new FifoRecorder(h.ble, FAST_TIMING);
  await fifo.start();
  h.fw.advance(3);
  await waitUntil(() => fifo.collectedCount >= 3, 'collect 3');
  const checkpoint = fifo.createCheckpoint();
  await fifo.stop();

  await fifo.start();
  assert.equal(fifo.collectedCount, 0);
  // 前回 capture の checkpoint は無効（available: false）
  assert.equal(fifo.summarizeSince(checkpoint).available, false);
  h.fw.advance(2);
  await waitUntil(() => fifo.collectedCount >= 2, 'collect 2');
  await fifo.stop();
});

test('FIFO: createCheckpoint / summarizeSince が区間の完全性を返す', async () => {
  const h = await makeHarness();
  const fifo = new FifoRecorder(h.ble, FAST_TIMING);
  await fifo.start();
  h.fw.advance(4);
  await waitUntil(() => fifo.collectedCount >= 4, 'collect 4');
  const checkpoint = fifo.createCheckpoint();

  h.fw.advance(6);
  await waitUntil(() => fifo.collectedCount >= 10, 'collect 10');
  await fifo.stop();

  const summary = fifo.summarizeSince(checkpoint);
  assert.equal(summary.available, true);
  assert.equal(summary.expected, 6);
  assert.equal(summary.received, 6);
  assert.equal(summary.missing, 0);
  assert.equal(summary.dropped, 0);
});

test('FIFO: core プロファイルでも収集でき、既定で 0x01（リアルタイム要求）へ復帰する', async () => {
  const h = await makeHarnessWith(new FakeCoreProfile());
  const fifo = new FifoRecorder(h.ble, FAST_TIMING);
  const stopped: FifoStoppedInfo[] = [];
  fifo.onStopped = (info) => stopped.push(info);

  assert.equal(await fifo.start(), true);
  assert.equal(h.fw.readMode, 0x02);
  assert.equal(h.fw.monitorRunning, true);

  h.fw.advance(10);
  await waitUntil(() => fifo.collectedCount >= 10, 'collect 10 (core)');

  const store = await fifo.stop();
  assert.equal(store.size, 10);
  assert.equal(fifo.droppedCount, 0);
  assert.deepEqual(stopped, [{ reason: 'manual', dropped: 0, collected: 10, drainRecovered: 0, catchupRecovered: 0 }]);

  // core3 FW の 0x0D は 1=リアルタイム要求 / 2=ところてん要求のみ（insole のモード番号とは別物）
  assert.equal(h.fw.readMode, 0x01);
  assert.equal(h.fw.monitorRunning, false);
  assert.equal(h.errors.length, 0);
});

test('FIFO: モニタ停止コマンドが落ちても再試行して FW の収録を止める', async () => {
  const h = await makeHarness();
  const fifo = new FifoRecorder(h.ble, FAST_TIMING);
  await fifo.start();
  h.fw.advance(3);
  await waitUntil(() => fifo.collectedCount >= 3, 'collect 3 (stop retry)');
  h.fw.failStopMonitor = 2; // 最初の2回は FW に届かない
  await fifo.stop();
  assert.equal(h.fw.monitorRunning, false);
  assert.equal(h.fw.readMode, 4);
});

test('FIFO: restoreMode オプションで停止後の復帰モードを上書きできる', async () => {
  const h = await makeHarnessWith(new FakeCoreProfile());
  const fifo = new FifoRecorder(h.ble, { ...FAST_TIMING, restoreMode: 1 });
  await fifo.start();
  h.fw.advance(3);
  await waitUntil(() => fifo.collectedCount >= 3, 'collect 3 (restoreMode)');
  await fifo.stop();
  assert.equal(h.fw.readMode, 1);
});

test('FIFO: restoreMode 0 は 0x00 を書き、null は復帰 write を送らない', async () => {
  const h = await makeHarnessWith(new FakeCoreProfile());
  const fifo = new FifoRecorder(h.ble, { ...FAST_TIMING, restoreMode: 0 });
  await fifo.start();
  h.fw.advance(2);
  await waitUntil(() => fifo.collectedCount >= 2, 'collect 2 (restore 0)');
  await fifo.stop();
  assert.equal(h.fw.readMode, 0);

  const h2 = await makeHarnessWith(new FakeCoreProfile());
  const fifo2 = new FifoRecorder(h2.ble, { ...FAST_TIMING, restoreMode: null });
  await fifo2.start();
  h2.fw.advance(2);
  await waitUntil(() => fifo2.collectedCount >= 2, 'collect 2 (restore none)');
  await fifo2.stop();
  assert.equal(h2.fw.readMode, 0x02); // FIFO モードのまま
});
