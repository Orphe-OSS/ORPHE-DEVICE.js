/**
 * BLE 実測周波数（gotBLEFrequency 相当）の facade 統合。
 * 仕様:
 *   - notify ごとに前回からの経過時間を計測し 1000/t [Hz]
 *   - t <= 15ms は -1（配送しない）
 *   - 'ble_frequency' フィールドとして、同じ notify のセンサーデータより先に配送
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OrpheDevice } from '../../src/device/orphe-device.ts';
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
    return `orphe_freq_test_${id}`;
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

async function makeHarness(clock: () => number) {
  const bluetooth = new MockBluetooth();
  const device = new MockDevice('fake-1', 'FAKE-01');
  bluetooth.chooserQueue.push(device);
  const characteristic = device.gatt.getOrCreateService(SERVICE_B).getOrCreate(CHAR_SENSOR);
  const ble = new OrpheDevice({ profile: new FakeProfile(), bluetooth, storage: new MemoryStorage(), clock });
  await ble.begin();
  return { ble, characteristic };
}

function emit(characteristic: { emit(v: DataView): void }, byte: number): void {
  characteristic.emit(new DataView(Uint8Array.from([byte]).buffer));
}

test('notify 間隔から Hz を計測し ble_frequency として配送する', async () => {
  let now = 1000;
  const { ble, characteristic } = await makeHarness(() => now);
  const freqs: number[] = [];
  ble.on('ble_frequency', (hz) => freqs.push(hz as number));

  emit(characteristic, 1); // 初回: 経過 1000ms → 1Hz（初回も配送される）
  now = 1010;
  emit(characteristic, 2); // 10ms ≤ 15ms → -1 → 配送なし
  now = 1030;
  emit(characteristic, 3); // 20ms → 50Hz

  assert.deepEqual(freqs, [1, 50]);
});

test('ble_frequency は同じ notify のセンサーデータより先に届く', async () => {
  let now = 1000;
  const { ble, characteristic } = await makeHarness(() => now);
  const order: string[] = [];
  ble.on('ble_frequency', () => order.push('freq'));
  ble.on('acc', () => order.push('acc'));

  now = 2000;
  emit(characteristic, 1);
  assert.deepEqual(order.slice(0, 2), ['freq', 'acc']);
});
