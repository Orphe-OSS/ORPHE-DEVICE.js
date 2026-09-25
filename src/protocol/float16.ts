/**
 * IEEE 754 half-precision (binary16) の読み出し。
 *
 * CORE の STEP_ANALYSIS packet が calorie / quat / delta を float16 で運ぶ。
 * DataView の他の get* と同じく既定は big-endian。
 */
export function getFloat16(view: DataView, byteOffset: number, littleEndian = false): number {
  const bits = view.getUint16(byteOffset, littleEndian);
  const sign = bits & 0x8000 ? -1 : 1;
  const exponent = (bits >> 10) & 0x1f;
  const fraction = bits & 0x03ff;

  if (exponent === 0) {
    // ゼロ / サブノーマル（-0 も符号を保つ）
    return fraction === 0 ? sign * 0 : sign * fraction * 2 ** -24;
  }
  if (exponent === 0x1f) {
    return fraction === 0 ? sign * Infinity : NaN;
  }
  return sign * (1024 + fraction) * 2 ** (exponent - 25);
}
