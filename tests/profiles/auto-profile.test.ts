/**
 * AutoProfile: chooser で選ばれたデバイス名から CORE / INSOLE を判別して振る舞う。
 * - 'INS' で始まる名前は INSOLE、それ以外は CORE
 * - chooser は両デバイスを候補に出す
 * - begin() の type 省略時は判別後のプロファイルの既定 type を使う
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AutoProfile, autoProfile, detectDeviceKind } from '../../src/profiles/auto.ts';
import { OrpheCoreInsole } from '../../src/device/orphe-core-insole.ts';
import { ORPHE_UUID } from '../../src/protocol/uuids.ts';
import { MemoryStorage, MockBluetooth } from '../helpers/mock-bluetooth.ts';
import { mockCoreDevice } from '../helpers/core-device.ts';
import { mockInsoleDevice } from '../helpers/insole-device.ts';

function makeBle(bluetooth: MockBluetooth) {
  const profile = autoProfile({ core: { settleMs: 0, timeSyncSamples: 1 }, insole: { timeSyncSamples: 1 } });
  const ble = new OrpheCoreInsole({ profile, bluetooth, storage: new MemoryStorage(), wait: async () => {} });
  return { ble, profile };
}

test('detectDeviceKind: INS で始まる名前は insole、それ以外は core', () => {
  assert.equal(detectDeviceKind('INS-01'), 'insole');
  assert.equal(detectDeviceKind('CR-3'), 'core');
  assert.equal(detectDeviceKind('ORPHE-CORE'), 'core');
  assert.equal(detectDeviceKind(undefined), 'core');
});

test('requestDeviceOptions: CORE と INSOLE の両方が chooser に出る', () => {
  const options = autoProfile().requestDeviceOptions();
  assert.deepEqual(options.filters, [
    { namePrefix: 'INS' },
    { services: [ORPHE_UUID.INFORMATION_SERVICE] },
  ]);
  assert.deepEqual(options.optionalServices, [
    ORPHE_UUID.INFORMATION_SERVICE,
    ORPHE_UUID.OTHER_SERVICE,
    'device_information',
  ]);
  assert.deepEqual(options.optionalManufacturerData, [0x0000]);
});

test('requestDeviceOptions: core.namePrefix を足せる', () => {
  const options = autoProfile({ core: { namePrefix: 'CR-' } }).requestDeviceOptions();
  assert.deepEqual(options.filters?.map((f) => f.namePrefix ?? 'services'), ['INS', 'services', 'CR-']);
});

test('接続前は判別できず、kind は auto・parse は null・modes は空', () => {
  const profile = autoProfile();
  assert.equal(profile.kind, 'auto');
  assert.equal(profile.current, null);
  assert.equal(profile.parse('SENSOR_VALUES', new DataView(new ArrayBuffer(104))), null);
  assert.deepEqual(profile.modes(), []);
});

test('INSOLE を選ぶと insole として begin し、既定 type は SENSOR_VALUES', async () => {
  const bluetooth = new MockBluetooth();
  const { device, sensor } = mockInsoleDevice();
  bluetooth.chooserQueue.push(device);
  const { ble, profile } = makeBle(bluetooth);

  const result = await ble.begin();

  assert.equal(result, 'done begin(); SENSOR VALUES');
  assert.equal(profile.kind, 'insole');
  assert.equal(profile.current?.kind, 'insole');
  assert.equal(profile.streaming_mode, 4);
  assert.ok(sensor.notifying);
});

test('CORE を選ぶと core として begin し、既定 type は STEP_ANALYSIS', async () => {
  const bluetooth = new MockBluetooth();
  const { device, step } = mockCoreDevice();
  bluetooth.chooserQueue.push(device);
  const { ble, profile } = makeBle(bluetooth);

  const result = await ble.begin();

  assert.equal(result, 'done begin(); STEP ANALYSIS');
  assert.equal(profile.kind, 'core');
  assert.ok(step.notifying);
  assert.ok(profile.modes().some(mode => mode.id === 'STEP_ANALYSIS'));
});

test('判別後のプロファイルでパースして on() に届く（INSOLE の press）', async () => {
  const bluetooth = new MockBluetooth();
  const { device, sensor } = mockInsoleDevice();
  bluetooth.chooserQueue.push(device);
  const { ble } = makeBle(bluetooth);
  const pressValues: number[][] = [];
  ble.on('press', (press) => pressValues.push(press.values));

  await ble.begin('SENSOR_VALUES', { streamingMode: 4 });
  const dv = new DataView(new ArrayBuffer(104));
  dv.setUint8(0, 56);
  [100, 200, 300, 400, 500, 600].forEach((v, i) => dv.setUint16(60 + 2 * i, v));
  sensor.emit(dv);

  assert.deepEqual(pressValues[0], [100, 200, 300, 400, 500, 600]);
});

test('forceDeviceSelection で別種のデバイスに切り替えると判別し直す', async () => {
  const bluetooth = new MockBluetooth();
  bluetooth.chooserQueue.push(mockCoreDevice().device, mockInsoleDevice().device);
  const { ble, profile } = makeBle(bluetooth);

  await ble.begin();
  assert.equal(profile.kind, 'core');

  const result = await ble.begin(undefined, { forceDeviceSelection: true });
  assert.equal(profile.kind, 'insole');
  assert.equal(result, 'done begin(); SENSOR VALUES');
});

test('FifoRecorder と同じく streaming_mode を書き戻せる（INSOLE のときだけ反映）', async () => {
  const bluetooth = new MockBluetooth();
  bluetooth.chooserQueue.push(mockInsoleDevice().device);
  const { ble, profile } = makeBle(bluetooth);
  await ble.begin('SENSOR_VALUES', { streamingMode: 3 });

  profile.streaming_mode = 1;
  assert.equal(profile.insole.streaming_mode, 1);
  assert.equal(profile.streaming_mode, 1);
});

test('profile を省略すると autoProfile() で動く', async () => {
  const bluetooth = new MockBluetooth();
  bluetooth.chooserQueue.push(mockInsoleDevice().device);
  const ble = new OrpheCoreInsole({ bluetooth, storage: new MemoryStorage(), wait: async () => {} });
  assert.ok(ble.profile instanceof AutoProfile);
  assert.equal(ble.profile.kind, 'auto');

  await ble.begin();
  assert.equal(ble.profile.kind, 'insole');
});

test('readFirmwareInfo() の時点で判別し、availableModes が出る', async () => {
  const bluetooth = new MockBluetooth();
  bluetooth.chooserQueue.push(mockInsoleDevice().device);
  const { ble, profile } = makeBle(bluetooth);

  await ble.readFirmwareInfo();

  assert.equal(profile.kind, 'insole');
  assert.deepEqual(
    ble.availableModes.map(mode => mode.id),
    profile.insole.modes().map(mode => mode.id),
  );
});

test('readFirmwareInfo() の FW read が失敗しても判別は済む', async () => {
  const bluetooth = new MockBluetooth();
  const { device } = mockCoreDevice(); // GET_FW_NAME を持たない
  bluetooth.chooserQueue.push(device);
  const { ble, profile } = makeBle(bluetooth);

  assert.equal(await ble.readFirmwareInfo(), null);
  assert.equal(profile.kind, 'core');
  assert.ok(ble.availableModes.length > 0);
});
