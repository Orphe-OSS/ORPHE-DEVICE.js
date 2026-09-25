/**
 * SampleEmitter: 正規化サンプルのフィールド別コールバック配送。
 * - パースはプロファイル（デバイスSDK層）の責務。emitter は配送のみ
 * - 同じフィールドに複数購読できる
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SampleEmitter } from '../../src/device/sample-emitter.ts';

test('フィールド別リスナーへ値が配送される', () => {
  const emitter = new SampleEmitter();
  const accs: unknown[] = [];
  const gyros: unknown[] = [];
  emitter.on('acc', (value) => accs.push(value));
  emitter.on('gyro', (value) => gyros.push(value));

  emitter.emit('SENSOR_VALUES', [
    { acc: { x: 1, y: 2, z: 3 }, gyro: { x: 4, y: 5, z: 6 } },
    { acc: { x: 7, y: 8, z: 9 } },
  ]);

  assert.deepEqual(accs, [{ x: 1, y: 2, z: 3 }, { x: 7, y: 8, z: 9 }]);
  assert.deepEqual(gyros, [{ x: 4, y: 5, z: 6 }]);
});

test('同一フィールドに複数リスナーを登録できる（多重購読）', () => {
  const emitter = new SampleEmitter();
  const a: unknown[] = [];
  const b: unknown[] = [];
  emitter.on('press', (value) => a.push(value));
  emitter.on('press', (value) => b.push(value));

  emitter.emit('SENSOR_VALUES', [{ press: { values: [1, 2, 3, 4, 5, 6] } }]);
  assert.equal(a.length, 1);
  assert.equal(b.length, 1);
});

test('"*" リスナーはサンプル全体を受け取る', () => {
  const emitter = new SampleEmitter();
  const samples: unknown[] = [];
  const metas: Array<{ uuid: string }> = [];
  emitter.on('*', (sample, meta) => {
    samples.push(sample);
    metas.push(meta);
  });

  emitter.emit('SENSOR_VALUES', [{ acc: { x: 1, y: 0, z: 0 }, serial_number: 42 }]);
  assert.equal(samples.length, 1);
  assert.deepEqual((samples[0] as { serial_number: number }).serial_number, 42);
  assert.equal(metas[0]!.uuid, 'SENSOR_VALUES');
});

test('解除関数でリスナーが外れる', () => {
  const emitter = new SampleEmitter();
  const values: unknown[] = [];
  const off = emitter.on('acc', (value) => values.push(value));
  off();

  emitter.emit('SENSOR_VALUES', [{ acc: { x: 1, y: 0, z: 0 } }]);
  assert.deepEqual(values, []);
});

test('undefined のフィールドは配送しない', () => {
  const emitter = new SampleEmitter();
  const values: unknown[] = [];
  emitter.on('quat', (value) => values.push(value));

  emitter.emit('SENSOR_VALUES', [{ acc: { x: 1, y: 0, z: 0 }, quat: undefined }]);
  assert.deepEqual(values, []);
});

test('リスナーの throw は他のリスナー配送を壊さず、エラーハンドラへ流れる', () => {
  const errors: unknown[] = [];
  const emitter = new SampleEmitter((error) => errors.push(error));
  const values: unknown[] = [];
  emitter.on('acc', () => {
    throw new Error('listener boom');
  });
  emitter.on('acc', (value) => values.push(value));

  emitter.emit('SENSOR_VALUES', [{ acc: { x: 1, y: 0, z: 0 } }]);
  assert.equal(values.length, 1); // 2つ目のリスナーには届く
  assert.equal(errors.length, 1);
});
