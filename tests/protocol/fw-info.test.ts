/**
 * FirmwareInfo: GET_FW_NAME のデコードとリリース日の取り出し。
 * ペイロードは ASCII 部と数値部の混在で、全体をテキスト化すると後半が化ける。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeFirmwareInfo, firmwareReleaseDate, FW_NAME_BYTE_LENGTH } from '../../src/protocol/fw-info.ts';

function fwName(options: {
  buildId?: string;
  major?: number;
  minor?: number;
  year?: number;
  month?: number;
  day?: number;
  patch?: number;
} = {}): DataView {
  const buildId = (options.buildId ?? 'OL4R535xxBCTTRT').padEnd(15, '\0');
  const dv = new DataView(new ArrayBuffer(FW_NAME_BYTE_LENGTH));
  for (let i = 0; i < 15; i++) dv.setUint8(i, buildId.charCodeAt(i));
  dv.setUint8(15, options.major ?? 3);
  dv.setUint16(16, options.minor ?? 1);
  dv.setUint16(18, options.year ?? 2026);
  dv.setUint8(20, options.month ?? 9);
  dv.setUint8(21, options.day ?? 5);
  dv.setUint8(22, options.patch ?? 1);
  return dv;
}

test('decodeFirmwareInfo: ASCII 部と数値部を分けて読む', () => {
  const info = decodeFirmwareInfo(fwName());
  assert.ok(info);
  assert.equal(info.buildId, 'OL4R535xxBCTTRT');
  assert.equal(info.major, 3);
  assert.equal(info.minor, 1);
  assert.equal(info.patch, 1);
});

test('decodeFirmwareInfo: リリース日は YYYYMMDD の整数で比較できる', () => {
  const info = decodeFirmwareInfo(fwName({ year: 2026, month: 9, day: 5 }));
  assert.equal(info?.releaseDate, 20260905);
  assert.equal(info!.releaseDate >= 20260101, true);
  assert.equal(info!.releaseDate >= 20270101, false);
});

test('decodeFirmwareInfo: 月日が 1 桁でもゼロ埋めして桁を揃える', () => {
  assert.equal(decodeFirmwareInfo(fwName({ year: 2026, month: 2, day: 7 }))?.releaseDate, 20260207);
});

test('decodeFirmwareInfo: releasedAt はローカルタイムの 00:00', () => {
  const info = decodeFirmwareInfo(fwName({ year: 2026, month: 9, day: 5 }));
  assert.equal(info?.releasedAt.getFullYear(), 2026);
  assert.equal(info?.releasedAt.getMonth(), 8);
  assert.equal(info?.releasedAt.getDate(), 5);
});

test('decodeFirmwareInfo: name は表示用のビルド名を組み立てる', () => {
  assert.equal(decodeFirmwareInfo(fwName())?.name, 'OL4R535xxBCTTRT-3-0001-20260905-01');
});

test('decodeFirmwareInfo: 長さ不足は null', () => {
  assert.equal(decodeFirmwareInfo(new DataView(new ArrayBuffer(FW_NAME_BYTE_LENGTH - 1))), null);
});

test('decodeFirmwareInfo: 日付が不正な値なら null（未書込・別フォーマット）', () => {
  assert.equal(decodeFirmwareInfo(fwName({ year: 0 })), null);
  assert.equal(decodeFirmwareInfo(fwName({ month: 13 })), null);
  assert.equal(decodeFirmwareInfo(fwName({ day: 0 })), null);
});

test('decodeFirmwareInfo: ASCII 部が短い個体でも日付は読める', () => {
  const info = decodeFirmwareInfo(fwName({ buildId: 'OL4R5' }));
  assert.equal(info?.buildId, 'OL4R5');
  assert.equal(info?.releaseDate, 20260905);
});

test('firmwareReleaseDate: 未取得（null）はリリース日不明として null', () => {
  assert.equal(firmwareReleaseDate(null), null);
  assert.equal(firmwareReleaseDate(decodeFirmwareInfo(fwName())), 20260905);
});
