/**
 * attachLegacyCallbacks: `ble.gotAcc = fn` 代入スタイルの got* コールバックアダプタ。
 * - サンプルのフィールド名 → got* 名（irregular: ble_frequency→gotBLEFrequency,
 *   lost_data→lostData(serial, prev) の2引数）に変換して target 上の関数を呼ぶ
 * - this は target に束縛（コールバック内で this.id を参照できる）
 * - gotData をオーバーライドすると他の got* が停止する
 *   （lostData / gotBLEFrequency は止まらない）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OrpheDevice } from '../../src/device/orphe-device.ts';
import { attachLegacyCallbacks, fieldToGotName } from '../../src/device/legacy.ts';
import type { BeginContext, DeviceProfile, SensorSample } from '../../src/device/profile.ts';
import type { BleRequestDeviceOptions } from '../../src/ble/web-bluetooth.ts';
import type { CharacteristicId } from '../../src/protocol/uuids.ts';
import { MemoryStorage, MockBluetooth, MockDevice } from '../helpers/mock-bluetooth.ts';

const SERVICE_B = 'db1b7aca-cda5-4453-a49b-33a53d3f0833';
const CHAR_SENSOR = 'f3f9c7ce-46ee-4205-89ac-abe64e626c0f';

class FakeProfile implements DeviceProfile {
  readonly kind = 'fake';
  readonly defaultNotificationType = 'SENSOR_VALUES';
  storageKey(id: number): string {
    return `orphe_legacy_test_${id}`;
  }
  requestDeviceOptions(): BleRequestDeviceOptions {
    return { filters: [{ namePrefix: 'FAKE' }] };
  }
  characteristics(): Record<string, CharacteristicId> {
    return { SENSOR_VALUES: { serviceUUID: SERVICE_B, characteristicUUID: CHAR_SENSOR } };
  }
  async begin(context: BeginContext): Promise<string> {
    await context.transport.startNotify('SENSOR_VALUES');
    return 'ok';
  }
  parse(uuid: string, data: DataView): SensorSample[] | null {
    if (uuid !== 'SENSOR_VALUES') return null;
    return [{ acc: { x: data.getUint8(0), y: 0, z: 0 } }];
  }
}

function makeHarness() {
  const bluetooth = new MockBluetooth();
  const device = new MockDevice('fake-1', 'FAKE-01');
  bluetooth.chooserQueue.push(device);
  const characteristic = device.gatt.getOrCreateService(SERVICE_B).getOrCreate(CHAR_SENSOR);
  const ble = new OrpheDevice({ profile: new FakeProfile(), bluetooth, storage: new MemoryStorage() });
  return { ble, device, characteristic };
}

test('fieldToGotName: 通常名は got + PascalCase、irregular はマップ', () => {
  assert.equal(fieldToGotName('acc'), 'gotAcc');
  assert.equal(fieldToGotName('converted_acc'), 'gotConvertedAcc');
  assert.equal(fieldToGotName('standing_phase_duration'), 'gotStandingPhaseDuration');
  assert.equal(fieldToGotName('steps_number'), 'gotStepsNumber');
  assert.equal(fieldToGotName('ble_frequency'), 'gotBLEFrequency');
  assert.equal(fieldToGotName('lost_data'), 'lostData');
});

test('gotAcc 代入でフィールド配送を受け取れる（emitter 経由）', () => {
  const { ble } = makeHarness();
  const target: Record<string, unknown> = {};
  attachLegacyCallbacks(ble, target);

  const received: unknown[] = [];
  target.gotAcc = (acc: unknown) => received.push(acc);

  ble.emitter.emit('SENSOR_VALUES', [{ acc: { x: 1, y: 2, z: 3 } }]);
  assert.deepEqual(received, [{ x: 1, y: 2, z: 3 }]);
});

test('this は target に束縛される', () => {
  const { ble } = makeHarness();
  const target: Record<string, unknown> = { id: 42 };
  attachLegacyCallbacks(ble, target);

  let seenId: unknown = null;
  target.gotGait = function (this: { id: number }) {
    seenId = this.id;
  };
  ble.emitter.emit('STEP_ANALYSIS', [{ gait: { steps: 1 } }]);
  assert.equal(seenId, 42);
});

test('再代入で古いコールバックは呼ばれなくなる', () => {
  const { ble } = makeHarness();
  const target: Record<string, unknown> = {};
  attachLegacyCallbacks(ble, target);

  const calls: string[] = [];
  target.gotAcc = () => calls.push('old');
  target.gotAcc = () => calls.push('new');
  ble.emitter.emit('SENSOR_VALUES', [{ acc: { x: 1, y: 0, z: 0 } }]);
  assert.deepEqual(calls, ['new']);
});

test('irregular 名: gotBLEFrequency は数値、lostData は (serial, prev) の2引数', () => {
  const { ble } = makeHarness();
  const target: Record<string, unknown> = {};
  attachLegacyCallbacks(ble, target);

  const freqs: unknown[] = [];
  const losses: Array<[unknown, unknown]> = [];
  target.gotBLEFrequency = (hz: unknown) => freqs.push(hz);
  target.lostData = (serial: unknown, prev: unknown) => losses.push([serial, prev]);

  ble.emitter.emit('SENSOR_VALUES', [{ ble_frequency: 98.5 }, { lost_data: { serial: 10, prev: 7 } }]);
  assert.deepEqual(freqs, [98.5]);
  assert.deepEqual(losses, [[10, 7]]);
});

test('対応する got* が未定義のフィールドは無視される（timestamp 等）', () => {
  const { ble } = makeHarness();
  const target: Record<string, unknown> = {};
  attachLegacyCallbacks(ble, target);
  // gotTimestamp を定義していない
  ble.emitter.emit('SENSOR_VALUES', [{ timestamp: 123, acc: { x: 1, y: 0, z: 0 } }]);
  assert.ok(true); // throw しないこと
});

test('gotData オーバーライドで生データが届き、got* は停止する', async () => {
  const { ble, characteristic } = makeHarness();
  const target: Record<string, unknown> = {};
  attachLegacyCallbacks(ble, target);
  await ble.begin();

  const raws: Array<{ uuid: string; byte0: number }> = [];
  const accs: unknown[] = [];
  const losses: unknown[] = [];
  target.gotAcc = (acc: unknown) => accs.push(acc);
  target.lostData = (serial: unknown) => losses.push(serial);
  target.gotData = function (data: DataView, uuid: string) {
    raws.push({ uuid, byte0: data.getUint8(0) });
  };

  characteristic.emit(new DataView(Uint8Array.from([7]).buffer));
  assert.deepEqual(raws, [{ uuid: 'SENSOR_VALUES', byte0: 7 }]);
  assert.deepEqual(accs, []); // gotData モード中は got* 停止

  // lostData は gotData モードでも届く
  ble.emitter.emit('SENSOR_VALUES', [{ lost_data: { serial: 5, prev: 3 } }]);
  assert.deepEqual(losses, [5]);

  // gotData を外すと got* が再開する
  delete target.gotData;
  characteristic.emit(new DataView(Uint8Array.from([9]).buffer));
  assert.deepEqual(accs, [{ x: 9, y: 0, z: 0 }]);
});

test('detach() で全配送が止まる', async () => {
  const { ble, characteristic } = makeHarness();
  const target: Record<string, unknown> = {};
  const detach = attachLegacyCallbacks(ble, target);
  await ble.begin();

  const accs: unknown[] = [];
  const raws: unknown[] = [];
  target.gotAcc = (acc: unknown) => accs.push(acc);
  target.gotData = (data: DataView) => raws.push(data);

  detach();
  characteristic.emit(new DataView(Uint8Array.from([1]).buffer));
  ble.emitter.emit('SENSOR_VALUES', [{ acc: { x: 1, y: 0, z: 0 } }]);
  assert.deepEqual(accs, []);
  assert.deepEqual(raws, []);
});

test('target 省略時は ble 自身に got* を生やす', () => {
  const { ble } = makeHarness();
  attachLegacyCallbacks(ble);
  const received: unknown[] = [];
  (ble as unknown as Record<string, unknown>).gotAcc = (acc: unknown) => received.push(acc);
  ble.emitter.emit('SENSOR_VALUES', [{ acc: { x: 5, y: 0, z: 0 } }]);
  assert.equal(received.length, 1);
});

test('コールバックの throw は他の配送を壊さない', () => {
  const errors: unknown[] = [];
  const bluetooth = new MockBluetooth();
  bluetooth.chooserQueue.push(new MockDevice('fake-1', 'FAKE-01'));
  const ble = new OrpheDevice({
    profile: new FakeProfile(),
    bluetooth,
    storage: new MemoryStorage(),
    events: { onError: (e) => errors.push(e) },
  });
  const target: Record<string, unknown> = {};
  attachLegacyCallbacks(ble, target);

  const gyros: unknown[] = [];
  target.gotAcc = () => {
    throw new Error('legacy boom');
  };
  target.gotGyro = (gyro: unknown) => gyros.push(gyro);
  ble.emitter.emit('SENSOR_VALUES', [{ acc: { x: 1, y: 0, z: 0 }, gyro: { x: 2, y: 0, z: 0 } }]);
  assert.equal(gyros.length, 1);
  assert.equal(errors.length, 1);
});
