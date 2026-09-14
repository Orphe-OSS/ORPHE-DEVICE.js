/**
 * InsoleProfile: ORPHE INSOLE の DeviceProfile 実装。
 * - parseInsoleSensorValues（header 50/55/54/56、gyro レンジ別感度）
 * - begin シーケンス: DeviceInfo取得 → setDataStreamingMode → 時刻同期 → notify開始
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  decodeInsoleDeviceInformation,
  insoleProfile,
  parseInsoleSensorValues,
  insoleRequestDeviceOptions,
} from '../../src/profiles/insole.ts';
import { INSOLE_STREAMING_MODES } from '../../src/modes/insole.ts';
import { OrpheDevice } from '../../src/device/orphe-device.ts';
import { OrpheBleTransport } from '../../src/ble/transport.ts';
import { encodeDateTime } from '../../src/protocol/datetime.ts';
import { ORPHE_UUID } from '../../src/protocol/uuids.ts';
import type { TransportError } from '../../src/ble/errors.ts';
import { MemoryStorage, MockBluetooth, MockDevice } from '../helpers/mock-bluetooth.ts';

// ─── パケットフィクスチャ ────────────────────────────────────────

function packet104(header: number, serial = 0x0102): DataView {
  const dv = new DataView(new ArrayBuffer(104));
  dv.setUint8(0, header);
  dv.setUint16(1, serial);
  dv.setUint8(3, 12); // hh
  dv.setUint8(4, 34); // mm
  dv.setUint8(5, 56); // ss
  dv.setUint16(6, 789); // ms
  return dv;
}

test('parse: DataView 以外は TypeError', () => {
  assert.throws(() => parseInsoleSensorValues(null as unknown as DataView), TypeError);
});

test('parse: 104 バイト以外は null', () => {
  assert.equal(parseInsoleSensorValues(new DataView(new ArrayBuffer(20))), null);
});

test('parse: 未知ヘッダは空サンプルでヘッダ情報のみ返す', () => {
  const packet = parseInsoleSensorValues(packet104(99));
  assert.ok(packet);
  assert.equal(packet.header, 99);
  assert.equal(packet.serial_number, 0x0102);
  assert.deepEqual(packet.samples, []);
});

test('parse header 50 (mode 1): quat/gyro/acc × 4サンプル、タイムスタンプはデルタ加算', () => {
  const dv = packet104(50);
  // packet_number 0 は i=3 のフレーム（オフセット 8 + 21*3 = 71）
  dv.setInt16(71, 16384);  // quat.w = 1.0 (Q14)
  dv.setInt16(79, 16384);  // gyro.x raw → 正規化 0.5
  dv.setInt16(85, -16384); // acc.x raw → 正規化 -0.5
  // デルタ時間: pn1 ← u8(28+21*2)=u8(70), pn2 ← u8(49), pn3 ← u8(28)
  dv.setUint8(70, 5);
  dv.setUint8(49, 7);
  dv.setUint8(28, 9);

  const packet = parseInsoleSensorValues(dv)!;
  assert.equal(packet.samples.length, 4);
  const [s0, s1, s2, s3] = packet.samples as Array<Record<string, any>>;

  assert.equal(s0!.packet_number, 0);
  assert.equal(s0!.quat.w, 1.0);
  assert.equal(s0!.gyro.x, 0.5);
  assert.equal(s0!.acc.x, -0.5);
  assert.equal(s0!.press, undefined); // mode 1 に圧力なし

  // 既定レンジ: gyro ±2000dps → 感度 0.07 dps/LSB、acc ±16G
  assert.ok(Math.abs(s0!.converted_gyro.x - 16384 * 0.07) < 1e-9);
  assert.equal(s0!.converted_acc.x, -8);

  // タイムスタンプのデルタ加算
  assert.equal(s1!.timestamp - s0!.timestamp, 5);
  assert.equal(s2!.timestamp - s1!.timestamp, 7);
  assert.equal(s3!.timestamp - s2!.timestamp, 9);
  assert.equal(s0!.serial_number, 0x0102);
});

test('parse header 56 (mode 4): quat/gyro/acc/press × 2サンプル', () => {
  const dv = packet104(56);
  // packet_number 0 は i=1 のフレーム（オフセット +32）
  dv.setInt16(40, 8192); // quat.w = 0.5
  dv.setInt16(48, 3277); // gyro.x
  dv.setInt16(54, 16384); // acc.x = 0.5
  const press = [100, 200, 300, 400, 500, 600];
  press.forEach((v, i) => dv.setUint16(60 + 2 * i, v));

  const packet = parseInsoleSensorValues(dv)!;
  assert.equal(packet.samples.length, 2);
  const s0 = packet.samples[0] as Record<string, any>;
  assert.equal(s0.packet_number, 0);
  assert.equal(s0.quat.w, 0.5);
  assert.deepEqual(s0.press.values, press);
  assert.equal(s0.converted_acc.x, 8); // 0.5 × 16G
});

test('parse header 55/54 (mode 3 / FIFO): quat なし・press あり × 4サンプル', () => {
  for (const header of [55, 54]) {
    const dv = packet104(header);
    // packet_number 0 は i=3 のフレーム（オフセット +72）
    dv.setInt16(80, 16384); // gyro.x
    dv.setInt16(86, 16384); // acc.x
    const press = [1000, 1100, 1200, 1300, 1400, 1500];
    press.forEach((v, i) => dv.setUint16(92 + 2 * i, v));

    const packet = parseInsoleSensorValues(dv)!;
    assert.equal(packet.samples.length, 4, `header ${header}`);
    const s0 = packet.samples[0] as Record<string, any>;
    assert.equal(s0.quat, undefined);
    assert.deepEqual(s0.press.values, press);
    assert.equal(s0.gyro.x, 0.5);
  }
});

test('parse: レンジ指定で換算値が変わる（gyro はレンジ別感度）', () => {
  const dv = packet104(50);
  dv.setInt16(79, 16384); // gyro.x raw
  dv.setInt16(85, -16384); // acc.x → -0.5

  const packet = parseInsoleSensorValues(dv, { accRange: 2, gyroRange: 250 })!;
  const s0 = packet.samples[0] as Record<string, any>;
  // ±250dps → 感度 0.00875 dps/LSB
  assert.ok(Math.abs(s0.converted_gyro.x - 16384 * 0.00875) < 1e-9);
  assert.equal(s0.converted_acc.x, -1); // -0.5 × 2G
});

test('INSOLE_STREAMING_MODES: 1/3/4 の仕様表', () => {
  assert.equal(INSOLE_STREAMING_MODES[1]!.fields.press, false);
  assert.equal(INSOLE_STREAMING_MODES[3]!.fields.quat, false);
  assert.equal(INSOLE_STREAMING_MODES[4]!.sampleHz, 100);
});

test('decodeInsoleDeviceInformation: battery/mount_position/range', () => {
  const bytes = new Uint8Array(20);
  bytes[0] = 2; // battery
  bytes[1] = 1; // mount_position (right)
  bytes[8] = 3; // acc range index (±16G)
  bytes[9] = 0; // gyro range index (±250dps)
  const info = decodeInsoleDeviceInformation(new DataView(bytes.buffer));
  assert.equal(info.battery, 2);
  assert.equal(info.mount_position, 1);
  assert.deepEqual({ acc: info.range.acc, gyro: info.range.gyro }, { acc: 3, gyro: 0 });
});

// ─── begin シーケンス ────────────────────────────────────────────

function makeInsoleHarness(deviceInfo: { accIdx?: number; gyroIdx?: number } = {}) {
  const profile = insoleProfile();
  const bluetooth = new MockBluetooth();
  const device = new MockDevice('ins-1', 'INS-01');
  bluetooth.chooserQueue.push(device);
  const transport = new OrpheBleTransport({
    requestDeviceOptions: profile.requestDeviceOptions(),
    storageKey: profile.storageKey(0),
    characteristics: profile.characteristics(),
    bluetooth,
    storage: new MemoryStorage(),
  });

  const infoService = device.gatt.getOrCreateService(ORPHE_UUID.INFORMATION_SERVICE);
  const info = infoService.getOrCreate(ORPHE_UUID.DEVICE_INFORMATION);
  const dateTime = infoService.getOrCreate(ORPHE_UUID.DATE_TIME);
  const sensor = device.gatt.getOrCreateService(ORPHE_UUID.OTHER_SERVICE).getOrCreate(ORPHE_UUID.SENSOR_VALUES);

  const infoBytes = new Uint8Array(20);
  infoBytes[0] = 2;
  infoBytes[1] = 0;
  infoBytes[8] = deviceInfo.accIdx ?? 3;
  infoBytes[9] = deviceInfo.gyroIdx ?? 3;
  info.readValueData = new DataView(infoBytes.buffer);
  dateTime.readValueData = new DataView(encodeDateTime(new Date()).buffer);

  return { profile, transport, bluetooth, device, info, dateTime, sensor };
}

test('begin: DeviceInfo取得 → mode書込 → 時刻同期 → notify開始 の順で実行される', async () => {
  const h = makeInsoleHarness();
  const result = await h.profile.begin({
    transport: h.transport,
    notificationType: 'SENSOR_VALUES',
    options: {}, firmware: null
  });

  assert.equal(result, 'done begin(); SENSOR VALUES');
  assert.deepEqual([...h.info.written[0]!], [0x0d, 4]); // 既定 mode 4
  assert.equal(h.dateTime.readCalls, 3); // 時刻同期 3 回計測
  assert.equal(h.dateTime.written[0]!.length, 7);
  assert.equal(h.sensor.notifying, true);
  assert.equal(h.profile.device_information!.battery, 2);
  assert.equal(h.profile.streaming_mode, 4);
});

test('begin: streamingMode オプションが反映される', async () => {
  const h = makeInsoleHarness();
  await h.profile.begin({
    transport: h.transport,
    notificationType: 'SENSOR_VALUES',
    options: { streamingMode: 3 }, firmware: null
  });
  assert.deepEqual([...h.info.written[0]!], [0x0d, 3]);
});

test('begin: 不正な mode はデバイスに触る前に INVALID_MODE で reject', async () => {
  const h = makeInsoleHarness();
  await assert.rejects(
    h.profile.begin({
      transport: h.transport,
      notificationType: 'SENSOR_VALUES',
      options: { streamingMode: 2 }, firmware: null
    }),
    (e: TransportError) => e.code === 'INVALID_MODE'
  );
  assert.equal(h.info.written.length, 0);
  assert.equal(h.info.readCalls, 0);
});

test('parse: begin 前は既定レンジ（±16G / ±2000dps）で換算する', () => {
  const profile = insoleProfile();
  const dv = packet104(50);
  dv.setInt16(85, -16384); // acc.x → -0.5
  const samples = profile.parse('SENSOR_VALUES', dv)!;
  assert.equal((samples[0] as Record<string, any>).converted_acc.x, -8);
});

test('parse: begin で取得したレンジ設定が換算に使われる', async () => {
  const h = makeInsoleHarness({ accIdx: 0, gyroIdx: 0 }); // ±2G / ±250dps
  await h.profile.begin({ transport: h.transport, notificationType: 'SENSOR_VALUES', options: {}, firmware: null});

  const dv = packet104(50);
  dv.setInt16(79, 16384);  // gyro.x raw
  dv.setInt16(85, -16384); // acc.x → -0.5
  const samples = h.profile.parse('SENSOR_VALUES', dv)!;
  const s0 = samples[0] as Record<string, any>;
  assert.equal(s0.converted_acc.x, -1); // -0.5 × 2G
  assert.ok(Math.abs(s0.converted_gyro.x - 16384 * 0.00875) < 1e-9);
});

test('parse: SENSOR_VALUES 以外の uuid は null', () => {
  const profile = insoleProfile();
  assert.equal(profile.parse('DEVICE_INFORMATION', packet104(50)), null);
});

// ─── OrpheDevice との結合 ───────────────────────────────────────────

test('OrpheDevice + insoleProfile: begin → 通知が on("press") に届く', async () => {
  const bluetooth = new MockBluetooth();
  const device = new MockDevice('ins-1', 'INS-01');
  bluetooth.chooserQueue.push(device);
  const infoService = device.gatt.getOrCreateService(ORPHE_UUID.INFORMATION_SERVICE);
  const info = infoService.getOrCreate(ORPHE_UUID.DEVICE_INFORMATION);
  const dateTime = infoService.getOrCreate(ORPHE_UUID.DATE_TIME);
  const sensor = device.gatt.getOrCreateService(ORPHE_UUID.OTHER_SERVICE).getOrCreate(ORPHE_UUID.SENSOR_VALUES);
  const infoBytes = new Uint8Array(20);
  infoBytes[8] = 3;
  infoBytes[9] = 3;
  info.readValueData = new DataView(infoBytes.buffer);
  dateTime.readValueData = new DataView(encodeDateTime(new Date()).buffer);

  const ble = new OrpheDevice({
    profile: insoleProfile(),
    id: 0,
    bluetooth,
    storage: new MemoryStorage(),
  });
  const pressValues: number[][] = [];
  ble.on('press', (press) => pressValues.push((press as { values: number[] }).values));

  await ble.begin('SENSOR_VALUES', { streamingMode: 4 });

  const dv = packet104(56);
  [100, 200, 300, 400, 500, 600].forEach((v, i) => dv.setUint16(60 + 2 * i, v)); // pn0
  [700, 800, 900, 1000, 1100, 1200].forEach((v, i) => dv.setUint16(28 + 2 * i, v)); // pn1
  sensor.emit(dv);

  assert.deepEqual(pressValues, [
    [100, 200, 300, 400, 500, 600],
    [700, 800, 900, 1000, 1100, 1200],
  ]);
});

// ─── 配送順・euler・serial gap──────────────────────────

test('dispatch: header 56 は quat → euler → acc → gyro → converted → press の順', () => {
  const profile = insoleProfile();
  const dv = packet104(56);
  dv.setInt16(40, 16384); // quat.w (Q14 = 1.0)
  const samples = profile.parse('SENSOR_VALUES', dv)!;
  const keys = Object.keys(samples[0]!);
  assert.deepEqual(
    keys.slice(0, 7),
    ['quat', 'euler', 'acc', 'gyro', 'converted_acc', 'converted_gyro', 'press']
  );
  const euler = samples[0]!.euler!;
  assert.ok(Math.abs(euler.roll) < 1e-9); // 単位quat → 全角度0
});

test('dispatch: header 50 は acc → quat → gyro → converted → euler の順', () => {
  const profile = insoleProfile();
  const samples = profile.parse('SENSOR_VALUES', packet104(50))!;
  const keys = Object.keys(samples[0]!);
  assert.deepEqual(
    keys.slice(0, 6),
    ['acc', 'quat', 'gyro', 'converted_acc', 'converted_gyro', 'euler']
  );
});

test('dispatch: header 55 は quat/euler なしで press を含む', () => {
  const profile = insoleProfile();
  const samples = profile.parse('SENSOR_VALUES', packet104(55))!;
  const keys = Object.keys(samples[0]!);
  assert.deepEqual(keys.slice(0, 5), ['acc', 'gyro', 'converted_acc', 'converted_gyro', 'press']);
  assert.equal(samples[0]!.euler, undefined);
});

test('dispatch: header 54（FIFO）は got* 配送されない', () => {
  const profile = insoleProfile();
  assert.equal(profile.parse('SENSOR_VALUES', packet104(54)), null);
});

test('serial gap: modular 差分で lost_data を先頭に配送し、重複 serial も検知する', () => {
  const profile = insoleProfile();
  profile.parse('SENSOR_VALUES', packet104(56, 100));
  assert.equal(profile.parse('SENSOR_VALUES', packet104(56, 101))![0]!.lost_data, undefined);

  const gap = profile.parse('SENSOR_VALUES', packet104(56, 105))!;
  assert.deepEqual(gap[0]!.lost_data, { serial: 105, prev: 101 });

  const dup = profile.parse('SENSOR_VALUES', packet104(56, 105))!;
  assert.deepEqual(dup[0]!.lost_data, { serial: 105, prev: 105 }); // diff 0 も欠損扱い
});

test('serial gap: uint16 wraparound（65535→0）は連番として扱う', () => {
  const profile = insoleProfile();
  profile.parse('SENSOR_VALUES', packet104(56, 65535));
  const wrapped = profile.parse('SENSOR_VALUES', packet104(56, 0))!;
  assert.equal(wrapped[0]!.lost_data, undefined);
});

test('serial gap: header 54 や未知ヘッダでも serial は追跡される', () => {
  const profile = insoleProfile();
  profile.parse('SENSOR_VALUES', packet104(54, 10)); // FIFO: 配送なしでも追跡
  const after = profile.parse('SENSOR_VALUES', packet104(56, 15))!;
  assert.deepEqual(after[0]!.lost_data, { serial: 15, prev: 10 });

  const unknown = profile.parse('SENSOR_VALUES', packet104(99, 20))!; // 未知ヘッダ: lost_data のみ
  assert.equal(unknown.length, 1);
  assert.deepEqual(unknown[0]!.lost_data, { serial: 20, prev: 15 });
});

// ─── chooser フィルタ ─────────────────────────────────────────────

test('insoleRequestDeviceOptions: namePrefix / service の OR フィルタと標準 DIS を含む', () => {
  const options = insoleRequestDeviceOptions();
  assert.deepEqual(options.filters, [
    { namePrefix: 'INS' },
    { services: [ORPHE_UUID.INFORMATION_SERVICE] },
  ]);
  assert.ok(options.optionalServices!.includes('device_information'));
  assert.deepEqual(options.optionalManufacturerData, [0x0000]);
});
