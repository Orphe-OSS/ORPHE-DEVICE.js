/**
 * IEEE 754 half-precision (binary16) デコーダ。
 * CORE の STEP_ANALYSIS（calorie / quat / delta）が float16 を使う。
 * 読み出しのみ必要なので自前実装する（DataView と同じく既定 big-endian）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getFloat16 } from '../../src/protocol/float16.ts';

function viewOf(...bytes: number[]): DataView {
  return new DataView(Uint8Array.from(bytes).buffer);
}

test('代表値のデコード', () => {
  assert.equal(getFloat16(viewOf(0x3c, 0x00), 0), 1.0);
  assert.equal(getFloat16(viewOf(0xc0, 0x00), 0), -2.0);
  assert.equal(getFloat16(viewOf(0x38, 0x00), 0), 0.5);
  assert.equal(getFloat16(viewOf(0x00, 0x00), 0), 0);
  assert.equal(getFloat16(viewOf(0x80, 0x00), 0), -0);
  assert.equal(getFloat16(viewOf(0x7b, 0xff), 0), 65504); // 最大正規化数
  assert.equal(getFloat16(viewOf(0x3c, 0x01), 0), 1 + 1 / 1024); // 1.0 の次の値
});

test('非正規化数・無限大・NaN', () => {
  assert.equal(getFloat16(viewOf(0x00, 0x01), 0), 2 ** -24); // 最小サブノーマル
  assert.equal(getFloat16(viewOf(0x03, 0xff), 0), 1023 * 2 ** -24); // 最大サブノーマル
  assert.equal(getFloat16(viewOf(0x7c, 0x00), 0), Infinity);
  assert.equal(getFloat16(viewOf(0xfc, 0x00), 0), -Infinity);
  assert.ok(Number.isNaN(getFloat16(viewOf(0x7c, 0x01), 0)));
  assert.ok(Number.isNaN(getFloat16(viewOf(0xfe, 0x00), 0)));
});

test('offset 指定で途中から読める', () => {
  const dv = viewOf(0xff, 0xff, 0x3c, 0x00);
  assert.equal(getFloat16(dv, 2), 1.0);
});

test('往復: Float16Array 相当の値域でエンコード→デコードが一致する', () => {
  // JS 標準の Math.fround の half 版は無いため、代表的な値で手計算と比較
  const cases: Array<[number, number]> = [
    [0x4248, 3.140625],   // π の half 近似
    [0x3555, 0.333251953125],
    [0xb800, -0.5],
    [0x6400, 1024],
  ];
  for (const [bits, expected] of cases) {
    assert.equal(getFloat16(viewOf(bits >> 8, bits & 0xff), 0), expected, `0x${bits.toString(16)}`);
  }
});
