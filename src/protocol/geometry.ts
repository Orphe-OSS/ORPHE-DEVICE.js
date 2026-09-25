/**
 * 幾何の共通型（Vec3 / Quat）と、quaternion → Euler 角変換・正規化。
 *
 * 注意: 変換結果を bit 単位で固定するため、
 * 式の形・演算順序を固定している。数学的に等価でも書き換えないこと。
 */

/** 3軸ベクトル（acc / gyro / stride 等の共通形状） */
export interface Vec3 {
  /** X 成分 */
  x: number;
  /** Y 成分 */
  y: number;
  /** Z 成分 */
  z: number;
}

/** クォータニオン（w, x, y, z） */
export interface Quat {
  /** 実部 */
  w: number;
  /** 虚部 X */
  x: number;
  /** 虚部 Y */
  y: number;
  /** 虚部 Z */
  z: number;
}

/** Euler 角（ラジアン）。 */
export interface EulerAngles {
  /** X軸回転 [rad] */
  roll: number;
  /** Y軸回転 [rad] */
  pitch: number;
  /** Z軸回転 [rad] */
  yaw: number;
}

/** |q|=1 を仮定した Euler 角変換。ジンバルロックは pitch を ±π/2 にクランプ */
export function quatToEuler(q: Quat): EulerAngles {
  const w = q.w;
  const x = q.x;
  const y = q.y;
  const z = q.z;

  const t = 2 * (w * y - z * x);

  return {
    roll: Math.atan2(2 * (w * x + y * z), 1 - 2 * (x * x + y * y)),
    pitch: t >= 1 ? Math.PI / 2 : (t <= -1 ? -Math.PI / 2 : Math.asin(t)),
    yaw: Math.atan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z)),
  };
}

const CORE_NORMALIZE_EPSILON = 1e-16;

/**
 * CORE 系の正規化（header 40 の euler 計算用）。
 * ノルムは Math.sqrt(w*w + x*x + y*y + z*z)、EPSILON 未満はゼロ quat。
 * 除算ではなく逆数（1/norm）の乗算で正規化する: 除算とは丸めが異なり、
 * 配送値が変わるため演算を変えないこと。
 */
export function normalizeQuaternionCoreStyle(q: Quat): Quat {
  const w = q.w;
  const x = q.x;
  const y = q.y;
  const z = q.z;
  let norm = Math.sqrt(w * w + x * x + y * y + z * z);
  if (norm < CORE_NORMALIZE_EPSILON) {
    return { w: 0, x: 0, y: 0, z: 0 };
  }
  norm = 1 / norm;
  return { w: w * norm, x: x * norm, y: y * norm, z: z * norm };
}

/**
 * INSOLE 系の正規化。
 * ノルムは Math.hypot（sqrt とは丸めが異なる）、非有限・Number.EPSILON 以下はゼロ quat。
 */
export function normalizeQuaternionInsoleStyle(q: Quat): Quat {
  const norm = Math.hypot(q.w, q.x, q.y, q.z);
  if (!Number.isFinite(norm) || norm <= Number.EPSILON) {
    return { w: 0, x: 0, y: 0, z: 0 };
  }
  return {
    w: q.w / norm,
    x: q.x / norm,
    y: q.y / norm,
    z: q.z / norm,
  };
}
