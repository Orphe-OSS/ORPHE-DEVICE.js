/**
 * OrpheCoreInsole.setNotifySink / OrpheBleTransport.addDisconnectHook
 *
 * FIFO 収録・歩容解析のようなプロトコルモジュールが notify を横取りし、
 * 切断で自身の購読状態を無効化するための機構。
 * - sink 設定中はその uuid の通知が sink のみに渡る
 *   （周波数計測・onRaw・parse・events.onNotification はスキップ）
 * - 解除で通常配送に戻る
 * - 多重設定はエラー、解除関数は自分の sink だけを外す
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OrpheCoreInsole } from '../../src/device/orphe-core-insole.ts';
import type { BeginContext, DeviceProfile, SensorSample } from '../../src/device/profile.ts';
import type { BleRequestDeviceOptions } from '../../src/ble/web-bluetooth.ts';
import type { TransportEvents } from '../../src/ble/types.ts';
import type { CharacteristicId } from '../../src/protocol/uuids.ts';
import { MemoryStorage, MockBluetooth, MockDevice } from '../helpers/mock-bluetooth.ts';

const SERVICE_A = '01a9d6b5-ff6e-444a-b266-0be75e85c064';
const CHAR_INFO = '24354f22-1c46-430e-a4ab-a1eeabbcdfc0';
const SERVICE_B = 'db1b7aca-cda5-4453-a49b-33a53d3f0833';
const CHAR_SENSOR = 'f3f9c7ce-46ee-4205-89ac-abe64e626c0f';

class FakeProfile implements DeviceProfile {
  readonly kind = 'fake';
  readonly defaultNotificationType = 'SENSOR_VALUES';
  parseCalls = 0;

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
    await context.transport.startNotify('SENSOR_VALUES');
    return 'ok';
  }

  parse(uuid: string, data: DataView): SensorSample[] | null {
    if (uuid !== 'SENSOR_VALUES') return null;
    this.parseCalls += 1;
    return [{ acc: { x: data.getUint8(0), y: 0, z: 0 } }];
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
  return { ble, profile, bluetooth, storage, device, characteristic };
}

function emit(characteristic: { emit(v: DataView): void }, ...bytes: number[]): void {
  characteristic.emit(new DataView(new Uint8Array(bytes).buffer));
}

test('setNotifySink: 設定中は sink のみに渡り、emitter/onRaw/parse/onNotification はスキップ', async () => {
  const notifications: string[] = [];
  const h = makeHarness({ onNotification: (uuid) => notifications.push(uuid) });
  const accs: unknown[] = [];
  const raws: number[] = [];
  const sinkBytes: number[] = [];
  h.ble.on('acc', (acc) => accs.push(acc));
  h.ble.onRaw((_uuid, value) => raws.push(value.getUint8(0)));
  await h.ble.begin();

  const remove = h.ble.setNotifySink('SENSOR_VALUES', (value) => sinkBytes.push(value.getUint8(0)));
  emit(h.characteristic, 10);
  emit(h.characteristic, 11);

  assert.deepEqual(sinkBytes, [10, 11]);
  assert.equal(accs.length, 0);
  assert.deepEqual(raws, []);
  assert.deepEqual(notifications, []);
  assert.equal(h.profile.parseCalls, 0);

  // 解除で通常配送へ戻る
  remove();
  emit(h.characteristic, 12);
  assert.deepEqual(sinkBytes, [10, 11]);
  assert.equal((accs[0] as { x: number }).x, 12);
  assert.deepEqual(raws, [12]);
  assert.deepEqual(notifications, ['SENSOR_VALUES']);
});

test('setNotifySink: 同じ uuid への多重設定はエラー', () => {
  const h = makeHarness();
  h.ble.setNotifySink('SENSOR_VALUES', () => {});
  assert.throws(() => h.ble.setNotifySink('SENSOR_VALUES', () => {}), /already installed/);
  // 別 uuid は独立に設定できる
  h.ble.setNotifySink('STEP_ANALYSIS', () => {});
});

test('setNotifySink: 解除関数は自分の sink だけを外す（後続の sink を壊さない）', async () => {
  const h = makeHarness();
  await h.ble.begin();
  const first: number[] = [];
  const second: number[] = [];
  const removeFirst = h.ble.setNotifySink('SENSOR_VALUES', (v) => first.push(v.getUint8(0)));
  removeFirst();
  const removeSecond = h.ble.setNotifySink('SENSOR_VALUES', (v) => second.push(v.getUint8(0)));
  removeFirst(); // 二重解除しても second は外れない

  emit(h.characteristic, 42);
  assert.deepEqual(first, []);
  assert.deepEqual(second, [42]);
  removeSecond();
});

test('setNotifySink: sink の例外は onError へ報告され、後続の通知は継続する', async () => {
  const errors: unknown[] = [];
  const h = makeHarness({ onError: (error) => errors.push(error) });
  await h.ble.begin();
  const received: number[] = [];
  h.ble.setNotifySink('SENSOR_VALUES', (value) => {
    if (value.getUint8(0) === 99) throw new Error('sink boom');
    received.push(value.getUint8(0));
  });

  emit(h.characteristic, 99);
  emit(h.characteristic, 1);

  assert.equal(errors.length, 1);
  assert.match(String(errors[0]), /sink boom/);
  assert.deepEqual(received, [1]);
});

test('addDisconnectHook: 切断でフックが呼ばれ、解除関数で外れる', async () => {
  const h = makeHarness();
  await h.ble.begin();
  const calls: string[] = [];
  const removeA = h.ble.transport.addDisconnectHook(() => calls.push('a'));
  h.ble.transport.addDisconnectHook(() => calls.push('b'));

  h.device.gatt.simulateLinkLoss();
  assert.deepEqual(calls, ['a', 'b']);

  removeA();
  await h.ble.begin();
  h.device.gatt.simulateLinkLoss();
  assert.deepEqual(calls, ['a', 'b', 'b']);
});

test('addDisconnectHook: フックの例外は onError へ報告され、ユーザ onDisconnect は呼ばれる', async () => {
  const errors: unknown[] = [];
  const disconnects: number[] = [];
  const h = makeHarness({
    onError: (error) => errors.push(error),
    onDisconnect: () => disconnects.push(1),
  });
  await h.ble.begin();
  h.ble.transport.addDisconnectHook(() => {
    throw new Error('hook boom');
  });

  h.device.gatt.simulateLinkLoss();
  assert.equal(errors.length, 1);
  assert.match(String(errors[0]), /hook boom/);
  assert.equal(disconnects.length, 1);
});
