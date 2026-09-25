/**
 * GattOperationQueue: 全GATT操作のグローバル直列化。
 * - 操作は投入順に実行される（並行実行しない）
 * - 前の操作の失敗は後続の操作を止めない
 * - 各操作の結果/例外は呼び出し元へそのまま返る
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GattOperationQueue } from '../../src/ble/gatt-queue.ts';
import { deferred, flushMicrotasks } from '../helpers/mock-bluetooth.ts';

test('操作は投入順に直列実行される', async () => {
  const queue = new GattOperationQueue();
  const order: string[] = [];
  const gate = deferred();

  const first = queue.enqueue(async () => {
    order.push('first:start');
    await gate.promise;
    order.push('first:end');
    return 'A';
  });
  const second = queue.enqueue(async () => {
    order.push('second:start');
    return 'B';
  });

  await flushMicrotasks();
  // first が完了するまで second は開始しない
  assert.deepEqual(order, ['first:start']);

  gate.resolve();
  assert.equal(await first, 'A');
  assert.equal(await second, 'B');
  assert.deepEqual(order, ['first:start', 'first:end', 'second:start']);
});

test('前の操作の失敗は後続を止めず、失敗は呼び出し元にのみ伝わる', async () => {
  const queue = new GattOperationQueue();
  const boom = new Error('boom');

  const first = queue.enqueue(async () => {
    throw boom;
  });
  const second = queue.enqueue(async () => 'ok');

  await assert.rejects(first, boom);
  assert.equal(await second, 'ok');
});

test('同期的に throw する操作も直列化を壊さない', async () => {
  const queue = new GattOperationQueue();
  const boom = new Error('sync boom');

  const first = queue.enqueue(() => {
    throw boom;
  });
  const second = queue.enqueue(async () => 'ok');

  await assert.rejects(first, boom);
  assert.equal(await second, 'ok');
});
