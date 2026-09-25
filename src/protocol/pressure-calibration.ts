/**
 * ORPHE INSOLE の個体別圧力校正係数。
 *
 * 対応 FW は製造時に測った 6ch ぶんの校正係数を保持しており、
 * DEVICE_INFORMATION へ要求を書くと SENSOR_VALUES の notify で 1ch ずつ返す。
 * ここはその codec と、係数を使った ADC 生値 → 圧力 [N] の換算だけを持つ。
 * 取得の手続き（write → notify 待ち → 再試行）は profiles/insole.ts が行う。
 */

/** 圧力センサーのチャンネル数 */
export const PRESSURE_SENSOR_COUNT = 6;

/** 校正係数の notify ヘッダ */
export const PRESSURE_CALIBRATION_NOTIFY_HEADER = 0x39;

/** 校正係数の notify ペイロード長 [byte]（ヘッダ + ch + func + double × 5） */
export const PRESSURE_CALIBRATION_PAYLOAD_LENGTH = 1 + 1 + 1 + 8 * 5;

const REQUEST_COMMAND = 0x10;
const REQUEST_ACTION = 0x00;
const COEFFICIENT_COUNT = 5;

/** 1ch ぶんの校正係数 */
export interface PressureCalibration {
  /**
   * 換算式の種類。
   * - `0`: `y = c1·exp(c2·x) + c3`
   * - `1`: `y = c1·x⁴ + c2·x³ + c3·x² + c4·x + c5`
   */
  func: number;
  /** 係数 `[c1, c2, c3, c4, c5]` */
  coefficients: number[];
}

/** 1ch ぶんの校正係数取得要求（DEVICE_INFORMATION へ write する） */
export function encodePressureCalibrationRequest(sensorIndex: number): Uint8Array {
  if (!Number.isInteger(sensorIndex) || sensorIndex < 0 || sensorIndex >= PRESSURE_SENSOR_COUNT) {
    throw new RangeError(`sensorIndex must be 0..${PRESSURE_SENSOR_COUNT - 1}: ${sensorIndex}`);
  }
  return Uint8Array.from([REQUEST_COMMAND, REQUEST_ACTION, sensorIndex]);
}

/** SENSOR_VALUES の notify が校正係数の応答かどうか（先頭バイトで判定） */
export function isPressureCalibrationPacket(data: DataView): boolean {
  return data.byteLength > 0 && data.getUint8(0) === PRESSURE_CALIBRATION_NOTIFY_HEADER;
}

/**
 * 校正係数の notify をデコードする。
 * ヘッダ違いや長さ不足は null。
 */
export function decodePressureCalibration(
  data: DataView
): { sensorIndex: number; calibration: PressureCalibration } | null {
  if (!isPressureCalibrationPacket(data)) return null;
  if (data.byteLength < PRESSURE_CALIBRATION_PAYLOAD_LENGTH) return null;
  const coefficients: number[] = [];
  for (let i = 0; i < COEFFICIENT_COUNT; i++) {
    coefficients.push(data.getFloat64(3 + 8 * i));
  }
  return {
    sensorIndex: data.getUint8(1),
    calibration: { func: data.getUint8(2), coefficients },
  };
}

/**
 * FW に校正値が書かれていないときに返るプレースホルダかどうか。
 * `func = 0` かつ係数が全部 `1.0` のときは個体別係数として扱わず、旧式へ戻す。
 */
export function isPressureCalibrationPlaceholder(calibration: PressureCalibration): boolean {
  return (
    calibration.func === 0 &&
    calibration.coefficients.length === COEFFICIENT_COUNT &&
    calibration.coefficients.every(c => c === 1)
  );
}

/**
 * 校正係数で ADC 生値を圧力 [N] に換算する。
 * 負・NaN・無限大・未知の func は 0。
 */
export function applyPressureCalibration(calibration: PressureCalibration, adcRaw: number): number {
  const c = calibration.coefficients;
  let y: number;
  switch (calibration.func) {
    case 0:
      if (c.length < 3) return 0;
      y = c[0]! * Math.exp(c[1]! * adcRaw) + c[2]!;
      break;
    case 1: {
      if (c.length < 5) return 0;
      const x2 = adcRaw * adcRaw;
      const x3 = x2 * adcRaw;
      const x4 = x3 * adcRaw;
      y = c[0]! * x4 + c[1]! * x3 + c[2]! * x2 + c[3]! * adcRaw + c[4]!;
      break;
    }
    default:
      return 0;
  }
  if (!Number.isFinite(y) || y < 0) return 0;
  return y;
}

// 旧 FW 向けの固定式。ADC 生値を mV に直してから指数式に通す
const LEGACY_C1 = 2.77942;
const LEGACY_C2 = 2.08348e-3;
const LEGACY_C3 = 4.14411;
/** ノイズフロア [mV]。これ以下は「踏んでいない」として 0 にする */
const LEGACY_THRESHOLD_MV = 240;
const ADC_REFERENCE_VOLT = 3.3;
const ADC_FULL_SCALE = 4096;

/**
 * 個体別係数を持たない FW 向けの換算。
 * `mV = adc × 3.3 / 4096 × 1000` に直し、240 mV 以下は 0、
 * それ以上は `c1·exp(c2·mV) + c3`。
 */
export function legacyPressureToNewton(adcRaw: number): number {
  const mV = (adcRaw * ADC_REFERENCE_VOLT / ADC_FULL_SCALE) * 1000;
  if (mV <= LEGACY_THRESHOLD_MV) return 0;
  const y = LEGACY_C1 * Math.exp(LEGACY_C2 * mV) + LEGACY_C3;
  return y < 0 ? 0 : y;
}

/**
 * ADC 生値を圧力 [N] に換算する。
 * 係数があればそれを使い、null やプレースホルダなら旧式へフォールバックする。
 */
export function pressureToNewton(adcRaw: number, calibration: PressureCalibration | null | undefined): number {
  if (calibration && !isPressureCalibrationPlaceholder(calibration)) {
    return applyPressureCalibration(calibration, adcRaw);
  }
  return legacyPressureToNewton(adcRaw);
}
