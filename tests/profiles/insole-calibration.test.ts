/**
 * InsoleProfile の個体別圧力校正係数。
 * - 対応 FW（20260428 以降）では begin() の中で 6ch ぶんを取得し、
 *   以後の press を N に換算した converted_press を配送する
 * - FW は圧力を含む配信モード（3 / 4）のときだけ要求に応答する。
 *   圧力を含まないモードを要求されたら、取得の間だけモード 4 にして戻す
 * - 応答がない ch は固定式で換算し、begin() は失敗させない
 * - 取得結果（対応 FW か、ch ごとの係数・未書込・応答なし）をログに出す
 * - 旧 FW / FW 不明では取得せず、固定式で換算する
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OrpheDevice } from '../../src/device/orphe-device.ts';
import { insoleProfile } from '../../src/profiles/insole.ts';
import type { InsoleProfileOptions } from '../../src/profiles/insole.ts';
import { INSOLE_PRESSURE_CALIBRATION_MIN_RELEASE_DATE } from '../../src/modes/insole.ts';
import { ORPHE_UUID } from '../../src/protocol/uuids.ts';
import { encodeDateTime } from '../../src/protocol/datetime.ts';
import {
  applyPressureCalibration,
  legacyPressureToNewton,
} from '../../src/protocol/pressure-calibration.ts';
import type { PressureCalibration } from '../../src/protocol/pressure-calibration.ts';
import { fwPayload } from '../helpers/fw-payload.ts';
import { calibrationPayload } from '../helpers/calibration-payload.ts';
import { MemoryStorage, MockBluetooth, MockDevice } from '../helpers/mock-bluetooth.ts';

/** ch ごとに違う係数（func 1 で y = (ch+1)·x） */
function deviceCalibration(ch: number): PressureCalibration {
  return { func: 1, coefficients: [0, 0, 0, ch + 1, 0] };
}

interface HarnessOptions {
  /** GET_FW_NAME の応答。null なら characteristic 自体を置かない */
  fw?: DataView | null;
  profile?: InsoleProfileOptions;
  /** 接続時点でデバイスが配信しているモード。既定 1（圧力なし） */
  initialMode?: number;
  /** 校正要求への応答。null を返すと無応答 */
  respond?: (ch: number, attempt: number) => DataView | null;
}

function makeInsole(options: HarnessOptions = {}) {
  const bluetooth = new MockBluetooth();
  const device = new MockDevice('ins-1', 'INS-01');
  bluetooth.chooserQueue.push(device);

  const infoService = device.gatt.getOrCreateService(ORPHE_UUID.INFORMATION_SERVICE);
  const info = infoService.getOrCreate(ORPHE_UUID.DEVICE_INFORMATION);
  const dateTime = infoService.getOrCreate(ORPHE_UUID.DATE_TIME);
  const other = device.gatt.getOrCreateService(ORPHE_UUID.OTHER_SERVICE);
  const sensor = other.getOrCreate(ORPHE_UUID.SENSOR_VALUES);
  if (options.fw !== null) {
    other.getOrCreate(ORPHE_UUID.GET_FW_NAME).readValueData = options.fw ?? fwPayload(2026, 4, 28);
  }

  const infoBytes = new Uint8Array(20);
  infoBytes[8] = 3;
  infoBytes[9] = 3;
  info.readValueData = new DataView(infoBytes.buffer);
  dateTime.readValueData = new DataView(encodeDateTime(new Date()).buffer);

  // 実機と同じく、圧力を含むモード（3 / 4）のときだけ校正要求に応答する偽 FW
  let deviceMode = options.initialMode ?? 1;
  const attempts = new Map<number, number>();
  const requests: { ch: number; mode: number; notifying: boolean }[] = [];
  const respond = options.respond ?? ((ch) => calibrationPayload(ch, 1, deviceCalibration(ch).coefficients));
  info.onWriteValue = (bytes) => {
    if (bytes[0] === 0x0d) {
      deviceMode = bytes[1]!;
      return;
    }
    if (bytes[0] !== 0x10) return;
    const ch = bytes[2]!;
    requests.push({ ch, mode: deviceMode, notifying: sensor.notifying });
    if (deviceMode !== 3 && deviceMode !== 4) return;
    const attempt = (attempts.get(ch) ?? 0) + 1;
    attempts.set(ch, attempt);
    const payload = respond(ch, attempt);
    if (payload) sensor.emit(payload);
  };

  const profile = insoleProfile({ timeSyncSamples: 1, ...options.profile });
  const errors: unknown[] = [];
  const logs: { message: string; detail?: unknown }[] = [];
  const ble = new OrpheDevice({
    profile,
    id: 0,
    bluetooth,
    storage: new MemoryStorage(),
    events: { onError: (e) => errors.push(e) },
    log: (message, detail) => logs.push({ message, detail }),
    wait: async () => {},
  });
  /** DEVICE_INFORMATION への書込を「mode:N」「req:ch」の列にしたもの */
  const writeSequence = () => info.written
    .filter(w => w[0] === 0x0d || w[0] === 0x10)
    .map(w => (w[0] === 0x0d ? `mode:${w[1]}` : `req:${w[2]}`));
  /** 圧力校正のログだけ */
  const calibrationLogs = () => logs.filter(l => l.message.startsWith('圧力校正'));
  return { ble, profile, info, sensor, requests, errors, writeSequence, calibrationLogs };
}

function pressPacket(values: number[]): DataView {
  const dv = new DataView(new ArrayBuffer(104));
  dv.setUint8(0, 56);
  values.forEach((v, i) => dv.setUint16(60 + 2 * i, v)); // pn0
  values.forEach((v, i) => dv.setUint16(28 + 2 * i, v)); // pn1
  return dv;
}

const RAW = [100, 200, 300, 400, 500, 600];
const FAST = { timeoutMs: 5, retries: 2 };

test('しきい値: 20260428', () => {
  assert.equal(INSOLE_PRESSURE_CALIBRATION_MIN_RELEASE_DATE, 20260428);
});

test('mode 4 を要求: 先に mode 4 を書き、notify 有効化後に 6ch 取得する', async () => {
  const h = makeInsole();
  await h.ble.begin('SENSOR_VALUES', { streamingMode: 4 });

  assert.deepEqual(h.writeSequence(), ['mode:4', 'req:0', 'req:1', 'req:2', 'req:3', 'req:4', 'req:5']);
  assert.ok(h.requests.every(r => r.notifying), '校正要求は notify 有効化後に送る');
  assert.equal(h.profile.streaming_mode, 4);
  assert.deepEqual(h.profile.pressure_calibrations, [0, 1, 2, 3, 4, 5].map(deviceCalibration));
  assert.deepEqual(h.errors, []);
});

test('mode 3 を要求: mode 3 のまま取得する', async () => {
  const h = makeInsole();
  await h.ble.begin('SENSOR_VALUES', { streamingMode: 3 });
  assert.deepEqual(h.writeSequence(), ['mode:3', 'req:0', 'req:1', 'req:2', 'req:3', 'req:4', 'req:5']);
  assert.equal(h.profile.streaming_mode, 3);
});

test('mode 1 を要求: 取得の間だけ mode 4 にし、終わったら mode 1 に戻す', async () => {
  const h = makeInsole();
  await h.ble.begin('SENSOR_VALUES', { streamingMode: 1 });
  assert.deepEqual(
    h.writeSequence(),
    ['mode:4', 'req:0', 'req:1', 'req:2', 'req:3', 'req:4', 'req:5', 'mode:1']
  );
  assert.equal(h.profile.streaming_mode, 1);
  assert.equal(h.profile.pressure_calibrations?.length, 6);
});

test('対応 FW: press と一緒に converted_press（N）が配送される', async () => {
  const h = makeInsole();
  const received: { press: number[]; converted: number[] }[] = [];
  h.ble.on('*', (sample) => {
    const s = sample as { press?: { values: number[] }; converted_press?: { values: number[] } };
    if (s.press && s.converted_press) received.push({ press: s.press.values, converted: s.converted_press.values });
  });
  await h.ble.begin('SENSOR_VALUES', { streamingMode: 4 });
  h.sensor.emit(pressPacket(RAW));

  assert.equal(received.length, 2);
  assert.deepEqual(received[0]!.press, RAW);
  assert.deepEqual(received[0]!.converted, RAW.map((x, ch) => applyPressureCalibration(deviceCalibration(ch), x)));
});

test('旧 FW（前日 20260427）: 取得せず、converted_press は固定式で換算する', async () => {
  const h = makeInsole({ fw: fwPayload(2026, 4, 27) });
  const converted: number[][] = [];
  h.ble.on('*', (sample) => {
    const s = sample as { converted_press?: { values: number[] } };
    if (s.converted_press) converted.push(s.converted_press.values);
  });
  await h.ble.begin('SENSOR_VALUES', { streamingMode: 4 });
  h.sensor.emit(pressPacket(RAW));

  assert.deepEqual(h.requests, []);
  assert.deepEqual(h.writeSequence(), ['mode:4']);
  assert.equal(h.profile.pressure_calibrations, null);
  assert.deepEqual(converted[0], RAW.map(legacyPressureToNewton));
});

test('FW 不明（GET_FW_NAME なし）: 旧 FW として扱い取得しない', async () => {
  const h = makeInsole({ fw: null });
  await h.ble.begin('SENSOR_VALUES', { streamingMode: 4 });
  assert.deepEqual(h.requests, []);
  assert.equal(h.profile.pressure_calibrations, null);
});

test('プレースホルダ（func 0・全係数 1.0）の ch だけ固定式に戻す', async () => {
  const h = makeInsole({
    respond: (ch) => ch === 3
      ? calibrationPayload(ch, 0, [1, 1, 1, 1, 1])
      : calibrationPayload(ch, 1, deviceCalibration(ch).coefficients),
  });
  const converted: number[][] = [];
  h.ble.on('*', (sample) => {
    const s = sample as { converted_press?: { values: number[] } };
    if (s.converted_press) converted.push(s.converted_press.values);
  });
  await h.ble.begin('SENSOR_VALUES', { streamingMode: 4 });
  h.sensor.emit(pressPacket(RAW));

  assert.equal(h.profile.pressure_calibrations![3], null);
  assert.equal(converted[0]![3], legacyPressureToNewton(RAW[3]!));
  assert.equal(converted[0]![2], applyPressureCalibration(deviceCalibration(2), RAW[2]!));
});

test('無応答は再試行し、1 回目が落ちても 2 回目で拾う', async () => {
  const h = makeInsole({
    profile: { pressureCalibration: { timeoutMs: 5, retries: 3 } },
    respond: (ch, attempt) => (ch === 2 && attempt === 1)
      ? null
      : calibrationPayload(ch, 1, deviceCalibration(ch).coefficients),
  });
  await h.ble.begin('SENSOR_VALUES', { streamingMode: 4 });
  assert.deepEqual(h.requests.map(r => r.ch), [0, 1, 2, 2, 3, 4, 5]);
  assert.deepEqual(h.profile.pressure_calibrations![2], deviceCalibration(2));
});

test('再試行を使い切った ch は固定式にして、begin() は成功させる', async () => {
  const h = makeInsole({
    profile: { pressureCalibration: FAST },
    respond: (ch) => ch === 4 ? null : calibrationPayload(ch, 1, deviceCalibration(ch).coefficients),
  });
  await h.ble.begin('SENSOR_VALUES', { streamingMode: 1 });

  assert.equal(h.requests.filter(r => r.ch === 4).length, 2);
  assert.equal(h.profile.pressure_calibrations![4], null);
  assert.deepEqual(h.profile.pressure_calibrations![5], deviceCalibration(5));
  assert.equal(h.profile.streaming_mode, 1, '取得に失敗しても要求モードまで進む');
  assert.deepEqual(h.errors, []);
});

test('既定の待ち時間は 1ch あたり 1000 ms × 3 回', () => {
  const profile = insoleProfile();
  assert.deepEqual(profile.pressureCalibrationSettings(), { fetch: true, timeoutMs: 1000, retries: 3 });
});

test('pressureCalibration.fetch = false なら対応 FW でも取得しない', async () => {
  const h = makeInsole({ profile: { pressureCalibration: { fetch: false } } });
  await h.ble.begin('SENSOR_VALUES', { streamingMode: 1 });
  assert.deepEqual(h.requests, []);
  assert.deepEqual(h.writeSequence(), ['mode:1']);
  assert.equal(h.profile.pressure_calibrations, null);
});

test('begin() のたびに取り直す（別デバイスに繋ぎ替えても古い係数を使わない）', async () => {
  const h = makeInsole();
  await h.ble.begin('SENSOR_VALUES', { streamingMode: 4 });
  await h.ble.begin('SENSOR_VALUES', { streamingMode: 4 });
  assert.equal(h.requests.length, 12);
});

test('校正応答（0x39）はセンサーサンプルとして配送されない', async () => {
  const h = makeInsole();
  const samples: unknown[] = [];
  h.ble.on('*', (sample) => samples.push(sample));
  await h.ble.begin('SENSOR_VALUES', { streamingMode: 4 });
  assert.equal(samples.filter(s => (s as { press?: unknown }).press).length, 0);
  assert.equal(samples.filter(s => (s as { lost_data?: unknown }).lost_data).length, 0);
});

// ─── ログ ───────────────────────────────────────────────────────────

test('ログ: 対応 FW では ch ごとの係数・未書込・応答なしと、集計を出す', async () => {
  const h = makeInsole({
    fw: fwPayload(2026, 5, 10),
    profile: { pressureCalibration: FAST },
    respond: (ch) => {
      if (ch === 4) return null;
      if (ch === 3) return calibrationPayload(ch, 0, [1, 1, 1, 1, 1]);
      return calibrationPayload(ch, 1, deviceCalibration(ch).coefficients);
    },
  });
  await h.ble.begin('SENSOR_VALUES', { streamingMode: 4 });

  const logs = h.calibrationLogs();
  assert.deepEqual(logs.map(l => l.message), [
    '圧力校正: 対応 FW（リリース日 20260510）。係数を取得します',
    '圧力校正 ch0: 個体別係数',
    '圧力校正 ch1: 個体別係数',
    '圧力校正 ch2: 個体別係数',
    '圧力校正 ch3: 未書込（func 0・係数すべて 1.0）。固定式で換算',
    '圧力校正 ch4: 応答なし（2 回）。固定式で換算',
    '圧力校正 ch5: 個体別係数',
    '圧力校正: 個体別係数 4ch / 未書込 1ch / 応答なし 1ch',
  ]);
  assert.deepEqual(logs[1]!.detail, deviceCalibration(0));
  assert.deepEqual(logs[4]!.detail, { func: 0, coefficients: [1, 1, 1, 1, 1] });
});

test('ログ: 旧 FW ではリリース日としきい値を出し、取得しない', async () => {
  const h = makeInsole({ fw: fwPayload(2026, 4, 27) });
  await h.ble.begin('SENSOR_VALUES', { streamingMode: 4 });
  assert.deepEqual(h.calibrationLogs().map(l => l.message), [
    '圧力校正: 非対応 FW（リリース日 20260427 < 20260428）。固定式で換算',
  ]);
});

test('ログ: FW 不明・取得無効もそれと分かるように出す', async () => {
  const unknown = makeInsole({ fw: null });
  await unknown.ble.begin('SENSOR_VALUES', { streamingMode: 4 });
  assert.deepEqual(unknown.calibrationLogs().map(l => l.message), [
    '圧力校正: FW 不明のため取得しません。固定式で換算',
  ]);

  const disabled = makeInsole({ profile: { pressureCalibration: { fetch: false } } });
  await disabled.ble.begin('SENSOR_VALUES', { streamingMode: 4 });
  assert.deepEqual(disabled.calibrationLogs().map(l => l.message), [
    '圧力校正: 取得無効（pressureCalibration.fetch = false）。固定式で換算',
  ]);
});
