/**
 * STEP_ANALYSIS パケットの型とデコード（INSOLE）。
 *
 * パケット（20byte, big-endian）: byte[0]=51, byte[1]=サブヘッダー
 * （0=概要 / 1=ストライド / 2=プロネーション / 4=motion）, byte[2..3]=step_number。
 * 状態を持たない純関数のみ。
 */
import { getFloat16 } from '../protocol/float16.ts';

// ── 定数 ─────────────────────────────────────────────────────────────
/** STEP_ANALYSIS パケットのヘッダーバイト */
export const GAIT_PACKET_HEADER = 51;
/** STEP_ANALYSIS パケットの長さ [byte] */
export const GAIT_PACKET_LENGTH = 20;

/** 歩行タイプの分類値 → 名称 */
export const GAIT_TYPES = Object.freeze(['none', 'walk', 'run', 'stance']);
/** ストライド方向の分類値 → 名称 */
export const STRIDE_DIRECTIONS = Object.freeze(['none', 'forward', 'backward', 'inside', 'outside']);

// foot strike / pronation の分類しきい値（FW 側の解析と揃える）
const FOOT_STRIKE_MID_THRESHOLD = -3.0;
const FOOT_STRIKE_FORE_THRESHOLD = 2.0;
const PRONATION_AVERAGE = -9.4;
const PRONATION_STD = 3.5;

// ── サニタイズ ───────────────────────────────────────────────────────
// NaN / Inf は「値が未確定」を意味するため null に丸める。
function sanitize(v: number): number | null {
  if (Number.isNaN(v) || !Number.isFinite(v)) return null;
  return v;
}

// 本来「非負」の量（時間・距離・カロリー・衝撃）向け。FW は未確定値に -1 sentinel を
// 入れることがあるため、負値も欠損として null に丸める
// （角度・ベクトルなど負値が正当なフィールドには使わない）。
function sanitizeNonNeg(v: number): number | null {
  const s = sanitize(v);
  return s === null || s < 0 ? null : s;
}

// ── 分類ヘルパ ───────────────────────────────────────────────────────
/** 歩行タイプの分類値 → 名称（{@link GAIT_TYPES}）。範囲外は `'unknown'`。 */
export function gaitTypeToStr(v: number): string {
  return v >= 0 && v < GAIT_TYPES.length ? GAIT_TYPES[v]! : 'unknown';
}

/** ストライド方向の分類値 → 名称（{@link STRIDE_DIRECTIONS}）。範囲外は `'unknown'`。 */
export function strideDirectionToStr(v: number): string {
  return v >= 0 && v < STRIDE_DIRECTIONS.length ? STRIDE_DIRECTIONS[v]! : 'unknown';
}

/** 着地時の足角度（pronationX）から接地パターンを判定 */
export function footStrikeToStr(strikeAngle: number | null | undefined): string {
  if (strikeAngle === null || strikeAngle === undefined) return 'none';
  if (strikeAngle > FOOT_STRIKE_FORE_THRESHOLD) return 'forefoot';
  if (strikeAngle > FOOT_STRIKE_MID_THRESHOLD) return 'midfoot';
  return 'heelStrike';
}

/** プロネーション角（pronationY）から種別を判定 */
export function pronationToStr(pronationY: number | null | undefined): string {
  if (pronationY === null || pronationY === undefined) return 'none';
  const ave = PRONATION_AVERAGE;
  const std = PRONATION_STD;
  if (pronationY >= ave - std && pronationY <= ave + std) return 'neutral';
  if (pronationY > ave + std && pronationY <= ave + std * 3) return 'over';
  if (pronationY > ave + std * 3) return 'severeOver';
  if (pronationY >= ave - std * 3 && pronationY < ave - std) return 'under';
  if (pronationY < ave - std * 3) return 'severeUnder';
  return 'none';
}

// ── パケット型 ───────────────────────────────────────────────────────
/** STEP_ANALYSIS パケット共通部 */
export interface GaitPacketBase {
  /** サブヘッダー（0=概要 / 1=ストライド / 2=プロネーション / 4=motion） */
  subheader: number;
  /** 歩番号（uint16、wraparound あり） */
  step_number: number;
}

/** 歩容概要パケット（sub 0）。null は FW 側で未確定の値 */
export interface GaitOverviewPacket extends GaitPacketBase {
  /** 判別用タグ */
  type: 'overview';
  /** 歩行タイプ名（GAIT_TYPES） */
  gait_type: string;
  /** ストライド方向名（STRIDE_DIRECTIONS） */
  stride_direction: string;
  /** 消費カロリー */
  calorie: number | null;
  /** 距離 [m] */
  distance_m: number | null;
  /** 立脚期時間 [s] */
  stance_phase_s: number | null;
  /** 遊脚期時間 [s] */
  swing_phase_s: number | null;
}

/** ストライドパケット（sub 1） */
export interface GaitStridePacket extends GaitPacketBase {
  /** 判別用タグ */
  type: 'stride';
  /** 着地時の足角度 [deg] */
  foot_angle: number | null;
  /** ストライド X 成分 [m] */
  stride_x: number | null;
  /** ストライド Y 成分 [m] */
  stride_y: number | null;
  /** ストライド Z 成分 [m] */
  stride_z: number | null;
}

/** プロネーションパケット（sub 2） */
export interface GaitPronationPacket extends GaitPacketBase {
  /** 判別用タグ */
  type: 'pronation';
  /** 着地衝撃 */
  landing_force: number | null;
  /** 着地角度 X（foot strike 判定に使用） [deg] */
  pronation_x: number | null;
  /** プロネーション角 Y（種別判定に使用） [deg] */
  pronation_y: number | null;
  /** プロネーション角 Z [deg] */
  pronation_z: number | null;
}

/**
 * モーションパケット（sub 4）。歩ごとのイベントではなく、STEP_ANALYSIS の
 * 全パケットに載る連続ストリーム（姿勢クォータニオン + 変位差分）。
 */
export interface GaitMotionPacket extends GaitPacketBase {
  /** 判別用タグ */
  type: 'motion';
  /** 歩行周期のフェーズ分類値 */
  gait_cycle_phase: number;
  /** 歩行周期の区間分類値 */
  gait_cycle_period: number;
  /** 歩行周期イベントの分類値 */
  gait_cycle_event: number;
  /** 姿勢クォータニオン W 成分 */
  quat_w: number | null;
  /** 姿勢クォータニオン X 成分 */
  quat_x: number | null;
  /** 姿勢クォータニオン Y 成分 */
  quat_y: number | null;
  /** 姿勢クォータニオン Z 成分 */
  quat_z: number | null;
  /** 前パケットからの変位 X 成分 [m] */
  delta_x: number | null;
  /** 前パケットからの変位 Y 成分 [m] */
  delta_y: number | null;
  /** 前パケットからの変位 Z 成分 [m] */
  delta_z: number | null;
}

/** サブヘッダーで判別する STEP_ANALYSIS パケットの union。 */
export type GaitPacket = GaitOverviewPacket | GaitStridePacket | GaitPronationPacket | GaitMotionPacket;

// ── デコード ─────────────────────────────────────────────────────────
function decodeOverview(dv: DataView, step: number): GaitOverviewPacket {
  const b = dv.getUint8(4);
  return {
    type: 'overview',
    subheader: 0,
    step_number: step,
    gait_type: gaitTypeToStr((b >> 6) & 0b11),
    stride_direction: strideDirectionToStr((b >> 3) & 0b111),
    calorie: sanitizeNonNeg(getFloat16(dv, 6)),
    distance_m: sanitizeNonNeg(dv.getFloat32(8, false)),
    stance_phase_s: sanitizeNonNeg(dv.getFloat32(12, false)),
    swing_phase_s: sanitizeNonNeg(dv.getFloat32(16, false)),
  };
}

function decodeStride(dv: DataView, step: number): GaitStridePacket {
  return {
    type: 'stride',
    subheader: 1,
    step_number: step,
    foot_angle: sanitize(dv.getFloat32(4, false)),
    stride_x: sanitize(dv.getFloat32(8, false)),
    stride_y: sanitize(dv.getFloat32(12, false)),
    stride_z: sanitize(dv.getFloat32(16, false)),
  };
}

function decodePronation(dv: DataView, step: number): GaitPronationPacket {
  return {
    type: 'pronation',
    subheader: 2,
    step_number: step,
    landing_force: sanitizeNonNeg(dv.getFloat32(4, false)),
    pronation_x: sanitize(dv.getFloat32(8, false)),
    pronation_y: sanitize(dv.getFloat32(12, false)),
    pronation_z: sanitize(dv.getFloat32(16, false)),
  };
}

function decodeMotion(dv: DataView, step: number): GaitMotionPacket {
  const b = dv.getUint8(4);
  return {
    type: 'motion',
    subheader: 4,
    step_number: step,
    gait_cycle_phase: (b >> 6) & 0b11,
    gait_cycle_period: (b >> 3) & 0b111,
    gait_cycle_event: b & 0b111,
    quat_w: sanitize(getFloat16(dv, 6)),
    quat_x: sanitize(getFloat16(dv, 8)),
    quat_y: sanitize(getFloat16(dv, 10)),
    quat_z: sanitize(getFloat16(dv, 12)),
    delta_x: sanitize(getFloat16(dv, 14)),
    delta_y: sanitize(getFloat16(dv, 16)),
    delta_z: sanitize(getFloat16(dv, 18)),
  };
}

/**
 * 歩容解析パケット（20byte）を1件デコードする。
 * 解析パケットでない場合（ヘッダー不一致・長さ不足・未知サブヘッダー）は null。
 */
export function decodeGaitPacket(dv: DataView): GaitPacket | null {
  if (dv.byteLength < GAIT_PACKET_LENGTH) return null;
  if (dv.getUint8(0) !== GAIT_PACKET_HEADER) return null;
  const subheader = dv.getUint8(1);
  const step = dv.getUint16(2, false);
  switch (subheader) {
    case 0: return decodeOverview(dv, step);
    case 1: return decodeStride(dv, step);
    case 2: return decodePronation(dv, step);
    case 4: return decodeMotion(dv, step);
    default: return null;
  }
}
