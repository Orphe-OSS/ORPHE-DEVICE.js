/**
 * デバイス時計の同期（device/time-sync.ts）。syncCoreTime 相当で CORE / INSOLE 共通。
 * PC 時刻 + 平均往復時間/2 を DATE_TIME へ書き込む。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeDateTime, encodeDateTime } from '../../src/protocol/datetime.ts';
import { readDateTime, syncDeviceTime } from '../../src/device/time-sync.ts';
import { OrpheBleTransport } from '../../src/ble/transport.ts';
import { MemoryStorage, MockBluetooth, MockDevice } from '../helpers/mock-bluetooth.ts';

const SERVICE_A = '01a9d6b5-ff6e-444a-b266-0be75e85c064';
const CHAR_DATE_TIME = 'f53eeeb1-b2e8-492a-9673-10e0f1c29026';

function makeTransport() {
  const bluetooth = new MockBluetooth();
  const device = new MockDevice('id-1', 'CR-1');
  bluetooth.chooserQueue.push(device);
  const characteristic = device.gatt.getOrCreateService(SERVICE_A).getOrCreate(CHAR_DATE_TIME);
  const transport = new OrpheBleTransport({
    requestDeviceOptions: { filters: [{ services: [SERVICE_A] }] },
    storageKey: 'orphe_test_datetime',
    characteristics: {
      DATE_TIME: { serviceUUID: SERVICE_A, characteristicUUID: CHAR_DATE_TIME },
    },
    bluetooth,
    storage: new MemoryStorage(),
  });
  return { transport, characteristic };
}

test('readDateTime: デバイスの時刻と往復時間を返す', async () => {
  const { transport, characteristic } = makeTransport();
  characteristic.readValueData = new DataView(encodeDateTime(new Date(2026, 8, 4, 1, 2, 3, 40)).buffer);

  const result = await readDateTime(transport);
  assert.equal(result.date.getFullYear(), 2026);
  assert.equal(result.date.getMonth(), 8);
  assert.equal(result.date.getMilliseconds(), 40);
  assert.ok(result.round_trip_time >= 0);
  assert.ok(result.raw instanceof DataView);
});

test('syncDeviceTime: n回計測して平均RTT/2 を加えた時刻を書き込む', async () => {
  const { transport, characteristic } = makeTransport();
  characteristic.readValueData = new DataView(encodeDateTime(new Date(2026, 8, 4, 1, 2, 3, 40)).buffer);
  const fixedNow = new Date(2026, 8, 4, 10, 0, 0, 0);

  // clock を注入して RTT を決定的にする: read ごとに 10ms 経過
  let tick = 0;
  const result = await syncDeviceTime(transport, {
    samples: 3,
    now: () => fixedNow,
    clock: () => (tick += 5),
  });

  assert.equal(characteristic.readCalls, 3);
  assert.equal(result.round_trip_times.length, 3);
  assert.deepEqual(result.round_trip_times, [5, 5, 5]); // 各計測 start→end で +5
  assert.equal(result.average_round_trip_time, 5);
  assert.equal(result.half_round_trip_time, 3); // round(5/2)
  assert.equal(result.standard_time, fixedNow.getTime());
  assert.equal(result.adjusted_time, fixedNow.getTime() + 3);

  // 書き込まれたのは adjusted_time の7バイト表現
  assert.equal(characteristic.written.length, 1);
  const written = characteristic.written[0]!;
  assert.equal(written.length, 7);
  const writtenDate = decodeDateTime(new DataView(written.buffer, written.byteOffset, written.byteLength));
  assert.equal(writtenDate.getTime(), Math.floor((fixedNow.getTime() + 3) / 10) * 10); // 10ms精度
});
