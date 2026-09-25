/**
 * FW リリース日による取得モードの絞り込み。
 *
 * - begin() の先頭で GET_FW_NAME を read し、OrpheCoreInsole.firmware にキャッシュする
 * - profile.modes() の minReleaseDate と突き合わせて availableModes を出す
 * - FW 情報が取れない個体（旧 FW・characteristic 未実装）は絞り込まない
 * - FIFO は FifoRecorder.start() が availableModes を見て、使えない FW では開始しない
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OrpheCoreInsole } from '../../src/device/orphe-core-insole.ts';
import { coreProfile } from '../../src/profiles/core.ts';
import { CORE_FIFO_MIN_RELEASE_DATE } from '../../src/modes/core.ts';
import { insoleProfile } from '../../src/profiles/insole.ts';
import { INSOLE_FIFO_MIN_RELEASE_DATE } from '../../src/modes/insole.ts';
import { ORPHE_UUID } from '../../src/protocol/uuids.ts';
import { encodeDateTime } from '../../src/protocol/datetime.ts';
import { FW_NAME_BYTE_LENGTH } from '../../src/protocol/fw-info.ts';
import { fwPayload } from '../helpers/fw-payload.ts';
import { FifoRecorder } from '../../src/fifo/recorder.ts';
import { MemoryStorage, MockBluetooth, MockDevice } from '../helpers/mock-bluetooth.ts';

/** GET_FW_NAME / DEVICE_INFORMATION / DATE_TIME を返すモック CORE */
function makeCore(options: { fw?: DataView | null } = {}) {
  const bluetooth = new MockBluetooth();
  const storage = new MemoryStorage();
  const device = new MockDevice('core-1', 'ORPHE-CORE');
  bluetooth.chooserQueue.push(device);

  const info = device.gatt.getOrCreateService(ORPHE_UUID.INFORMATION_SERVICE);
  info.getOrCreate(ORPHE_UUID.DEVICE_INFORMATION).readValueData = new DataView(new ArrayBuffer(20));
  info.getOrCreate(ORPHE_UUID.DATE_TIME).readValueData = new DataView(encodeDateTime(new Date()).buffer);

  const other = device.gatt.getOrCreateService(ORPHE_UUID.OTHER_SERVICE);
  other.getOrCreate(ORPHE_UUID.SENSOR_VALUES);
  other.getOrCreate(ORPHE_UUID.STEP_ANALYSIS);
  if (options.fw !== null) {
    other.getOrCreate(ORPHE_UUID.GET_FW_NAME).readValueData = options.fw ?? fwPayload(2026, 9, 5);
  }

  const errors: unknown[] = [];
  const ble = new OrpheCoreInsole({
    profile: coreProfile({ settleMs: 0, timeSyncSamples: 1 }),
    id: 0,
    bluetooth,
    storage,
    events: { onError: (error) => errors.push(error) },
    wait: async () => {},
  });
  return { ble, device, errors };
}

const ids = (modes: { id: string }[]) => modes.map(m => m.id);

test('modes(): CORE は FIFO だけリリース日で制限され、他は FW を問わない', () => {
  const profile = coreProfile();
  const modes = profile.modes();
  assert.deepEqual(ids(modes), ['STEP_ANALYSIS_AND_SENSOR_VALUES', 'STEP_ANALYSIS', 'SENSOR_VALUES', 'FIFO']);
  for (const mode of modes) {
    assert.equal(mode.minReleaseDate, mode.id === 'FIFO' ? CORE_FIFO_MIN_RELEASE_DATE : 0);
  }
});

test('begin() 前は firmware 未取得で、すべてのモードが候補に残る', () => {
  const { ble } = makeCore();
  assert.equal(ble.firmware, null);
  assert.deepEqual(ids(ble.availableModes), ids(coreProfile().modes()));
});

test('begin() で FW 情報を読み、対応 FW なら FIFO が使える', async () => {
  const { ble } = makeCore({ fw: fwPayload(2026, 9, 5) });
  await ble.begin('SENSOR_VALUES');
  assert.equal(ble.firmware?.releaseDate, 20260905);
  assert.ok(ids(ble.availableModes).includes('FIFO'));
});

test('リリース日が古い FW では FIFO が候補から外れる', async () => {
  const { ble } = makeCore({ fw: fwPayload(2025, 1, 20) });
  await ble.begin('SENSOR_VALUES');
  assert.equal(ble.firmware?.releaseDate, 20250120);
  assert.deepEqual(ids(ble.availableModes), ['STEP_ANALYSIS_AND_SENSOR_VALUES', 'STEP_ANALYSIS', 'SENSOR_VALUES']);
});

test('FW 情報が読めない個体は絞り込まない（旧 FW を締め出さない）', async () => {
  const { ble } = makeCore({ fw: null });
  await ble.begin('SENSOR_VALUES');
  assert.equal(ble.firmware, null);
  assert.ok(ids(ble.availableModes).includes('FIFO'));
});

test('日付が未書込の FW 情報も「不明」として扱い絞り込まない', async () => {
  const { ble } = makeCore({ fw: new DataView(new ArrayBuffer(FW_NAME_BYTE_LENGTH)) });
  await ble.begin('SENSOR_VALUES');
  assert.equal(ble.firmware, null);
  assert.ok(ids(ble.availableModes).includes('FIFO'));
});

test('古い FW では FifoRecorder.start() が UNSUPPORTED_MODE を報告して開始しない', async () => {
  const { ble, device, errors } = makeCore({ fw: fwPayload(2025, 1, 20) });
  await ble.begin('SENSOR_VALUES');
  const info = device.gatt.getOrCreateService(ORPHE_UUID.INFORMATION_SERVICE).getOrCreate(ORPHE_UUID.DEVICE_INFORMATION);
  const writesBefore = info.written.length;

  const fifo = new FifoRecorder(ble);
  assert.equal(await fifo.start(), false);
  assert.equal(fifo.isRunning, false);
  assert.equal(info.written.length, writesBefore, 'FIFO のコマンドを送らない');
  assert.equal((errors.at(-1) as { code?: string }).code, 'UNSUPPORTED_MODE');
});

test('modes(): INSOLE も FIFO だけリリース日で制限される', () => {
  const modes = insoleProfile().modes();
  assert.deepEqual(ids(modes), ['STREAMING_4', 'STREAMING_3', 'STREAMING_1', 'STEP_ANALYSIS', 'FIFO']);
  for (const mode of modes) {
    assert.equal(mode.minReleaseDate, mode.id === 'FIFO' ? INSOLE_FIFO_MIN_RELEASE_DATE : 0);
  }
});

test('INSOLE: しきい値ちょうどの FW では FIFO が使え、1日前では使えない', () => {
  const onThreshold = { releaseDate: INSOLE_FIFO_MIN_RELEASE_DATE };
  const dayBefore = { releaseDate: INSOLE_FIFO_MIN_RELEASE_DATE - 1 };
  const fifo = insoleProfile().modes().find(mode => mode.id === 'FIFO')!;
  assert.equal(onThreshold.releaseDate >= fifo.minReleaseDate, true);
  assert.equal(dayBefore.releaseDate >= fifo.minReleaseDate, false);
});

test('readFirmwareInfo() の実行中は connecting 状態になる', async () => {
  const { ble } = makeCore();
  let stateDuringRead: string | null = null;
  const original = ble.transport.read.bind(ble.transport);
  ble.transport.read = async (uuid: string, options?: object) => {
    stateDuringRead = ble.connectionState;
    return original(uuid, options);
  };
  await ble.readFirmwareInfo();
  assert.equal(stateDuringRead, 'connecting');
  assert.notEqual(ble.connectionState, 'connecting'); // 終わったら降りる
});

test('readFirmwareInfo(): FW 読取の失敗は null だが、デバイス選択の失敗は reject する', async () => {
  const empty = makeCore({ fw: new DataView(new ArrayBuffer(23)) });
  assert.equal(await empty.ble.readFirmwareInfo(), null, 'GET_FW_NAME が空なら null');
  assert.equal(empty.errors.length, 0);

  const errors: unknown[] = [];
  const cancelled = new OrpheCoreInsole({
    profile: coreProfile({ settleMs: 0, timeSyncSamples: 1 }),
    id: 0,
    bluetooth: new MockBluetooth(), // chooser は空 = キャンセル
    storage: new MemoryStorage(),
    events: { onError: (error) => errors.push(error) },
  });
  await assert.rejects(() => cancelled.readFirmwareInfo(), /cancelled/);
  assert.equal(cancelled.connectionState, 'disconnected');
  assert.ok(errors.length >= 1, 'onError に報告される');
});

test('begin(): プロファイルの begin() に読み取った firmware を渡す', async () => {
  const bluetooth = new MockBluetooth();
  const device = new MockDevice('core-2', 'ORPHE-CORE');
  bluetooth.chooserQueue.push(device);
  const info = device.gatt.getOrCreateService(ORPHE_UUID.INFORMATION_SERVICE);
  info.getOrCreate(ORPHE_UUID.DEVICE_INFORMATION).readValueData = new DataView(new ArrayBuffer(20));
  info.getOrCreate(ORPHE_UUID.DATE_TIME).readValueData = new DataView(encodeDateTime(new Date()).buffer);
  const other = device.gatt.getOrCreateService(ORPHE_UUID.OTHER_SERVICE);
  other.getOrCreate(ORPHE_UUID.SENSOR_VALUES);
  other.getOrCreate(ORPHE_UUID.GET_FW_NAME).readValueData = fwPayload(2026, 9, 5);

  const profile = coreProfile({ settleMs: 0, timeSyncSamples: 1 });
  const seen: (number | null | undefined)[] = [];
  const originalBegin = profile.begin.bind(profile);
  profile.begin = (context) => {
    seen.push(context.firmware?.releaseDate ?? null);
    return originalBegin(context);
  };
  const ble = new OrpheCoreInsole({ profile, id: 0, bluetooth, storage: new MemoryStorage(), wait: async () => {} });
  await ble.begin('SENSOR_VALUES');
  assert.deepEqual(seen, [20260905]);
});
