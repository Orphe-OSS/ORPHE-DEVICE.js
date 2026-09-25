/**
 * ORPHE INSOLE の取得モード一覧と、FW リリース日によるしきい値。
 *
 * しきい値を変えるのはこのファイルだけで済む。判定そのものは
 * {@link OrpheCoreInsole.availableModes} が行い、FIFO は {@link FifoRecorder.start} がそれを見て開始を断る。
 */
import type { DeviceMode } from '../device/profile.ts';

/** SENSOR_VALUES のリアルタイム配信モード仕様 */
export const INSOLE_STREAMING_MODES = Object.freeze({
  1: Object.freeze({
    id: 1,
    sampleHz: 200,
    packetHz: 50,
    fields: Object.freeze({ quat: true, gyro: true, acc: true, press: false }),
    label: 'Orientation 200 Hz',
  }),
  3: Object.freeze({
    id: 3,
    sampleHz: 200,
    packetHz: 50,
    fields: Object.freeze({ quat: false, gyro: true, acc: true, press: true }),
    label: 'Pressure + IMU 200 Hz',
  }),
  4: Object.freeze({
    id: 4,
    sampleHz: 100,
    packetHz: 50,
    fields: Object.freeze({ quat: true, gyro: true, acc: true, press: true }),
    label: 'Full sensor 100 Hz',
  }),
} as Record<number, {
  /** モード番号 */
  id: number;
  /** センサーのサンプリング周波数 [Hz] */
  sampleHz: number;
  /** BLE パケットの送出周波数 [Hz] */
  packetHz: number;
  /** そのモードで届くフィールド */
  fields: {
    /** クォータニオンを含むか */ quat: boolean;
    /** ジャイロを含むか */ gyro: boolean;
    /** 加速度を含むか */ acc: boolean;
    /** 圧力を含むか */ press: boolean;
  };
  /** UI 表示用のラベル */
  label: string;
}>);

/**
 * INSOLE の取得モード一覧（FW による絞り込み前）。
 * `STREAMING_*` は SENSOR_VALUES のリアルタイム配信、`STEP_ANALYSIS` は歩容解析、
 * `FIFO` はロスレス収録に対応する。
 */

/**
 * FIFO 収録に対応した INSOLE FW の最小リリース日（`YYYYMMDD`）。
 * これより古い FW は FIFO のコマンドに応答しないため、モード候補から外す。
 */
export const INSOLE_FIFO_MIN_RELEASE_DATE = 20260510;

/**
 * 個体別の圧力校正係数を持つ INSOLE FW の最小リリース日（`YYYYMMDD`）。
 * これ以降の FW では begin() で係数を取得し、圧力の N 換算に使う。
 * それより古い FW（および FW 不明）は固定式で換算する。
 */
export const INSOLE_PRESSURE_CALIBRATION_MIN_RELEASE_DATE = 20260428;

/**
 * INSOLE の取得モード一覧（FW による絞り込み前）。
 * `STREAMING_*` は SENSOR_VALUES のリアルタイム配信、`STEP_ANALYSIS` は歩容解析、
 * `FIFO` はロスレス収録に対応する。
 */
export const INSOLE_MODES: readonly DeviceMode[] = Object.freeze([
  Object.freeze({ id: 'STREAMING_4', label: INSOLE_STREAMING_MODES[4]!.label, minReleaseDate: 0 }),
  Object.freeze({ id: 'STREAMING_3', label: INSOLE_STREAMING_MODES[3]!.label, minReleaseDate: 0 }),
  Object.freeze({ id: 'STREAMING_1', label: INSOLE_STREAMING_MODES[1]!.label, minReleaseDate: 0 }),
  Object.freeze({ id: 'STEP_ANALYSIS', label: 'Gait analysis', minReleaseDate: 0 }),
  Object.freeze({ id: 'FIFO', label: 'Lossless FIFO recording', minReleaseDate: INSOLE_FIFO_MIN_RELEASE_DATE }),
]);

/**
 * `STREAMING_*` のモード id → streaming mode 番号。
 * それ以外の id では null（begin() の streamingMode 指定には使わない）。
 */
export function insoleStreamingModeOf(id: string): number | null {
  const matched = /^STREAMING_(\d+)$/.exec(id);
  if (!matched) return null;
  const mode = Number(matched[1]);
  return INSOLE_STREAMING_MODES[mode] ? mode : null;
}
