/**
 * ORPHE CORE の取得モード一覧と、FW リリース日によるしきい値。
 *
 * しきい値を変えるのはこのファイルだけで済む。判定そのものは
 * {@link OrpheDevice.availableModes} が行い、FIFO は {@link FifoRecorder.start} がそれを見て開始を断る。
 */
import type { DeviceMode } from '../device/profile.ts';

/**
 * FIFO 収録に対応した CORE FW の最小リリース日（`YYYYMMDD`）。
 * これより古い FW は FIFO のコマンドに応答しないため、モード候補から外す。
 */
export const CORE_FIFO_MIN_RELEASE_DATE = 20260905;

/** CORE の取得モード一覧（FW による絞り込み前） */
export const CORE_MODES: readonly DeviceMode[] = Object.freeze([
  Object.freeze({ id: 'STEP_ANALYSIS_AND_SENSOR_VALUES', label: 'Step analysis + sensor values', minReleaseDate: 0 }),
  Object.freeze({ id: 'STEP_ANALYSIS', label: 'Step analysis', minReleaseDate: 0 }),
  Object.freeze({ id: 'SENSOR_VALUES', label: 'Sensor values', minReleaseDate: 0 }),
  Object.freeze({ id: 'FIFO', label: 'Lossless FIFO recording', minReleaseDate: CORE_FIFO_MIN_RELEASE_DATE }),
]);
