/** 圧力校正係数の notify（0x39 応答）を模したペイロード（テスト用） */
import { PRESSURE_CALIBRATION_PAYLOAD_LENGTH } from '../../src/protocol/pressure-calibration.ts';

export function calibrationPayload(sensorIndex: number, func: number, coefficients: number[]): DataView {
  const dv = new DataView(new ArrayBuffer(PRESSURE_CALIBRATION_PAYLOAD_LENGTH));
  dv.setUint8(0, 0x39);
  dv.setUint8(1, sensorIndex);
  dv.setUint8(2, func);
  coefficients.forEach((c, i) => dv.setFloat64(3 + 8 * i, c));
  return dv;
}
