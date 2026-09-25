/**
 * CoreProfile: ORPHE CORE の DeviceProfile 実装。
 * - SENSOR_VALUES: header 50（92byte・quat は実ノルムで正規化・200Hz）/ header 40（通常・quat Q14）
 * - STEP_ANALYSIS: sub 0(gait)/1(stride)/2(pronation)/4(quat+delta)、steps 単調増加フィルタ
 * - begin シーケンス: DeviceInfo取得 → range適用書込 → 時刻同期 → notify種別分岐
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CoreProfile,
  coreProfile,
  decodeCoreDeviceInformation,
  decodeCoreStepAnalysis,
  parseCoreSensorValues,
  coreRequestDeviceOptions,
} from '../../src/profiles/core.ts';
import { OrpheBleTransport } from '../../src/ble/transport.ts';
import { encodeDateTime } from '../../src/protocol/datetime.ts';
import { ORPHE_UUID } from '../../src/protocol/uuids.ts';
import { MemoryStorage, MockBluetooth, MockDevice } from '../helpers/mock-bluetooth.ts';

// ─── SENSOR_VALUES: header 50（92byte・魔改造200Hz） ─────────────

function packet50(serial = 0x0102, byteLength = 92): DataView {
  const dv = new DataView(new ArrayBuffer(byteLength));
  dv.setUint8(0, 50);
  dv.setUint16(1, serial);
  dv.setUint8(3, 12);
  dv.setUint8(4, 34);
  dv.setUint8(5, 56);
  dv.setUint16(6, 789);
  return dv;
}

test('header 50: quat は実ノルムで正規化（Q14 / Q15 どちらでも単位クォータニオン）・4サンプル', () => {
  const dv = packet50();
  // packet_number 0 は i=3 のフレーム（オフセット 8 + 21*3 = 71）
  dv.setInt16(71, 16384);  // quat.w（Q14 の 1.0）
  dv.setInt16(50, 32767);  // packet_number 1 の quat.w（Q15 の 1.0 相当）
  dv.setInt16(79, 16384);  // gyro.x → 0.5
  dv.setInt16(85, -16384); // acc.x → -0.5

  const samples = parseCoreSensorValues(dv, { accRange: 16, gyroRange: 2000 })!;
  assert.equal(samples.length, 4);
  const [s0, s1] = samples;

  assert.deepEqual({ ...s0!.quat, timestamp: 0, serial_number: 0, packet_number: 0 }, { w: 1, x: 0, y: 0, z: 0, timestamp: 0, serial_number: 0, packet_number: 0 });
  assert.equal(s1!.quat!.w, 1);
  assert.equal(s0!.gyro!.x, 0.5);
  assert.equal(s0!.acc!.x, -0.5);
  // converted_gyro はレンジ別のデータシート感度（1 dps のフルスケールあたり 0.035 mdps/LSB）
  assert.equal(s0!.converted_gyro!.x, 16384 * 2000 * 0.000035);
  assert.equal(s0!.converted_acc!.x, -8);
  assert.equal(s0!.serial_number, 0x0102);
});

test('header 50: 各フレームの時刻は基準時刻からの経過（delta）を引いて求める', () => {
  const now = () => new Date(2026, 8, 9, 12, 0, 0);
  const dv = packet50();
  dv.setUint8(28, 5);  // delta0
  dv.setUint8(49, 10); // delta1
  dv.setUint8(70, 14); // delta2
  const base = new Date(2026, 8, 9, 12, 34, 56, 789).getTime();

  const samples = parseCoreSensorValues(dv, { accRange: 16, gyroRange: 2000, now })!;
  // 古い順に配送: 最古のフレームの経過は delta2 + (delta1 - delta0)
  assert.deepEqual(samples.map(sample => base - sample.timestamp!), [19, 14, 10, 5]);
});

test('header 50: quat のノルムが 0 のフレームは直前の姿勢を維持し、直前も無ければ単位クォータニオン', () => {
  const zero = parseCoreSensorValues(packet50(), { accRange: 16, gyroRange: 2000 })!;
  assert.deepEqual([zero[0]!.quat!.w, zero[0]!.quat!.x], [1, 0]);

  const previous = { w: 0, x: 1, y: 0, z: 0 };
  const held = parseCoreSensorValues(packet50(), { accRange: 16, gyroRange: 2000, previousQuat: previous })!;
  assert.deepEqual([held[0]!.quat!.w, held[0]!.quat!.x], [0, 1]);
});

test('header 50: 92 バイト以外（104 バイト版を含む）は null', () => {
  for (const byteLength of [100, 104]) {
    const dv = new DataView(new ArrayBuffer(byteLength));
    dv.setUint8(0, 50);
    assert.equal(parseCoreSensorValues(dv, { accRange: 16, gyroRange: 2000 }), null, `${byteLength} bytes`);
  }
});

test('acceptExtendedSensorValues: 104 バイトの header 50 を先頭 92 バイトとして読む', () => {
  const build = (byteLength: number) => {
    const dv = packet50(0x0304, byteLength);
    dv.setInt16(71, 16384);
    dv.setInt16(79, 16384);
    return dv;
  };
  assert.equal(coreProfile().parse('SENSOR_VALUES', build(104)), null, '既定では受け付けない');

  const extended = coreProfile({ acceptExtendedSensorValues: true }).parse('SENSOR_VALUES', build(104));
  const standard = coreProfile().parse('SENSOR_VALUES', build(92));
  assert.ok(extended && standard);
  assert.deepEqual(extended, standard);
});

// ─── SENSOR_VALUES: header 40（通常） ────────────────────────────

test('header 40: quat は Q14・gyro/acc は int8/127・stamp なしの単一サンプル', () => {
  const dv = new DataView(new ArrayBuffer(20));
  dv.setUint8(0, 40);
  dv.setInt16(1, 16384); // quat.w → Q14 で 1.0
  dv.setInt8(9, 127);    // gyro.x → 1.0（int16 の上位バイト）
  dv.setInt8(14, -127);  // acc.x → -1.0

  const samples = parseCoreSensorValues(dv, { accRange: 8, gyroRange: 500 })!;
  assert.equal(samples.length, 1);
  const s0 = samples[0]!;
  assert.equal(s0.quat!.w, 1.0);
  assert.equal(s0.gyro!.x, 1.0);
  assert.equal(s0.acc!.x, -1.0);
  assert.equal(s0.converted_gyro!.x, 127 * 256 * 500 * 0.000035); // int16 相当に戻してから感度換算
  assert.equal(s0.converted_acc!.x, -8);
  assert.equal(s0.timestamp, undefined); // header 40 に stamp はない
  assert.equal(s0.serial_number, undefined);
});

test('未知ヘッダの SENSOR_VALUES は null', () => {
  const dv = new DataView(new ArrayBuffer(20));
  dv.setUint8(0, 41);
  assert.equal(parseCoreSensorValues(dv, { accRange: 16, gyroRange: 2000 }), null);
});

// ─── STEP_ANALYSIS decode ────────────────────────────────────────

function stepPacket(subheader: number, steps: number): DataView {
  const dv = new DataView(new ArrayBuffer(20));
  dv.setUint8(1, subheader);
  dv.setUint16(2, steps);
  return dv;
}

test('decodeCoreStepAnalysis sub 0: type/direction のビット展開と float16 calorie', () => {
  const dv = stepPacket(0, 10);
  dv.setUint8(4, 0b10_010_000); // type=2, direction=2
  dv.setUint16(6, 0x3c00);      // calorie = 1.0 (float16)
  dv.setFloat32(8, 123.5);      // distance
  dv.setFloat32(12, 0.6);       // standing
  dv.setFloat32(16, 0.4);       // swing

  const packet = decodeCoreStepAnalysis(dv)!;
  assert.equal(packet.subheader, 0);
  assert.equal(packet.steps, 10);
  assert.equal(packet.gait!.type, 2);
  assert.equal(packet.gait!.direction, 2);
  assert.equal(packet.gait!.calorie, 1.0);
  assert.equal(packet.gait!.distance, Math.fround(123.5));
  assert.ok(Math.abs(packet.gait!.standing_phase_duration - 0.6) < 1e-6);
});

test('decodeCoreStepAnalysis sub 1/2/4 のフィールド', () => {
  const stride = stepPacket(1, 3);
  stride.setFloat32(4, 12.5);
  stride.setFloat32(8, 0.7);
  const p1 = decodeCoreStepAnalysis(stride)!;
  assert.equal(p1.stride!.foot_angle, 12.5);
  assert.equal(p1.stride!.x, Math.fround(0.7));

  const pron = stepPacket(2, 3);
  pron.setFloat32(4, 1.25);
  pron.setFloat32(8, -0.5);
  const p2 = decodeCoreStepAnalysis(pron)!;
  assert.equal(p2.pronation!.landing_impact, 1.25);
  assert.equal(p2.pronation!.x, -0.5);

  const quat = stepPacket(4, 0);
  quat.setUint16(6, 0x3c00);  // quat.w = 1.0
  quat.setUint16(14, 0xb800); // delta.x = -0.5
  const p4 = decodeCoreStepAnalysis(quat)!;
  assert.equal(p4.quat!.w, 1.0);
  assert.equal(p4.delta!.x, -0.5);
});

// ─── CoreProfile.parse: steps 単調増加フィルタ ────────────────────

test('STEP_ANALYSIS: steps が増えたときだけイベントになり、同一 steps は重複しない', () => {
  const profile = coreProfile();

  const gait5 = stepPacket(0, 5);
  const first = profile.parse('STEP_ANALYSIS', gait5)!;
  assert.equal(first.length, 1);
  const sample = first[0]!;
  assert.deepEqual(sample.steps_number, { value: 5 });
  assert.equal(sample.gait!.steps, 5);
  // 配送順（gait → type → distance → direction → calorie → standing → swing）
  assert.deepEqual(Object.keys(sample), [
    'steps_number', 'gait', 'type', 'distance', 'direction', 'calorie',
    'standing_phase_duration', 'swing_phase_duration',
  ]);

  assert.equal(profile.parse('STEP_ANALYSIS', stepPacket(0, 5)), null); // 同一 steps は無視
  const second = profile.parse('STEP_ANALYSIS', stepPacket(0, 6))!;
  assert.deepEqual(second[0]!.steps_number, { value: 6 });
});

test('STEP_ANALYSIS: stride は foot_angle → stride の順、steps_number へリネーム', () => {
  const profile = coreProfile();
  const dv = stepPacket(1, 4);
  dv.setFloat32(4, 30);  // foot_angle
  dv.setFloat32(8, 0.5); // x
  const samples = profile.parse('STEP_ANALYSIS', dv)!;
  const sample = samples[0]!;
  assert.deepEqual(Object.keys(sample), ['steps_number', 'foot_angle', 'stride']);
  assert.deepEqual(sample.foot_angle, { value: 30 });
  assert.equal(sample.stride!.steps_number, 4); // stride 内は steps ではなく steps_number
  assert.equal(sample.stride!.x, 0.5);
});

test('STEP_ANALYSIS: pronation → landing_impact の順', () => {
  const profile = coreProfile();
  const dv = stepPacket(2, 4);
  dv.setFloat32(4, 2.5); // landing_impact
  dv.setFloat32(8, 0.1);
  const sample = profile.parse('STEP_ANALYSIS', dv)![0]!;
  assert.deepEqual(Object.keys(sample), ['steps_number', 'pronation', 'landing_impact']);
  assert.deepEqual(sample.landing_impact, { value: 2.5 });
  assert.equal(sample.pronation!.x, Math.fround(0.1));
});

test('STEP_ANALYSIS sub 4: quat/delta は steps フィルタなしで毎回配送', () => {
  const profile = coreProfile();
  const dv = stepPacket(4, 0);
  dv.setUint16(6, 0x3c00);
  const first = profile.parse('STEP_ANALYSIS', dv)!;
  const again = profile.parse('STEP_ANALYSIS', dv)!;
  assert.deepEqual(Object.keys(first[0]!), ['quat', 'delta', 'euler']);
  assert.equal(again.length, 1); // 重複フィルタ対象外
});

test('resetAnalysisState: steps フィルタが初期化される', () => {
  const profile = coreProfile();
  profile.parse('STEP_ANALYSIS', stepPacket(0, 10));
  assert.equal(profile.parse('STEP_ANALYSIS', stepPacket(0, 10)), null);
  profile.resetAnalysisState();
  assert.ok(profile.parse('STEP_ANALYSIS', stepPacket(0, 10)));
});

// ─── DEVICE_INFORMATION ──────────────────────────────────────────

test('decodeCoreDeviceInformation: 全フィールド', () => {
  const bytes = new Uint8Array(20);
  bytes[0] = 2;  // battery
  bytes[1] = 1;  // lr
  bytes[2] = 1;  // rec_mode
  bytes[3] = 0;  // rec_auto_run
  bytes[4] = 200; // led_brightness
  bytes[6] = 3;  // time01
  bytes[7] = 4;  // time02
  bytes[8] = 3;  // acc range index
  bytes[9] = 2;  // gyro range index
  const info = decodeCoreDeviceInformation(new DataView(bytes.buffer));
  assert.equal(info.battery, 2);
  assert.equal(info.lr, 1);
  assert.equal(info.rec_mode, 1);
  assert.equal(info.led_brightness, 200);
  assert.deepEqual({ time01: info.time01, time02: info.time02 }, { time01: 3, time02: 4 });
  assert.deepEqual({ acc: info.range.acc, gyro: info.range.gyro }, { acc: 3, gyro: 2 });
});

// ─── begin シーケンス ────────────────────────────────────────────

function makeCoreHarness() {
  const profile = coreProfile({ settleMs: 0 });
  const bluetooth = new MockBluetooth();
  const device = new MockDevice('cr-1', 'CR-01');
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
  const otherService = device.gatt.getOrCreateService(ORPHE_UUID.OTHER_SERVICE);
  const sensor = otherService.getOrCreate(ORPHE_UUID.SENSOR_VALUES);
  const step = otherService.getOrCreate(ORPHE_UUID.STEP_ANALYSIS);

  const infoBytes = new Uint8Array(20);
  infoBytes[0] = 2;   // battery
  infoBytes[1] = 1;   // lr
  infoBytes[3] = 1;   // rec_auto_run
  infoBytes[4] = 128; // led_brightness
  infoBytes[6] = 3;   // time01
  infoBytes[7] = 4;   // time02
  infoBytes[8] = 0;   // acc index (±2G)
  infoBytes[9] = 0;   // gyro index (±250dps)
  info.readValueData = new DataView(infoBytes.buffer);
  dateTime.readValueData = new DataView(encodeDateTime(new Date()).buffer);

  return { profile, transport, bluetooth, device, info, dateTime, sensor, step };
}

test('begin: DeviceInfo取得 → range適用書込 → 時刻同期 → 種別の notify 開始', async () => {
  const h = makeCoreHarness();
  const result = await h.profile.begin({
    transport: h.transport,
    notificationType: 'STEP_ANALYSIS_AND_SENSOR_VALUES',
    options: { range: { acc: 16, gyro: 2000 } },
    firmware: null,
  });

  assert.match(String(result), /done begin/);
  // 書込 payload: [0x01, lr, led, 0(モーター), rec_auto_run, time01, time02, acc, gyro]
  assert.deepEqual([...h.info.written[0]!], [0x01, 1, 128, 0, 1, 3, 4, 3, 3]); // range 指定で index 3/3 に上書き
  assert.equal(h.dateTime.readCalls, 3);
  assert.equal(h.dateTime.written[0]!.length, 7);
  assert.equal(h.step.notifying, true);
  assert.equal(h.sensor.notifying, true);
  assert.equal(h.profile.device_information!.battery, 2);
});

test('begin: range 未指定ならデバイスの現在値を書き戻す', async () => {
  const h = makeCoreHarness();
  await h.profile.begin({ transport: h.transport, notificationType: 'STEP_ANALYSIS', options: {}, firmware: null});
  assert.deepEqual([...h.info.written[0]!], [0x01, 1, 128, 0, 1, 3, 4, 0, 0]); // index 0/0 のまま
  assert.equal(h.step.notifying, true);
  assert.equal(h.sensor.notifying, false);
});

test('begin: SENSOR_VALUES 指定なら STEP_ANALYSIS は購読しない', async () => {
  const h = makeCoreHarness();
  await h.profile.begin({ transport: h.transport, notificationType: 'SENSOR_VALUES', options: {}, firmware: null});
  assert.equal(h.sensor.notifying, true);
  assert.equal(h.step.notifying, false);
});

test('begin: 非推奨エイリアス RAW/ANALYSIS は新名称に読み替える', async () => {
  const h = makeCoreHarness();
  await h.profile.begin({ transport: h.transport, notificationType: 'RAW', options: {}, firmware: null});
  assert.equal(h.sensor.notifying, true);
  assert.equal(h.step.notifying, false);
});

test('begin 後の parse はデバイスのレンジ設定で換算する', async () => {
  const h = makeCoreHarness(); // acc index 0 → ±2G
  await h.profile.begin({ transport: h.transport, notificationType: 'SENSOR_VALUES', options: {}, firmware: null});

  const dv = packet50();
  dv.setInt16(85, -16384); // acc.x → -0.5
  const samples = h.profile.parse('SENSOR_VALUES', dv)!;
  assert.equal(samples[0]!.converted_acc!.x, -1); // -0.5 × 2
});

test('CoreProfile は DeviceProfile として型が付く（storageKey は固定値）', () => {
  const profile: CoreProfile = coreProfile();
  assert.equal(profile.kind, 'core');
  assert.equal(profile.defaultNotificationType, 'STEP_ANALYSIS');
  assert.equal(profile.storageKey(1), 'orphe_last_bluetooth_device_1');
});

// ─── serial gap（lost_data）と euler ─────────────────────────────

test('header 50: serial 欠損で lost_data がサンプルより先に配送される', () => {
  const profile = coreProfile();
  const p10 = packet50(10);
  const p11 = packet50(11);
  const p13 = packet50(13);

  const first = profile.parse('SENSOR_VALUES', p10)!;
  assert.equal(first[0]!.lost_data, undefined); // 初回は欠損なし

  const second = profile.parse('SENSOR_VALUES', p11)!;
  assert.equal(second[0]!.lost_data, undefined); // 連番

  const third = profile.parse('SENSOR_VALUES', p13)!;
  assert.deepEqual(third[0]!.lost_data, { serial: 13, prev: 11 }); // 12 が欠損
  assert.ok(third[1]!.acc); // 後続にセンサーサンプル
});

test('header 50: serial は uint16 の巻き戻りを連続とみなし、0 も正当な値として扱う', () => {
  const profile = coreProfile();
  const lossOf = (serial: number) => profile.parse('SENSOR_VALUES', packet50(serial))![0]!.lost_data;
  assert.equal(lossOf(65534), undefined);
  assert.equal(lossOf(65535), undefined);
  assert.equal(lossOf(0), undefined); // 65535 → 0 は連続
  assert.deepEqual(lossOf(5), { serial: 5, prev: 0 });
  assert.deepEqual(lossOf(5), { serial: 5, prev: 5 }); // 重複も欠損扱い
});

test('begin で serial の追跡をやり直す（再接続直後に lost_data を出さない）', async () => {
  const h = makeCoreHarness();
  h.profile.parse('SENSOR_VALUES', packet50(10));
  await h.profile.begin({ transport: h.transport, notificationType: 'SENSOR_VALUES', options: {}, firmware: null});
  assert.equal(h.profile.parse('SENSOR_VALUES', packet50(3000))![0]!.lost_data, undefined);
});

test('header 50: 長さ不正でも serial は追跡され lost_data のみ返る', () => {
  const profile = coreProfile();
  profile.parse('SENSOR_VALUES', packet50(10));
  const bad = new DataView(new ArrayBuffer(104)); // 92 以外
  bad.setUint8(0, 50);
  bad.setUint16(1, 20);
  const result = profile.parse('SENSOR_VALUES', bad)!;
  assert.equal(result.length, 1);
  assert.deepEqual(result[0]!.lost_data, { serial: 20, prev: 10 });
});

test('header 50: euler が converted の後に付く（正規化した quat から計算）', () => {
  const profile = coreProfile();
  const dv = packet50(1);
  dv.setInt16(71, 8000);
  const samples = profile.parse('SENSOR_VALUES', dv)!;
  const s0 = samples[0]!;
  const keys = Object.keys(s0);
  assert.ok(keys.indexOf('euler') > keys.indexOf('converted_gyro'));
  assert.deepEqual(s0.euler, { roll: 0, pitch: 0, yaw: 0 });
});

test('header 40: euler は正規化した quat から計算される', () => {
  const profile = coreProfile();
  const dv = new DataView(new ArrayBuffer(20));
  dv.setUint8(0, 40);
  dv.setInt16(1, 8192); // quat.w = 0.5（正規化で 1.0 相当へ）
  const samples = profile.parse('SENSOR_VALUES', dv)!;
  const euler = samples[0]!.euler!;
  assert.ok(Math.abs(euler.roll) < 1e-9); // (0.5,0,0,0)→正規化(1,0,0,0)→全角度0
  assert.ok(Math.abs(euler.pitch) < 1e-9);
});

test('STEP_ANALYSIS sub 4: quat → delta → euler の順で配送', () => {
  const profile = coreProfile();
  const dv = stepPacket(4, 0);
  dv.setUint16(6, 0x3c00); // quat.w = 1.0
  const sample = profile.parse('STEP_ANALYSIS', dv)![0]!;
  assert.deepEqual(Object.keys(sample), ['quat', 'delta', 'euler']);
  assert.deepEqual(sample.euler, { roll: 0, pitch: 0, yaw: 0 });
});

// ─── chooser フィルタ ─────────────────────────────────────────────

test('coreRequestDeviceOptions: services フィルタと namePrefix の併用', () => {
  const standard = coreRequestDeviceOptions();
  assert.deepEqual(standard.filters, [{ services: [ORPHE_UUID.INFORMATION_SERVICE] }]);
  assert.ok(standard.optionalServices!.includes(ORPHE_UUID.OTHER_SERVICE));

  // namePrefix を渡すと名前とサービス UUID の OR フィルタになる
  const companion = coreRequestDeviceOptions({ namePrefix: 'CR-' });
  assert.deepEqual(companion.filters, [
    { namePrefix: 'CR-' },
    { services: [ORPHE_UUID.INFORMATION_SERVICE] },
  ]);
});
