/**
 * DATE_TIME のワイヤ形式（7 バイト）の encode / decode。
 * 時刻同期の手続きは tests/device/time-sync.test.ts。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeDateTime, encodeDateTime } from '../../src/protocol/datetime.ts';

test('encodeDateTime: [YY, MM, DD, hh, mm, ss, ss/10] の7バイト', () => {
  const date = new Date(2026, 8, 4, 12, 34, 56, 780); // 2026-09-04 12:34:56.780
  const bytes = encodeDateTime(date);
  assert.deepEqual([...bytes], [26, 9, 4, 12, 34, 56, 78]);
});

test('decodeDateTime: encode の逆変換（10ms 精度）', () => {
  const date = new Date(2026, 8, 4, 12, 34, 56, 780);
  const bytes = encodeDateTime(date);
  const decoded = decodeDateTime(new DataView(bytes.buffer));
  assert.equal(decoded.getTime(), date.getTime());
});
