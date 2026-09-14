/**
 * OrpheInsole（互換 API）: `new OrpheInsole(0)` + got* 代入スタイルが
 * OrpheDevice + insoleProfile の上で同じように動くこと。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OrpheInsole } from '../../src/compat/orphe-insole.ts';
import { MemoryStorage, MockBluetooth, waitFor } from '../helpers/mock-bluetooth.ts';
import { mockInsoleDevice } from '../helpers/insole-device.ts';

function makeInsole(id = 0, storage = new MemoryStorage()) {
  const bluetooth = new MockBluetooth();
  const insole = new OrpheInsole(id, { bluetooth, storage, wait: async () => {} });
  const errors: unknown[] = [];
  insole.onError = (error) => { errors.push(error); };
  return { insole, bluetooth, storage, errors };
}

function sensorPacket(header = 56, serialNumber = 1): DataView {
  const data = new DataView(new ArrayBuffer(104));
  data.setUint8(0, header);
  data.setUint16(1, serialNumber);
  return data;
}

test('begin(): 選択 → DeviceInfo → モード書込 → 時刻同期 → notify 開始、成功したデバイスを記憶する', async () => {
  const { insole, bluetooth, storage, errors } = makeInsole();
  const { device, deviceInfo, dateTime, sensor } = mockInsoleDevice();
  bluetooth.chooserQueue.push(device);
  const states: string[] = [];
  insole.onScan = () => { states.push(insole.connectionState); };

  const result = await insole.begin('SENSOR_VALUES', { streamingMode: 3 });

  assert.equal(result, 'done begin(); SENSOR VALUES');
  assert.deepEqual(states, ['connecting']);
  assert.equal(insole.connectionState, 'connected');
  assert.equal(insole.bluetoothDevice, device);
  assert.equal(insole.isConnected(), true);
  assert.notEqual(insole.device_information, '');
  assert.equal((insole.device_information as { battery: number }).battery, 2);
  assert.equal(insole.streaming_mode, 3);
  assert.deepEqual([...deviceInfo.written[0]!], [0x0d, 3]);
  assert.equal(dateTime.readCalls, 3);
  assert.equal(dateTime.written.length, 1);
  assert.equal(sensor.notifying, true);
  assert.equal(JSON.parse(storage.getItem('orphe_insole_last_bluetooth_device_0')!).bluetoothId, device.id);
  assert.deepEqual(errors, []);
});

test('notify は got* コールバックへ届き、最新値プロパティも更新される', async () => {
  const { insole, bluetooth } = makeInsole();
  const { device, sensor } = mockInsoleDevice();
  bluetooth.chooserQueue.push(device);
  await insole.begin('SENSOR_VALUES', {});

  const order: string[] = [];
  const presses: number[][] = [];
  insole.gotPress = function (press) { presses.push(press.values); order.push('press'); };
  insole.gotQuat = function () { order.push('quat'); };
  insole.gotEuler = function () { order.push('euler'); };
  insole.gotAcc = function () { order.push('acc'); };
  insole.gotGyro = function () { order.push('gyro'); };
  insole.gotConvertedAcc = function () { order.push('cacc'); };
  insole.gotConvertedGyro = function () { order.push('cgyro'); };
  let thisId: number | null = null;
  insole.gotBLEFrequency = function () { thisId = this.id; };

  sensor.emit(sensorPacket(56, 10));

  assert.equal(presses.length, 2, 'header 56 は 2 サンプル');
  assert.deepEqual(order.slice(0, 7), ['quat', 'euler', 'acc', 'gyro', 'cacc', 'cgyro', 'press']);
  assert.equal(insole.serial_number, 10);
  assert.equal(insole.press.values.length, 6);
  assert.equal(thisId, 0, 'コールバックの this はインスタンス');
});

test('lostData(serial, prev) は serial の欠損で呼ばれ、gotData 上書き中も届く', async () => {
  const { insole, bluetooth } = makeInsole();
  const { device, sensor } = mockInsoleDevice();
  bluetooth.chooserQueue.push(device);
  await insole.begin('SENSOR_VALUES', {});

  const losses: number[][] = [];
  insole.lostData = function (current, prev) { losses.push([current, prev]); };
  sensor.emit(sensorPacket(56, 10));
  sensor.emit(sensorPacket(56, 12));
  assert.deepEqual(losses, [[12, 10]]);

  const raws: number[] = [];
  const presses: number[] = [];
  insole.gotData = function (data) { raws.push(data.byteLength); };
  insole.gotPress = function () { presses.push(1); };
  sensor.emit(sensorPacket(56, 14));
  assert.deepEqual(raws, [104]);
  assert.equal(presses.length, 0, 'gotData 上書き中は got* が止まる');
  assert.deepEqual(losses, [[12, 10], [14, 12]]);
});

test('addSensorDataListener はデコード済みパケットを届け、解除できる', async () => {
  const { insole, bluetooth } = makeInsole();
  const { device, sensor } = mockInsoleDevice();
  bluetooth.chooserQueue.push(device);
  await insole.begin('SENSOR_VALUES', {});

  const events: Array<{ deviceId: number; header: number; samples: number }> = [];
  const off = insole.addSensorDataListener((event) => {
    events.push({ deviceId: event.deviceId, header: event.packet.header, samples: event.packet.samples.length });
  });
  sensor.emit(sensorPacket(56, 1));
  assert.deepEqual(events, [{ deviceId: 0, header: 56, samples: 2 }]);
  off();
  sensor.emit(sensorPacket(56, 2));
  assert.equal(events.length, 1);
  assert.throws(() => insole.addSensorDataListener('x' as unknown as () => void), TypeError);
});

test('begin() は chooser キャンセルで reject し、onError にも報告する', async () => {
  const { insole, errors } = makeInsole();
  await assert.rejects(() => insole.begin('SENSOR_VALUES', {}), /cancelled/);
  assert.equal(insole.connectionState, 'disconnected');
  assert.ok(errors.length >= 1);
});

test('begin() のオプション: object だけ渡せる / RAW と未対応種別は SENSOR_VALUES に寄せる', async () => {
  const { insole, bluetooth } = makeInsole();
  const { device } = mockInsoleDevice();
  bluetooth.chooserQueue.push(device);
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (message: string) => { warnings.push(message); };
  try {
    await insole.begin({ streamingMode: 1 });
    assert.equal(insole.streaming_mode, 1);
    await insole.begin('STEP_ANALYSIS', {});
    assert.equal(insole.notification_type, 'SENSOR_VALUES');
    assert.match(warnings[0]!, /not supported on ORPHE INSOLE/);
  } finally {
    console.warn = originalWarn;
  }
});

test('setDataStreamingMode: 1/3/4 以外は INVALID_MODE で reject する', async () => {
  const { insole, bluetooth } = makeInsole();
  const { device, deviceInfo } = mockInsoleDevice();
  bluetooth.chooserQueue.push(device);
  await insole.begin('SENSOR_VALUES', {});
  await insole.setDataStreamingMode(3);
  assert.deepEqual([...deviceInfo.written.at(-1)!], [0x0d, 3]);
  assert.equal(insole.streaming_mode, 3);
  await assert.rejects(() => insole.setDataStreamingMode(2), (error: { code?: string }) => error.code === 'INVALID_MODE');
});

test('記憶デバイスは chooser なしで復元し、forceDeviceSelection は chooser を出す', async () => {
  const first = makeInsole();
  const { device } = mockInsoleDevice();
  first.bluetooth.chooserQueue.push(device);
  await first.insole.begin('SENSOR_VALUES', {});
  first.insole.stop();

  const restored = makeInsole(0, first.storage);
  restored.bluetooth.knownDevices!.push(device);
  await restored.insole.begin('SENSOR_VALUES', {});
  assert.equal(restored.bluetooth.requestDeviceCalls.length, 0);
  assert.equal(restored.insole.bluetoothDevice, device);
  restored.insole.stop();

  const forced = makeInsole(0, first.storage);
  forced.bluetooth.knownDevices!.push(device);
  const { device: other } = mockInsoleDevice();
  forced.bluetooth.chooserQueue.push(other);
  await forced.insole.begin('SENSOR_VALUES', { forceDeviceSelection: true, autoReconnect: true });
  assert.equal(forced.bluetooth.requestDeviceCalls.length, 1);
  assert.equal(forced.insole.bluetoothDevice, other);
});

test('selectBluetoothDevice() は旧デバイスを切断し、記憶を消して chooser で選び直す', async () => {
  const { insole, bluetooth, storage } = makeInsole();
  const { device } = mockInsoleDevice();
  const { device: next, sensor: nextSensor } = mockInsoleDevice();
  bluetooth.chooserQueue.push(device, next);
  await insole.begin('SENSOR_VALUES', {});
  await insole.selectBluetoothDevice();
  assert.equal(device.gatt.connected, false);
  assert.equal(insole.bluetoothDevice, next);
  assert.equal(storage.getItem('orphe_insole_last_bluetooth_device_0'), null);
  await insole.begin('SENSOR_VALUES', {});
  assert.equal(nextSensor.notifying, true);
});

test('自動再接続: 切断後に同じ手順で再接続し、内部フック → onReconnectSuccess の順で呼ぶ', async () => {
  const { insole, bluetooth, errors } = makeInsole();
  const { device, deviceInfo, sensor } = mockInsoleDevice();
  bluetooth.chooserQueue.push(device);
  bluetooth.knownDevices!.push(device);
  const order: string[] = [];
  insole.onDisconnect = () => { order.push('disconnect'); };
  insole.addAfterReconnectSuccessHook(() => { order.push('hook'); });
  insole.onReconnectAttempt = () => { order.push('attempt'); throw new Error('attempt failed'); };
  insole.onReconnectSuccess = () => { order.push('success'); };
  await insole.begin('SENSOR_VALUES', { streamingMode: 4, autoReconnect: true, reconnectIntervalMs: 0, reconnectMaxAttempts: 3 });

  device.gatt.simulateLinkLoss();
  await waitFor(() => order.includes('success'), 'reconnect success');

  assert.deepEqual(order, ['disconnect', 'attempt', 'hook', 'success']);
  assert.equal(insole.connectionState, 'connected');
  assert.deepEqual(deviceInfo.written.map(bytes => [...bytes]), [[0x0d, 4], [0x0d, 4]]);
  assert.deepEqual(errors.map(e => (e as Error).message), ['attempt failed']);

  const presses: number[] = [];
  insole.gotPress = function () { presses.push(1); };
  sensor.emit(sensorPacket(56, 1));
  assert.equal(presses.length, 2, '再接続後の notify が届く');

  insole.stop();
  assert.equal(insole.connectionState, 'disconnected');
});

test('自動再接続の失敗は最終結果だけを onError に報告する', async () => {
  const { insole, bluetooth, errors } = makeInsole();
  const { device } = mockInsoleDevice();
  bluetooth.chooserQueue.push(device);
  bluetooth.knownDevices!.push(device);
  const attempts: number[] = [];
  let failed: { maxAttempts: number } | null = null;
  insole.onReconnectAttempt = (info) => { attempts.push(info.attempt); };
  insole.onReconnectFailed = (info) => { failed = info; };
  await insole.begin('SENSOR_VALUES', { autoReconnect: true, reconnectIntervalMs: 0, reconnectMaxAttempts: 2 });

  const originalConnect = device.gatt.connect.bind(device.gatt);
  device.gatt.connect = async () => { throw new Error('connection failed'); };
  device.gatt.simulateLinkLoss();
  await waitFor(() => failed !== null, 'reconnect failure');
  device.gatt.connect = originalConnect;

  assert.deepEqual(attempts, [1, 2]);
  assert.equal(failed!.maxAttempts, 2);
  assert.equal(errors.length, 1);
  assert.equal(insole.connectionState, 'disconnected');
});

test('エラー code: NO_DEVICE / ALREADY_DISCONNECTED / CONNECT_TIMEOUT', async () => {
  const { insole, bluetooth, errors } = makeInsole();
  await assert.rejects(() => insole.connectGATT('DEVICE_INFORMATION'), (error: { code?: string; message: string }) => {
    assert.equal(error.code, 'NO_DEVICE');
    assert.equal(error.message, 'No Bluetooth Device');
    return true;
  });

  const { device } = mockInsoleDevice();
  bluetooth.chooserQueue.push(device);
  await insole.begin('SENSOR_VALUES', {});
  device.gatt.simulateLinkLoss();
  errors.length = 0;
  insole.disconnect();
  assert.equal((errors[0] as { code: string }).code, 'ALREADY_DISCONNECTED');

  const slow = makeInsole(1);
  const { device: hanging } = mockInsoleDevice();
  hanging.gatt.connectGate = new Promise(() => {});
  slow.bluetooth.chooserQueue.push(hanging);
  await assert.rejects(
    () => slow.insole.read('DEVICE_INFORMATION', { connectTimeoutMs: 20 }),
    (error: { code?: string }) => error.code === 'CONNECT_TIMEOUT'
  );
});

test('別スロットに割り当て済みのデバイスは選べない', async () => {
  const left = makeInsole(0);
  const { device } = mockInsoleDevice('INS-L');
  left.bluetooth.chooserQueue.push(device);
  await left.insole.begin('SENSOR_VALUES', {});

  const right = makeInsole(1);
  right.bluetooth.chooserQueue.push(device);
  await assert.rejects(() => right.insole.begin('SENSOR_VALUES', {}), /already assigned to ORPHE INSOLE 01/);
  assert.equal(right.insole.bluetoothDevice, null);

  right.insole.rejectDuplicateDevices = false;
  right.bluetooth.chooserQueue.push(device);
  await right.insole.begin('SENSOR_VALUES', {});
  assert.equal(right.insole.bluetoothDevice, device, 'rejectDuplicateDevices = false なら同じデバイスも選べる');
  right.insole.stop();
  left.insole.stop();
});

test('getLastBluetoothDeviceInfo(): 接続に成功したデバイスの記憶を返し、forget で null になる', async () => {
  const { insole, bluetooth } = makeInsole();
  assert.equal(insole.getLastBluetoothDeviceInfo(), null);
  const { device } = mockInsoleDevice('INS-MEM');
  bluetooth.chooserQueue.push(device);
  await insole.begin('SENSOR_VALUES', {});
  assert.equal(insole.getLastBluetoothDeviceInfo()?.bluetoothId, device.id);
  assert.equal(insole.getLastBluetoothDeviceInfo()?.bluetoothName, device.name);
  insole.forgetLastBluetoothDevice();
  assert.equal(insole.getLastBluetoothDeviceInfo(), null);
  insole.stop();
});

test('clear() / reset() / getDeviceInformation() / resetAnalysisLogs()', async () => {
  const { insole, bluetooth } = makeInsole();
  const { device, deviceInfo, sensor } = mockInsoleDevice();
  bluetooth.chooserQueue.push(device);
  await insole.begin('SENSOR_VALUES', {});

  const info = await insole.getDeviceInformation();
  assert.equal(info.mount_position, 1);
  await insole.resetAnalysisLogs();
  assert.deepEqual([...deviceInfo.written.at(-1)!], [0x04]);

  let cleared = 0;
  insole.onClear = () => { cleared++; };
  const presses: number[] = [];
  insole.gotPress = function () { presses.push(1); };
  insole.clear();
  assert.equal(cleared, 1);
  assert.equal(insole.bluetoothDevice, null);
  sensor.emit(sensorPacket(56, 1));
  assert.equal(presses.length, 0, 'clear() 後の notify は配送しない');
});

test('静的 API: parseSensorValues / getStreamingModeInfo / STREAMING_MODES', () => {
  const parsed = OrpheInsole.parseSensorValues(sensorPacket(56, 7));
  assert.equal(parsed!.header, 56);
  assert.equal(OrpheInsole.getStreamingModeInfo(4)!.fields.press, true);
  assert.equal(OrpheInsole.getStreamingModeInfo(2), null);
  assert.equal(OrpheInsole.STREAMING_MODES[1]!.fields.press, false);
});

test('既定のライフサイクルコールバックは debug=false で沈黙し、debug=true で console.log に出す', () => {
  const { insole } = makeInsole();
  const logs: unknown[][] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => { logs.push(args); };
  try {
    insole.onScan('x');
    insole.onConnect('SENSOR_VALUES');
    insole.onDisconnect();
    assert.equal(logs.length, 0);
    insole.debug = true;
    insole.onScan('x');
    insole.onStartNotify('SENSOR_VALUES');
    assert.deepEqual(logs, [['onScan'], ['onStartNotify', 'SENSOR_VALUES']]);
  } finally {
    console.log = originalLog;
  }
});
