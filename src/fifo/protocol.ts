/**
 * FIFO — ロスレス（欠損なし）センサーデータ収集（opt-in）。
 * プロトコルは INSOLE / CORE 共通（CORE は対応 FW が必要）。
 *
 * リアルタイムストリーミングは BLE の取りこぼしでパケットが欠落しうる。FIFO 収集は
 * FW のリングバッファに蓄積されたサンプルを「シリアル番号を指定して取り出す」
 * プル型プロトコルで回収し、通信で落ちたぶんは次のポーリングで再要求する。
 *
 * BLE プロトコル（コマンドは DEVICE_INFORMATION に write、応答は SENSOR_VALUES notify）:
 *   [0x0D, mode]                      読み取りモード変更（0x02 = FIFO）
 *   [0x0B, 0x01]                      現在シリアル取得 → 0x35 0x01 serial(2) watermark(1) accumulated(2)
 *   [0x0B, 0x02, <30×(sMSB,sLSB,cMSB,cLSB)>]  データ範囲要求（30組までpad）
 *   [0x0B, 0x03] / 0x04 / 0x06        全消去 / モニタ開始 / モニタ停止（ACK: 0x35 0x03/04/06）
 *   no-data 応答:  0x35 0x02 start(2) count(2)
 *   データパケット: 0x36 serial(2) ts(5) + 4×24B(gyro3,acc3,press6) = 104 bytes
 *
 * 注意: FIFO モードはジャイロ・加速度・6ch圧力のみでクォータニオンを含まない。
 *
 * 単位換算: gyro[dps] は LSM6DSOX のデータシート代表感度
 * 70 mdps/LSB（±2000 dps 固定、raw * 0.07）を使う。理想 Q15（/32768*2000 =
 * 61.035 mdps/LSB）とは意図的に係数 1.14688 倍だけ異なる。acc[G] の /32768*16 は
 * データシート感度 0.488 mg/LSB と一致するのでそのまま。
 *
 * フレーム間隔: decodeFifoPacket() が返すサンプルの `t` は実測 IMU
 * ODR ≈208Hz（FRAME_INTERVAL_MS≈4.8077ms/frame）で計算する。packetToCsvRows() の
 * timestamp 文字列（ミリ秒3桁）だけは既存の記録データと揃えるため、意図的に
 * LEGACY_CSV_FRAME_INTERVAL_MS（5ms/frame）のまま据え置く。CSV の timestamp から
 * dt を逆算しないこと。
 */
import { pressureToNewton } from '../protocol/pressure-calibration.ts';
import type { PressureCalibration } from '../protocol/pressure-calibration.ts';

// ── 定数 ─────────────────────────────────────────────────────────────
export const UINT16_MAX = 65536;
/** 読み取りモード変更コマンド `[0x0D, mode]` の mode 値。FIFO（ところてん）読み出しを要求する。 */
export const FIFO_READ_MODE = 0x02;
/**
 * core3 FW の 0x0D は「1: リアルタイム要求 / 2: ところてん（FIFO）要求」の2値のみで、
 * insole のストリーミングモード番号（1/3/4）とは意味が異なる。core の復帰はこの値を書く。
 */
export const CORE_REALTIME_READ_MODE = 0x01;

export const OP_INFO = 0x0b; // FIFO コマンド系（get serial / get data / delete / monitor）
export const OP_READ_MODE = 0x0d; // 読み取りモード変更
export const SUB_GET_SERIAL = 0x01;
export const SUB_GET_DATA = 0x02;
export const SUB_DELETE_ALL = 0x03;
export const SUB_START_MONITOR = 0x04;
export const SUB_STOP_MONITOR = 0x06;

export const RESP_STATUS = 0x35; // コマンド応答/no-data のヘッダ
export const RESP_DATA = 0x36; // センサーデータパケットのヘッダ
export const RESP_NO_DATA_SUB = 0x02;

/** 1 回のデータ要求 `[0x0B,0x02,...]` に載せられる (start,count) 組の最大数。 */
export const FIFO_RE_REQUEST_DATA_NUM = 30;
export const MAX_DATA_NUMBER_REQUESTED_AT_ONCE = 200;
/** 次ループへ持ち越す再要求シリアル数の上限。超えたぶんは回復不能ロスとして計上する。 */
export const FIFO_MAX_CARRY_OVER_SERIALS = 100;
/** FW 側リングバッファの保持件数の目安。これ以上追従が遅れると古いサンプルが上書きされる。 */
export const FIFO_RING_BUFFER_CAPACITY = 1500;
// drainTimeoutMs は「無音がこれだけ続いたら諦める」idle 予算。データが届き続ける間は
// 延長し、絶対上限（× CATCHUP_MAX_BUDGET_FACTOR）で打ち切る。
export const DEFAULT_DRAIN_TIMEOUT_MS = 3000;
/** 回収フェーズの絶対上限係数。`drainTimeoutMs × この値` を過ぎたら延長せず打ち切る。 */
export const FIFO_CATCHUP_MAX_BUDGET_FACTOR = 10;
export const NOTIFY_DATA_NUM = 4; // 1パケット内のフレーム数
export const NOTIFY_DATA_SIZE = 24; // 1フレームのバイト数
export const DATA_PACKET_BYTE_LENGTH = 104;

// IMU（LSM6DSOX）の実測 ODR（≈208Hz）。5ms/frame 仮定のままだとパケット内時間が
// 約4%引き伸ばされ、パケット境界で連続サンプルの dt が 0 や負になることがある。
/** IMU（LSM6DSOX）の実測 ODR [Hz]。 */
export const FIFO_IMU_ODR_HZ = 208;
/** 1 フレームぶんの時間 [ms]（≈4.8077ms）。{@link FifoSample.t} の算出に使う。 */
export const FIFO_FRAME_INTERVAL_MS = 1000 / FIFO_IMU_ODR_HZ;
/** CSV の timestamp 列専用のフレーム間隔 [ms]。既存の記録データと揃えるため 5ms 固定。 */
export const FIFO_LEGACY_CSV_FRAME_INTERVAL_MS = 5;

/** {@link rawStoreToCSV} が出力する CSV の 1 行目（列名）。 */
export const FIFO_CSV_HEADER =
  'serial_number,timestamp,' +
  'gyro_x[dps],gyro_y[dps],gyro_z[dps],' +
  'acc_x[G],acc_y[G],acc_z[G],' +
  'press1[N],press2[N],press3[N],press4[N],press5[N],press6[N]';

// ── 単位変換 ─────────────────────────────────────────────────────────
function binToInt(msb: number, lsb: number): number {
  let v = (msb << 8) + lsb;
  if (v >= 0x8000) v -= 0x10000;
  return v;
}

/**
 * ジャイロの換算係数 [dps/LSB]。FIFO は acc ±16G / gyro ±2000dps 固定で、
 * LSM6DSOX データシートの代表感度 70 mdps/LSB を使う（冒頭コメント参照）。
 */
export const FIFO_GYRO_DPS_PER_LSB = 0.07;

/** 加速度の生値（MSB,LSB）→ G。±16G 固定レンジ。 */
export function accToG(msb: number, lsb: number): number {
  return (binToInt(msb, lsb) / 32768.0) * 16.0;
}

/** ジャイロの生値（MSB,LSB）→ dps。{@link FIFO_GYRO_DPS_PER_LSB} で換算する。 */
export function gyroToDps(msb: number, lsb: number): number {
  return binToInt(msb, lsb) * FIFO_GYRO_DPS_PER_LSB;
}

/** 圧力生値(ADC uint16) → N（固定校正多項式。n は 1..6） */
export function pressureToN(x: number, n: number): number {
  let y: number;
  switch (n) {
    case 1: y = 6.31278e-11 * x ** 4 - 2.33093e-07 * x ** 3 + 3.27825e-04 * x ** 2 - 1.63373e-01 * x + 2.25012e01; break;
    case 2: y = 6.65168e-11 * x ** 4 - 2.10741e-07 * x ** 3 + 2.31937e-04 * x ** 2 - 7.10366e-02 * x + 6.97927e00; break;
    case 3: y = 1.07646e-10 * x ** 4 - 3.85112e-07 * x ** 3 + 5.02384e-04 * x ** 2 - 2.37328e-01 * x + 3.18015e01; break;
    case 4: y = 5.91156e-11 * x ** 4 - 1.81045e-07 * x ** 3 + 1.86644e-04 * x ** 2 - 4.46178e-02 * x + 3.10811e00; break;
    case 5: y = 5.32573e-11 * x ** 4 - 1.68515e-07 * x ** 3 + 1.79518e-04 * x ** 2 - 4.66859e-02 * x + 3.71484e00; break;
    case 6: y = 4.44324e-11 * x ** 4 - 1.09728e-07 * x ** 3 + 8.90389e-05 * x ** 2 + 3.82816e-03 * x - 4.46580e00; break;
    default: y = 0;
  }
  return y < 0 ? 0 : y;
}

// ── シリアル番号ユーティリティ ───────────────────────────────────────
/** start_exclusive の次から end_inclusive まで進んだ個数（wrap-around 対応） */
export function serialDistance(startExclusive: number, endInclusive: number): number {
  return (((endInclusive - startExclusive) % UINT16_MAX) + UINT16_MAX) % UINT16_MAX;
}

/** `startSerial` から `requestSize` 件ぶんの連番シリアル（wrap-around 対応）を並べる。 */
export function calcExpectedSerials(startSerial: number, requestSize: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < requestSize; i++) out.push((startSerial + i) % UINT16_MAX);
  return out;
}

/** データ要求 1 組ぶんの範囲。`[開始シリアル, 件数]`。 */
export type FifoRequestRange = [start: number, count: number];

/** (start,count) の配列を要求順の serial 配列に展開 */
export function expandRequestsToList(reqs: FifoRequestRange[]): number[] {
  const out: number[] = [];
  for (const [start, count] of reqs) {
    for (let i = 0; i < count; i++) out.push((start + i) % UINT16_MAX);
  }
  return out;
}

/** 欠損シリアルの集合を連番の塊にまとめる 例: {10,12,40,41,42} → [[10,1],[12,1],[40,3]] */
export function buildRequestsFromSerials(serials: Iterable<number>): FifoRequestRange[] {
  const sorted = Array.from(serials).sort((a, b) => a - b);
  if (sorted.length === 0) return [];
  const out: FifoRequestRange[] = [];
  let runStart = sorted[0]!;
  let runLen = 1;
  let prev = sorted[0]!;
  for (let i = 1; i < sorted.length; i++) {
    const sn = sorted[i]!;
    if (sn === (prev + 1) % UINT16_MAX) {
      runLen += 1;
    } else {
      out.push([runStart, runLen]);
      runStart = sn;
      runLen = 1;
    }
    prev = sn;
  }
  out.push([runStart, runLen]);
  return out;
}

/**
 * データ要求パケット [0x0B,0x02, 30組...] を作成（30組に満たない分は 0 埋め）。
 * FW は固定 30 スロット（2 + 30×4 = 122 bytes）前提で読むため、超過は不正パケット。
 */
export function createGetSensorDataRequest(pairs: FifoRequestRange[]): Uint8Array {
  if (pairs.length > FIFO_RE_REQUEST_DATA_NUM) {
    throw new RangeError(`createGetSensorDataRequest: too many ranges (${pairs.length} > ${FIFO_RE_REQUEST_DATA_NUM})`);
  }
  const req = [OP_INFO, SUB_GET_DATA];
  for (const [serial, count] of pairs) {
    req.push((serial >> 8) & 0xff, serial & 0xff, (count >> 8) & 0xff, count & 0xff);
  }
  for (let i = 0; i < FIFO_RE_REQUEST_DATA_NUM - pairs.length; i++) req.push(0, 0, 0, 0);
  return Uint8Array.from(req);
}

// ── 応答パースヘルパ ─────────────────────────────────────────────────
/** no-data 応答 (0x35 0x02 start(2) count(2)) → [start, count] または null */
export function parseNoDataResponse(dv: DataView): [start: number, count: number] | null {
  if (dv.byteLength < 2 || dv.getUint8(0) !== RESP_STATUS || dv.getUint8(1) !== RESP_NO_DATA_SUB) return null;
  const start = dv.byteLength >= 4 ? dv.getUint16(2) : 0;
  const count = dv.byteLength >= 6 ? dv.getUint16(4) : 0;
  return [start, count];
}

/** データパケットならシリアル番号、そうでなければ null */
export function extractSerialIfSensorPacket(dv: DataView): number | null {
  if (dv.byteLength < 3 || dv.getUint8(0) !== RESP_DATA) return null;
  return dv.getUint16(1);
}

/** 現在シリアル応答（0x35 0x01）の中身。 */
export interface FifoCurrentSerial {
  /** FW が最後に書き込んだシリアル番号（uint16。65535 の次は 0 へ wrap する） */
  serial: number;
  /** FW リングバッファの watermark 設定値 */
  watermark: number;
  /** 未回収のまま FW に溜まっている件数 */
  accumulated: number;
}

/** 現在シリアル応答 → {serial, watermark, accumulated} または null */
export function parseCurrentSerial(dv: DataView): FifoCurrentSerial | null {
  if (dv.byteLength < 7 || dv.getUint8(0) !== RESP_STATUS || dv.getUint8(1) !== SUB_GET_SERIAL) return null;
  return {
    serial: dv.getUint16(2),
    watermark: dv.getUint8(4),
    accumulated: dv.getUint16(5),
  };
}

// ── タイムスタンプ ───────────────────────────────────────────────────
function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function pad3(n: number): string {
  return String(n).padStart(3, '0');
}

/** HH:MM:SS:mmm 形式（オフセット加算・繰り上がり対応） */
export function timestampToStr(hour: number, minute: number, second: number, ms: number, offsetMs: number): string {
  ms += offsetMs || 0;
  while (ms >= 1000) { ms -= 1000; second += 1; }
  while (second >= 60) { second -= 60; minute += 1; }
  while (minute >= 60) { minute -= 60; hour += 1; }
  while (hour >= 24) { hour -= 24; }
  return `${pad2(hour)}:${pad2(minute)}:${pad2(second)}:${pad3(ms)}`;
}

/** パケット基準タイムスタンプ（ms）。ソート用（wrap-around に依存しない） */
export function extractTimestampMs(dv: DataView): number {
  const h = dv.getUint8(3);
  const m = dv.getUint8(4);
  const s = dv.getUint8(5);
  const ms = dv.getUint16(6);
  return (h * 3600 + m * 60 + s) * 1000 + ms;
}

// ── パケットデコード ─────────────────────────────────────────────────
interface FifoFrame {
  gyro: [number, number, number];
  acc: [number, number, number];
  press: [number, number, number, number, number, number];
}

// 1フレーム(24B: gyro3+acc3+press6)を物理値へ変換。decode/CSV で共用しバイト配置を一元化。
function readFrame(dv: DataView, i: number): FifoFrame {
  const o = i * NOTIFY_DATA_SIZE + 8;
  return {
    gyro: [gyroToDps(dv.getUint8(o), dv.getUint8(o + 1)), gyroToDps(dv.getUint8(o + 2), dv.getUint8(o + 3)), gyroToDps(dv.getUint8(o + 4), dv.getUint8(o + 5))],
    acc: [accToG(dv.getUint8(o + 6), dv.getUint8(o + 7)), accToG(dv.getUint8(o + 8), dv.getUint8(o + 9)), accToG(dv.getUint8(o + 10), dv.getUint8(o + 11))],
    press: [dv.getUint16(o + 12), dv.getUint16(o + 14), dv.getUint16(o + 16), dv.getUint16(o + 18), dv.getUint16(o + 20), dv.getUint16(o + 22)],
  };
}

/** FIFO の 1 サンプル（＝1 フレーム）。1 パケットに 4 サンプル入る。 */
export interface FifoSample {
  /** 由来パケットのシリアル番号 */
  serial_number: number;
  /** パケット内のフレーム位置（0..3。古い順） */
  packet_number: number;
  /** パケット基準時刻 + frame×FIFO_FRAME_INTERVAL_MS [ms]。dt 計算はこれを使うこと */
  t: number;
  /** 角速度 [dps] */
  converted_gyro: {
    /** X 軸 */ x: number;
    /** Y 軸 */ y: number;
    /** Z 軸 */ z: number;
  };
  /** 加速度 [G] */
  converted_acc: {
    /** X 軸 */ x: number;
    /** Y 軸 */ y: number;
    /** Z 軸 */ z: number;
  };
  /** 6ch 圧力。値は ADC 生値（uint16）で、N へは {@link pressureToN} で換算する。 */
  press: {
    /** 1..6ch の圧力生値 */ values: number[];
    /** 由来パケットのシリアル番号 */ serial_number: number;
    /** パケット内のフレーム位置 */ packet_number: number;
  };
}

/** 1 データパケット（0x36）をデコードした結果。 */
export interface FifoPacket {
  /** パケットのシリアル番号 */
  serial: number;
  /** パケット基準時刻 [ms]（その日の 0 時からの経過ミリ秒） */
  timestamp: number;
  /** 4 フレームぶんのサンプル（古い順） */
  samples: FifoSample[];
}

/**
 * 1データパケット(0x36) → 4フレームのサンプル配列（ライブ可視化用）。
 * フレームは古い順（i=3 が基準、以降 +FIFO_FRAME_INTERVAL_MS）。出力もその順。
 */
export function decodeFifoPacket(dv: DataView): FifoPacket {
  const serial = dv.getUint16(1);
  const baseMs = extractTimestampMs(dv);
  const samples: FifoSample[] = [];
  for (let i = NOTIFY_DATA_NUM - 1; i >= 0; i--) {
    const packet_number = NOTIFY_DATA_NUM - 1 - i;
    const f = readFrame(dv, i);
    samples.push({
      serial_number: serial,
      packet_number,
      t: baseMs + packet_number * FIFO_FRAME_INTERVAL_MS,
      converted_gyro: { x: f.gyro[0], y: f.gyro[1], z: f.gyro[2] },
      converted_acc: { x: f.acc[0], y: f.acc[1], z: f.acc[2] },
      press: { values: f.press, serial_number: serial, packet_number },
    });
  }
  return { serial, timestamp: baseMs, samples };
}

function f2(v: number): string {
  return v.toFixed(2).padStart(8);
}

function f4(v: number): string {
  return v.toFixed(4).padStart(8);
}

/**
 * 1データパケット → CSV 4行。timestamp 列は意図的に
 * FIFO_LEGACY_CSV_FRAME_INTERVAL_MS（5ms/frame）のまま据え置く（冒頭コメント参照）。
 */
export function packetToCsvRows(
  dv: DataView,
  calibrations: readonly (PressureCalibration | null)[] | null = null
): string[] {
  // 個体別係数があれば ch ごとにそれで N に換算し、なければ固定多項式
  const toN = (raw: number, i: number): number =>
    calibrations ? pressureToNewton(raw, calibrations[i]) : pressureToN(raw, i + 1);
  const serial = dv.getUint16(1);
  const h = dv.getUint8(3);
  const m = dv.getUint8(4);
  const s = dv.getUint8(5);
  const ms = dv.getUint16(6);
  const rows: string[] = [];
  for (let i = NOTIFY_DATA_NUM - 1; i >= 0; i--) {
    const offsetMs = (NOTIFY_DATA_NUM - 1 - i) * FIFO_LEGACY_CSV_FRAME_INTERVAL_MS;
    const f = readFrame(dv, i);
    rows.push([
      String(serial), timestampToStr(h, m, s, ms, offsetMs),
      f2(f.gyro[0]), f2(f.gyro[1]), f2(f.gyro[2]),
      f4(f.acc[0]), f4(f.acc[1]), f4(f.acc[2]),
      f4(toN(f.press[0], 0)), f4(toN(f.press[1], 1)), f4(toN(f.press[2], 2)),
      f4(toN(f.press[3], 3)), f4(toN(f.press[4], 4)), f4(toN(f.press[5], 5)),
    ].join(', '));
  }
  return rows;
}

/** 収集した raw ストア（Map<serial, DataView>）を timestamp 順に並べて CSV 文字列化 */
export function rawStoreToCSV(
  rawStore: Map<number, DataView>,
  calibrations: readonly (PressureCalibration | null)[] | null = null
): string {
  const entries = Array.from(rawStore.values());
  entries.sort((a, b) => extractTimestampMs(a) - extractTimestampMs(b));
  const lines = [FIFO_CSV_HEADER];
  for (const dv of entries) {
    if (dv.byteLength < 1 || dv.getUint8(0) !== RESP_DATA) continue;
    for (const row of packetToCsvRows(dv, calibrations)) lines.push(row);
  }
  return lines.join('\n') + '\n';
}
