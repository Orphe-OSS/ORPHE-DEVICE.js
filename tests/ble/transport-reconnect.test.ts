/**
 * OrpheBleTransport: 自動再接続エンジン。
 * - 接続処理そのもの（begin シーケンス）は config.reconnectConnect で注入される
 * - resolve = 成功 / reject = 失敗 の契約
 * - 試行中の transport エラーは onError を逐一発火させず、最終失敗のみ報告
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OrpheBleTransport } from '../../src/ble/transport.ts';
import { TransportError } from '../../src/ble/errors.ts';
import type { ReconnectAttemptInfo, ReconnectFailedInfo, ReconnectSuccessInfo, TransportConfig, TransportEvents } from '../../src/ble/types.ts';
import { MemoryStorage, MockBluetooth, MockDevice, flushMicrotasks } from '../helpers/mock-bluetooth.ts';

const SERVICE_A = '01a9d6b5-ff6e-444a-b266-0be75e85c064';
const CHAR_INFO = '24354f22-1c46-430e-a4ab-a1eeabbcdfc0';

interface Harness {
  transport: OrpheBleTransport;
  bluetooth: MockBluetooth;
  storage: MemoryStorage;
  events: TransportEvents;
  device: MockDevice;
  attempts: ReconnectAttemptInfo[];
  successes: ReconnectSuccessInfo[];
  failures: ReconnectFailedInfo[];
  errors: unknown[];
  scans: Array<string | undefined>;
  waits: number[];
}

function makeHarness(overrides: Partial<TransportConfig> = {}): Harness {
  const bluetooth = new MockBluetooth();
  const storage = new MemoryStorage();
  const attempts: ReconnectAttemptInfo[] = [];
  const successes: ReconnectSuccessInfo[] = [];
  const failures: ReconnectFailedInfo[] = [];
  const errors: unknown[] = [];
  const scans: Array<string | undefined> = [];
  const waits: number[] = [];
  const events: TransportEvents = {
    onReconnectAttempt: (info) => attempts.push(info),
    onReconnectSuccess: (info) => successes.push(info),
    onReconnectFailed: (info) => failures.push(info),
    onError: (e) => errors.push(e),
    onScan: (name) => scans.push(name),
  };
  const transport = new OrpheBleTransport({
    requestDeviceOptions: { filters: [{ services: [SERVICE_A] }] },
    storageKey: 'orphe_test_reconnect',
    characteristics: {
      DEVICE_INFORMATION: { serviceUUID: SERVICE_A, characteristicUUID: CHAR_INFO },
    },
    bluetooth,
    storage,
    events,
    wait: async (ms) => {
      waits.push(ms);
    },
    ...overrides,
  });
  const device = new MockDevice('id-1', 'CR-1');
  bluetooth.chooserQueue.push(device);
  return { transport, bluetooth, storage, events, device, attempts, successes, failures, errors, scans, waits };
}

/** 接続 → 記憶 → 再接続 arm まで（begin 成功後の状態を作る） */
async function establish(h: Harness, reconnectConnect?: () => Promise<unknown>): Promise<void> {
  await h.transport.read('DEVICE_INFORMATION');
  h.transport.rememberCurrentDevice();
  h.transport.enableAutoReconnect({ intervalMs: 5, maxAttempts: 3 });
  h.transport.armAutoReconnect();
  void reconnectConnect;
}

test('リンクロスで再接続ループが走り、成功で onReconnectSuccess', async () => {
  let connectCalls = 0;
  const h = makeHarness({
    reconnectConnect: async () => {
      connectCalls++;
      return 'reconnected';
    },
  });
  await establish(h);

  h.device.gatt.simulateLinkLoss();
  await flushMicrotasks(50);

  assert.equal(connectCalls, 1);
  assert.equal(h.attempts.length, 1);
  assert.equal(h.attempts[0]!.attempt, 1);
  assert.equal(h.successes.length, 1);
  assert.equal(h.successes[0]!.result, 'reconnected');
  assert.deepEqual(h.failures, []);
});

test('失敗したら interval 待機して再試行し、2回目の成功で復帰する', async () => {
  let connectCalls = 0;
  const h = makeHarness({
    reconnectConnect: async () => {
      connectCalls++;
      if (connectCalls === 1) throw new Error('attempt1 failed');
      return 'ok';
    },
  });
  await establish(h);

  h.device.gatt.simulateLinkLoss();
  await flushMicrotasks(80);

  assert.equal(connectCalls, 2);
  assert.equal(h.attempts.length, 2);
  assert.deepEqual(h.waits, [5]); // 1回目失敗後の待機のみ
  assert.equal(h.successes.length, 1);
  assert.equal(h.successes[0]!.attempt, 2);
});

test('全試行失敗で onReconnectFailed。中間エラーは onError に流れず最終のみ報告', async () => {
  const finalError = new Error('always failing');
  const h = makeHarness({
    reconnectConnect: async () => {
      throw finalError;
    },
  });
  await establish(h);
  h.transport.enableAutoReconnect({ intervalMs: 0, maxAttempts: 2 });

  h.device.gatt.simulateLinkLoss();
  await flushMicrotasks(80);

  assert.equal(h.attempts.length, 2);
  assert.equal(h.successes.length, 0);
  assert.equal(h.failures.length, 1);
  assert.equal(h.failures[0]!.error, finalError);
  assert.deepEqual(h.errors, [finalError]); // 最終エラーの1件のみ
});

test('試行中に transport 内部で発生したエラーも onError に逐一流れない', async () => {
  const h = makeHarness({
    reconnectConnect: async () => {
      // begin シーケンス相当: 存在しない characteristic への read で内部エラーを発生させる
      await h.transport.read('NOPE');
      return 'unreachable';
    },
  });
  await establish(h);
  h.transport.enableAutoReconnect({ intervalMs: 0, maxAttempts: 2 });

  h.device.gatt.simulateLinkLoss();
  await flushMicrotasks(100);

  assert.equal(h.failures.length, 1);
  assert.equal(h.errors.length, 1); // 各試行の UNKNOWN_UUID は抑制され、最終報告のみ
});

test('arm していなければリンクロスでもループは走らない', async () => {
  let connectCalls = 0;
  const h = makeHarness({
    reconnectConnect: async () => {
      connectCalls++;
      return 'ok';
    },
  });
  await h.transport.read('DEVICE_INFORMATION');
  h.transport.enableAutoReconnect({ intervalMs: 0, maxAttempts: 2 });
  // armAutoReconnect() を呼ばない（begin 成功前の切断相当）

  h.device.gatt.simulateLinkLoss();
  await flushMicrotasks(50);

  assert.equal(connectCalls, 0);
  assert.deepEqual(h.attempts, []);
});

test('reset() で再接続は解除され、以後のリンクロスでループしない', async () => {
  let connectCalls = 0;
  const h = makeHarness({
    reconnectConnect: async () => {
      connectCalls++;
      return 'ok';
    },
  });
  await establish(h);

  h.transport.reset();
  h.device.gatt.simulateLinkLoss(); // reset 済みなので listener も外れている
  await flushMicrotasks(50);

  assert.equal(connectCalls, 0);
  assert.deepEqual(h.attempts, []);
});

test('待機中に disableAutoReconnect() したらループは打ち切られる', async () => {
  let connectCalls = 0;
  const h = makeHarness({
    reconnectConnect: async () => {
      connectCalls++;
      throw new Error('failing');
    },
    wait: async () => {
      h.transport.disableAutoReconnect();
    },
  });
  await establish(h);

  h.device.gatt.simulateLinkLoss();
  await flushMicrotasks(80);

  assert.equal(connectCalls, 1); // 2回目は走らない
  assert.equal(h.failures.length, 1);
});

test('ループ中の connectionState は reconnecting', async () => {
  const states: string[] = [];
  const h = makeHarness({
    reconnectConnect: async () => {
      await h.device.gatt.connect(); // begin 相当: 実際に GATT を張り直す
      return 'ok';
    },
  });
  await establish(h);
  h.events.onReconnectAttempt = () => states.push(h.transport.connectionState);

  h.device.gatt.simulateLinkLoss();
  await flushMicrotasks(50);

  assert.deepEqual(states, ['reconnecting']);
  assert.equal(h.transport.connectionState, 'connected');
});

test('デバイスが失われていたら記憶から復元してから接続する', async () => {
  let connectCalls = 0;
  const h = makeHarness({
    reconnectConnect: async () => {
      connectCalls++;
      if (connectCalls === 1) {
        // 記憶デバイス経由の接続失敗相当: transport がデバイスを手放す
        h.transport.clear();
        throw new Error('attempt1 failed');
      }
      return 'ok';
    },
  });
  await establish(h);
  h.bluetooth.knownDevices = [h.device];

  h.device.gatt.simulateLinkLoss();
  await flushMicrotasks(100);

  assert.equal(h.successes.length, 1);
  assert.equal(h.transport.device, h.device); // 復元済み
  assert.ok(h.scans.length >= 1); // 復元時に onScan
});

test('記憶からも復元できなければ RECONNECT_DEVICE_NOT_FOUND で失敗する', async () => {
  const h = makeHarness({
    reconnectConnect: async () => 'ok',
  });
  await establish(h);
  h.transport.enableAutoReconnect({ intervalMs: 0, maxAttempts: 2 });
  h.transport.forgetRememberedDevice();
  h.transport.clear();

  // clear() で listener が外れているため、ループを直接起動できる別経路を使う
  h.device.gatt.connected = true;
  h.device.gatt.disconnect(); // listener なし → 手動でループ起動
  h.transport.startReconnect();
  await flushMicrotasks(80);

  assert.equal(h.failures.length, 1);
  assert.equal((h.failures[0]!.error as TransportError).code, 'RECONNECT_DEVICE_NOT_FOUND');
});

test('afterReconnectSuccess フックは onReconnectSuccess より先に呼ばれ、throw しても壊れない', async () => {
  const order: string[] = [];
  const h = makeHarness({
    reconnectConnect: async () => 'ok',
  });
  await establish(h);
  h.transport.addAfterReconnectSuccessHook(() => {
    order.push('hook1');
    throw new Error('hook boom');
  });
  h.transport.addAfterReconnectSuccessHook(() => {
    order.push('hook2');
  });
  h.events.onReconnectSuccess = () => order.push('success');

  h.device.gatt.simulateLinkLoss();
  await flushMicrotasks(50);

  assert.deepEqual(order, ['hook1', 'hook2', 'success']);
  assert.equal(h.errors.length, 1); // hook の throw は onError へ
});

test('addAfterReconnectSuccessHook の解除関数でフックが外れる', async () => {
  const calls: string[] = [];
  const h = makeHarness({
    reconnectConnect: async () => 'ok',
  });
  await establish(h);
  const remove = h.transport.addAfterReconnectSuccessHook(() => calls.push('hook'));
  remove();

  h.device.gatt.simulateLinkLoss();
  await flushMicrotasks(50);

  assert.deepEqual(calls, []);
  assert.equal(h.successes.length, 1);
});

test('reconnectConnect 未設定で enableAutoReconnect は RECONNECT_NOT_CONFIGURED を投げる', () => {
  const h = makeHarness();
  assert.throws(
    () => h.transport.enableAutoReconnect(),
    (e: TransportError) => e.code === 'RECONNECT_NOT_CONFIGURED'
  );
});
