/** GET_FW_NAME の read 結果を模したペイロード（テスト用） */
import { FW_NAME_BYTE_LENGTH } from '../../src/protocol/fw-info.ts';

export function fwPayload(year: number, month: number, day: number): DataView {
  const dv = new DataView(new ArrayBuffer(FW_NAME_BYTE_LENGTH));
  const buildId = 'OL4R535xxBCTTRT';
  for (let i = 0; i < buildId.length; i++) dv.setUint8(i, buildId.charCodeAt(i));
  dv.setUint8(15, 3);
  dv.setUint16(16, 1);
  dv.setUint16(18, year);
  dv.setUint8(20, month);
  dv.setUint8(21, day);
  dv.setUint8(22, 1);
  return dv;
}
