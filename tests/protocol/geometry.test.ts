/**
 * quat → euler 変換と正規化2種。
 * - normalizeQuaternionCoreStyle: Math.sqrt、EPSILON=1e-16、ゼロ → ZERO
 * - normalizeQuaternionInsoleStyle: Math.hypot、Number.EPSILON、非有限 → ゼロ
 * 演算順を変えると結果が bit 単位で変わるため、式の形は固定する。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeQuaternionCoreStyle, normalizeQuaternionInsoleStyle, quatToEuler } from '../../src/protocol/geometry.ts';

test('quatToEuler: 単位quatは全角度0', () => {
  assert.deepEqual(quatToEuler({ w: 1, x: 0, y: 0, z: 0 }), { roll: 0, pitch: 0, yaw: 0 });
});

test('quatToEuler: Z軸90°回転は yaw=π/2', () => {
  const s = Math.SQRT1_2;
  const euler = quatToEuler({ w: s, x: 0, y: 0, z: s });
  assert.ok(Math.abs(euler.yaw - Math.PI / 2) < 1e-12);
  assert.ok(Math.abs(euler.roll) < 1e-12);
  assert.ok(Math.abs(euler.pitch) < 1e-12);
});

test('quatToEuler: X軸90°回転は roll=π/2', () => {
  const s = Math.SQRT1_2;
  const euler = quatToEuler({ w: s, x: s, y: 0, z: 0 });
  assert.ok(Math.abs(euler.roll - Math.PI / 2) < 1e-12);
});

test('quatToEuler: ジンバルロック（t>=1 / t<=-1）は ±π/2 にクランプ', () => {
  const s = Math.SQRT1_2;
  assert.equal(quatToEuler({ w: s, x: 0, y: s, z: 0 }).pitch, Math.PI / 2);
  assert.equal(quatToEuler({ w: s, x: 0, y: -s, z: 0 }).pitch, -Math.PI / 2);
});

test('normalizeQuaternionCoreStyle: 正規化とゼロ処理（1e-16 未満 → ZERO）', () => {
  const q = normalizeQuaternionCoreStyle({ w: 2, x: 0, y: 0, z: 0 });
  assert.deepEqual(q, { w: 1, x: 0, y: 0, z: 0 });
  assert.deepEqual(
    normalizeQuaternionCoreStyle({ w: 0, x: 0, y: 0, z: 0 }),
    { w: 0, x: 0, y: 0, z: 0 }
  );
});

test('normalizeQuaternionInsoleStyle: 正規化と非有限・ゼロ処理', () => {
  const q = normalizeQuaternionInsoleStyle({ w: 0, x: 3, y: 4, z: 0 });
  assert.ok(Math.abs(q.x - 0.6) < 1e-12);
  assert.ok(Math.abs(q.y - 0.8) < 1e-12);
  assert.deepEqual(
    normalizeQuaternionInsoleStyle({ w: 0, x: 0, y: 0, z: 0 }),
    { w: 0, x: 0, y: 0, z: 0 }
  );
  assert.deepEqual(
    normalizeQuaternionInsoleStyle({ w: Infinity, x: 0, y: 0, z: 0 }),
    { w: 0, x: 0, y: 0, z: 0 }
  );
});
