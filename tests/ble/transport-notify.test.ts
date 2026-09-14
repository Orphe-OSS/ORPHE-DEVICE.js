/**
 * OrpheBleTransport: notify ライフサイクル。
 * 世代トークンで start/stop の競合を解決する。
 * - start/stop の交錯・切断を跨いだ完了順逆転で handler と実状態が食い違わない
 * - データは onNotification(uuid, DataView) へ届く
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OrpheBleTransport } from '../../src/ble/transport.ts';
import type { TransportConfig, TransportEvents } from '../../src/ble/types.ts';
import {
  MemoryStorage,
  MockBluetooth,
  MockDevice,
  deferred,
  flushMicrotasks,
} from '../helpers/mock-bluetooth.ts';

const SERVICE_B = 'db1b7aca-cda5-4453-a49b-33a53d3f0833';
const CHAR_SENSOR = 'f3f9c7ce-46ee-4205-89ac-abe64e626c0f';

function makeHarness(overrides: Partial<TransportConfig> = {}) {
  const bluetooth = new MockBluetooth();
  const notifications: Array<{ uuid: string; value: DataView }> = [];
  const starts: string[] = [];
  const stops: string[] = [];
  const errors: unknown[] = [];
  const events: TransportEvents = {
    onNotification: (uuid, value) => notifications.push({ uuid, value }),
    onStartNotify: (uuid) => starts.push(uuid),
    onStopNotify: (uuid) => stops.push(uuid),
    onError: (e) => errors.push(e),
  };
  const transport = new OrpheBleTransport({
    requestDeviceOptions: { filters: [{ namePrefix: 'INS' }] },
    storageKey: 'orphe_test_notify',
    characteristics: {
      SENSOR_VALUES: { serviceUUID: SERVICE_B, characteristicUUID: CHAR_SENSOR },
    },
    bluetooth,
    storage: new MemoryStorage(),
    events,
    ...overrides,
  });
  const device = new MockDevice('ins-1', 'INS-01');
  bluetooth.chooserQueue.push(device);
  const characteristic = device.gatt.getOrCreateService(SERVICE_B).getOrCreate(CHAR_SENSOR);
  return { transport, bluetooth, device, characteristic, notifications, starts, stops, errors, events };
}

function dataView(...bytes: number[]): DataView {
  return new DataView(new Uint8Array(bytes).buffer);
}

test('startNotify: 購読開始しデータが onNotification に届く', async () => {
  const h = makeHarness();
  await h.transport.startNotify('SENSOR_VALUES');

  assert.equal(h.characteristic.notifying, true);
  assert.deepEqual(h.starts, ['SENSOR_VALUES']);

  h.characteristic.emit(dataView(9, 8, 7));
  assert.equal(h.notifications.length, 1);
  assert.equal(h.notifications[0]!.uuid, 'SENSOR_VALUES');
  assert.equal(h.notifications[0]!.value.getUint8(0), 9);
});

test('stopNotify: 購読停止し handler が解除される', async () => {
  const h = makeHarness();
  await h.transport.startNotify('SENSOR_VALUES');
  await h.transport.stopNotify('SENSOR_VALUES');

  assert.equal(h.characteristic.notifying, false);
  assert.deepEqual(h.stops, ['SENSOR_VALUES']);

  h.characteristic.emit(dataView(1));
  assert.equal(h.notifications.length, 0);
  assert.equal(h.characteristic.listeners.size, 0);
});

test('start → stop → start の再購読で handler が二重化しない', async () => {
  const h = makeHarness();
  await h.transport.startNotify('SENSOR_VALUES');
  await h.transport.stopNotify('SENSOR_VALUES');
  await h.transport.startNotify('SENSOR_VALUES');

  h.characteristic.emit(dataView(5));
  assert.equal(h.notifications.length, 1);
  assert.equal(h.characteristic.listeners.size, 1);
});

test('二重 startNotify でも handler は1つだけ', async () => {
  const h = makeHarness();
  await h.transport.startNotify('SENSOR_VALUES');
  await h.transport.startNotify('SENSOR_VALUES');

  h.characteristic.emit(dataView(5));
  assert.equal(h.notifications.length, 1);
  assert.equal(h.characteristic.listeners.size, 1);
});

test('startNotifications 待機中に stopNotify が来たら最終状態は停止・handler なし', async () => {
  const h = makeHarness();
  const gate = deferred();
  h.characteristic.startGate = gate.promise;

  const startPromise = h.transport.startNotify('SENSOR_VALUES');
  await flushMicrotasks(30); // start が startNotifications の途中まで進むのを待つ
  assert.equal(h.characteristic.startCalls, 1);

  const stopPromise = h.transport.stopNotify('SENSOR_VALUES');
  gate.resolve();
  await startPromise;
  await stopPromise;

  assert.equal(h.characteristic.notifying, false);
  assert.equal(h.characteristic.listeners.size, 0);
  assert.deepEqual(h.starts, []); // 古い start の onStartNotify は発火しない
  assert.deepEqual(h.stops, ['SENSOR_VALUES']);

  h.characteristic.emit(dataView(1));
  assert.equal(h.notifications.length, 0);
});

test('startNotifications 待機中の切断で古い start は handler を登録しない', async () => {
  const h = makeHarness();
  const gate = deferred();
  h.characteristic.startGate = gate.promise;

  const startPromise = h.transport.startNotify('SENSOR_VALUES');
  await flushMicrotasks(30);
  assert.equal(h.characteristic.startCalls, 1);

  h.device.gatt.simulateLinkLoss();
  gate.resolve();
  await startPromise;

  assert.equal(h.characteristic.listeners.size, 0);
  assert.deepEqual(h.starts, []);
});

test('切断で handler は即時解除され、再 startNotify でデータが再開する', async () => {
  const h = makeHarness();
  await h.transport.startNotify('SENSOR_VALUES');
  h.device.gatt.simulateLinkLoss();

  assert.equal(h.characteristic.listeners.size, 0); // invalidate で解除済み

  await h.transport.startNotify('SENSOR_VALUES');
  assert.equal(h.characteristic.listeners.size, 1);
  h.characteristic.emit(dataView(3));
  assert.equal(h.notifications.length, 1);
});

test('startNotifications の失敗は reject し onError に報告される', async () => {
  const h = makeHarness();
  h.characteristic.failNextStart = new Error('start boom');

  await assert.rejects(h.transport.startNotify('SENSOR_VALUES'), /start boom/);
  assert.ok(h.errors.length >= 1);
  assert.equal(h.characteristic.listeners.size, 0);
});

test('stopNotifications の失敗は reject し onError に報告される', async () => {
  const h = makeHarness();
  await h.transport.startNotify('SENSOR_VALUES');
  h.characteristic.failNextStop = new Error('stop boom');

  await assert.rejects(h.transport.stopNotify('SENSOR_VALUES'), /stop boom/);
  assert.ok(h.errors.length >= 1);
});

test('onNotification コールバックの throw は他の通知配送を壊さない', async () => {
  const h = makeHarness();
  let calls = 0;
  h.events.onNotification = () => {
    calls++;
    throw new Error('handler boom');
  };
  await h.transport.startNotify('SENSOR_VALUES');

  h.characteristic.emit(dataView(1));
  h.characteristic.emit(dataView(2));
  assert.equal(calls, 2);
  assert.equal(h.errors.length, 2); // onError へ報告される
});

test('clear() は notify handler を解除する', async () => {
  const h = makeHarness();
  await h.transport.startNotify('SENSOR_VALUES');
  h.transport.clear();

  h.characteristic.emit(dataView(1));
  assert.equal(h.notifications.length, 0);
  assert.equal(h.characteristic.listeners.size, 0);
});
