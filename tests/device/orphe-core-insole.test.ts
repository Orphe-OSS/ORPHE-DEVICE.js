/**
 * OrpheCoreInsole: コンポジット・ファサード。
 *
 *   OrpheCoreInsole = OrpheBleTransport + DeviceProfile + SampleEmitter
 *
 * - begin() はプロファイルの接続シーケンスを実行し、成功時に記憶 + 再接続 arm
 * - 通知は profile.parse() → emitter 配送
 * - autoReconnect: リンクロスで begin シーケンスが自動再実行される
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OrpheCoreInsole } from '../../src/device/orphe-core-insole.ts';
import type { BeginContext, DeviceProfile, SensorSample } from '../../src/device/profile.ts';
import type { BleRequestDeviceOptions } from '../../src/ble/web-bluetooth.ts';
import type { TransportEvents } from '../../src/ble/types.ts';
import type { CharacteristicId } from '../../src/protocol/uuids.ts';
import { MemoryStorage, MockBluetooth, MockDevice, flushMicrotasks } from '../helpers/mock-bluetooth.ts';

const SERVICE_A = '01a9d6b5-ff6e-444a-b266-0be75e85c064';
const CHAR_INFO = '24354f22-1c46-430e-a4ab-a1eeabbcdfc0';
const SERVICE_B = 'db1b7aca-cda5-4453-a49b-33a53d3f0833';
const CHAR_SENSOR = 'f3f9c7ce-46ee-4205-89ac-abe64e626c0f';

/** begin シーケンスとパースを持つ最小プロファイル（実デバイス相当のステップを記録する） */
class FakeProfile implements DeviceProfile {
  readonly kind = 'fake';
  readonly defaultNotificationType = 'SENSOR_VALUES';
  beginTypes: string[] = [];
  steps: string[] = [];
  failNextBegin: unknown = null;
  resolveDevice?: (name: string | null) => void;

  storageKey(id: number): string {
    return `orphe_fake_last_device_${id}`;
  }

  requestDeviceOptions(): BleRequestDeviceOptions {
    return { filters: [{ namePrefix: 'FAKE' }] };
  }

  characteristics(): Record<string, CharacteristicId> {
    return {
      DEVICE_INFORMATION: { serviceUUID: SERVICE_A, characteristicUUID: CHAR_INFO },
      SENSOR_VALUES: { serviceUUID: SERVICE_B, characteristicUUID: CHAR_SENSOR },
    };
  }

  async begin(context: BeginContext): Promise<string> {
    this.beginTypes.push(context.notificationType);
    if (this.failNextBegin) {
      const error = this.failNextBegin;
      this.failNextBegin = null;
      throw error;
    }
    this.steps.push('device-info');
    await context.transport.read('DEVICE_INFORMATION');
    this.steps.push('configure');
    await context.transport.write('DEVICE_INFORMATION', [0x01]);
    this.steps.push('notify');
    await context.transport.startNotify('SENSOR_VALUES');
    return 'done begin(); fake';
  }

  parse(uuid: string, data: DataView): SensorSample[] | null {
    if (uuid !== 'SENSOR_VALUES') return null;
    return [{ acc: { x: data.getUint8(0), y: 0, z: 0 }, serial_number: data.getUint8(1) }];
  }
}

function makeHarness(events: TransportEvents = {}) {
  const bluetooth = new MockBluetooth();
  const storage = new MemoryStorage();
  const profile = new FakeProfile();
  const device = new MockDevice('fake-1', 'FAKE-01');
  bluetooth.chooserQueue.push(device);
  const characteristic = device.gatt.getOrCreateService(SERVICE_B).getOrCreate(CHAR_SENSOR);
  const ble = new OrpheCoreInsole({
    profile,
    id: 0,
    bluetooth,
    storage,
    events,
    wait: async () => {},
  });
  return { ble, profile, bluetooth, storage, device, characteristic, events };
}

function emit(characteristic: { emit(v: DataView): void }, ...bytes: number[]): void {
  characteristic.emit(new DataView(new Uint8Array(bytes).buffer));
}

test('readFirmwareInfo: GET_FW_NAME を登録しないプロファイルでも resolveDevice は呼ばれ、read はしない', async () => {
  const h = makeHarness();
  const resolved: (string | null)[] = [];
  h.profile.resolveDevice = (name) => { resolved.push(name); };
  const info = h.device.gatt.getOrCreateService(SERVICE_A).getOrCreate(CHAR_INFO);

  assert.equal(await h.ble.readFirmwareInfo(), null);

  assert.deepEqual(resolved, ['FAKE-01']);
  assert.equal(h.ble.firmware, null);
  assert.equal(info.readCalls, 0, 'FW characteristic が無いので GATT read は行わない');
  assert.equal(h.ble.transport.device?.name, 'FAKE-01', 'デバイスの選択は済んでいる');
});

test('begin: プロファイルのシーケンスを実行し、成功でデバイスを記憶する', async () => {
  const h = makeHarness();
  const result = await h.ble.begin();

  assert.equal(result, 'done begin(); fake');
  assert.deepEqual(h.profile.steps, ['device-info', 'configure', 'notify']);
  assert.deepEqual(h.profile.beginTypes, ['SENSOR_VALUES']);
  assert.equal(h.ble.isConnected(), true);
  assert.equal(h.ble.connectionState, 'connected');
  assert.ok(h.storage.getItem('orphe_fake_last_device_0')); // 記憶済み
});

test('begin 実行中の connectionState は connecting', async () => {
  const h = makeHarness();
  let stateDuringBegin = '';
  const originalBegin = h.profile.begin.bind(h.profile);
  h.profile.begin = async (context) => {
    stateDuringBegin = h.ble.connectionState;
    return originalBegin(context);
  };

  await h.ble.begin();
  assert.equal(stateDuringBegin, 'connecting');
  assert.equal(h.ble.connectionState, 'connected');
});

test('通知が profile.parse を通って on() リスナーへ届く', async () => {
  const h = makeHarness();
  const accs: Array<{ x: number }> = [];
  const serials: number[] = [];
  h.ble.on('acc', (value) => accs.push(value as { x: number }));
  h.ble.on('serial_number', (value) => serials.push(value as number));
  await h.ble.begin();

  emit(h.characteristic, 42, 7);
  emit(h.characteristic, 43, 8);

  assert.deepEqual(accs.map(a => a.x), [42, 43]);
  assert.deepEqual(serials, [7, 8]);
});

test('on() の解除関数でリスナーが外れる', async () => {
  const h = makeHarness();
  const accs: unknown[] = [];
  const off = h.ble.on('acc', (value) => accs.push(value));
  await h.ble.begin();

  off();
  emit(h.characteristic, 1, 0);
  assert.deepEqual(accs, []);
});

test('リスナーの throw は onError へ流れ、配送は継続する', async () => {
  const errors: unknown[] = [];
  const h = makeHarness({ onError: (e) => errors.push(e) });
  h.ble.on('acc', () => {
    throw new Error('listener boom');
  });
  await h.ble.begin();

  emit(h.characteristic, 1, 0);
  emit(h.characteristic, 2, 0);
  assert.equal(errors.length, 2);
});

test('生の onNotification イベントもユーザへ透過する', async () => {
  const raw: string[] = [];
  const h = makeHarness({ onNotification: (uuid) => raw.push(uuid) });
  await h.ble.begin();

  emit(h.characteristic, 1, 0);
  assert.deepEqual(raw, ['SENSOR_VALUES']);
});

test('begin: forceDeviceSelection は最初の選択だけ chooser を出し、各操作や再接続には渡さない', async () => {
  const h = makeHarness();
  const remembered = new MockDevice('fake-0', 'FAKE-00');
  h.storage.setItem(h.profile.storageKey(0), JSON.stringify({ bluetoothId: remembered.id, bluetoothName: remembered.name, lastConnectedAt: 1 }));
  h.bluetooth.knownDevices = [remembered, h.device];

  await h.ble.begin('SENSOR_VALUES', { forceDeviceSelection: true, autoReconnect: true, reconnect: { intervalMs: 0, maxAttempts: 2 } });

  assert.equal(h.bluetooth.requestDeviceCalls.length, 1, 'chooser は 1 回だけ');
  assert.equal(h.ble.transport.device, h.device);
  assert.equal(h.profile.steps.length, 3, 'read / write / notify がすべて同じデバイスで完了');

  h.device.gatt.simulateLinkLoss();
  await flushMicrotasks(100);
  assert.equal(h.bluetooth.requestDeviceCalls.length, 1, '再接続では chooser を出さない');
  assert.equal(h.ble.isConnected(), true);
});

test('autoReconnect: リンクロスで begin シーケンスが自動再実行される', async () => {
  const successes: unknown[] = [];
  const h = makeHarness({ onReconnectSuccess: (info) => successes.push(info) });
  await h.ble.begin('SENSOR_VALUES', { autoReconnect: true, reconnect: { intervalMs: 0, maxAttempts: 3 } });
  assert.equal(h.profile.beginTypes.length, 1);

  h.device.gatt.simulateLinkLoss();
  await flushMicrotasks(100);

  assert.equal(h.profile.beginTypes.length, 2); // 再実行された
  assert.equal(successes.length, 1);
  assert.equal(h.ble.isConnected(), true);
});

test('autoReconnect なしならリンクロスで再実行されない', async () => {
  const h = makeHarness();
  await h.ble.begin();

  h.device.gatt.simulateLinkLoss();
  await flushMicrotasks(100);

  assert.equal(h.profile.beginTypes.length, 1);
  assert.equal(h.ble.connectionState, 'disconnected');
});

test('begin が失敗したら reject し、切断イベントでも再接続ループしない', async () => {
  const h = makeHarness();
  h.profile.failNextBegin = new Error('begin boom');

  await assert.rejects(
    h.ble.begin('SENSOR_VALUES', { autoReconnect: true, reconnect: { intervalMs: 0, maxAttempts: 3 } }),
    /begin boom/
  );
  assert.equal(h.ble.connectionState, 'disconnected');

  // begin 成功前なので arm されておらず、切断イベントでループしない
  await h.device.gatt.connect();
  h.device.gatt.simulateLinkLoss();
  await flushMicrotasks(100);
  assert.equal(h.profile.beginTypes.length, 1);
});

test('stop: 切断して自動再接続も解除される', async () => {
  const h = makeHarness();
  await h.ble.begin('SENSOR_VALUES', { autoReconnect: true, reconnect: { intervalMs: 0, maxAttempts: 3 } });

  h.ble.stop();
  assert.equal(h.ble.connectionState, 'disconnected');

  await flushMicrotasks(100);
  assert.equal(h.profile.beginTypes.length, 1); // 再接続は走らない
});

test('再接続時は前回の begin 引数（type/options）が引き継がれる', async () => {
  const h = makeHarness();
  await h.ble.begin('CUSTOM_TYPE', { autoReconnect: true, reconnect: { intervalMs: 0, maxAttempts: 3 } });

  h.device.gatt.simulateLinkLoss();
  await flushMicrotasks(100);

  assert.deepEqual(h.profile.beginTypes, ['CUSTOM_TYPE', 'CUSTOM_TYPE']);
});

test('transport イベント（onScan / onConnect）はユーザへ透過し、後から差し替え可能', async () => {
  const calls: string[] = [];
  const events: TransportEvents = { onScan: () => calls.push('old') };
  const h = makeHarness(events);

  events.onScan = (name) => calls.push(`new:${name}`);
  await h.ble.begin();

  assert.deepEqual(calls, ['new:FAKE-01']); // 遅延バインド
});
