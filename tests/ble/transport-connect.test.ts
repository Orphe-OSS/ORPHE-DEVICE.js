/**
 * OrpheBleTransport: デバイス選択（scan/chooser/記憶復元/ガード）、
 * connectGATT の UUID 別 characteristic キャッシュ、read/write、
 * グローバル GATT キューによる直列化。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OrpheBleTransport } from '../../src/ble/transport.ts';
import { TransportError } from '../../src/ble/errors.ts';
import type { TransportConfig, TransportEvents } from '../../src/ble/types.ts';
import {
  MemoryStorage,
  MockBluetooth,
  MockDevice,
  deferred,
  flushMicrotasks,
} from '../helpers/mock-bluetooth.ts';

const SERVICE_A = '01a9d6b5-ff6e-444a-b266-0be75e85c064';
const CHAR_INFO = '24354f22-1c46-430e-a4ab-a1eeabbcdfc0';
const SERVICE_B = 'db1b7aca-cda5-4453-a49b-33a53d3f0833';
const CHAR_SENSOR = 'f3f9c7ce-46ee-4205-89ac-abe64e626c0f';

interface Harness {
  transport: OrpheBleTransport;
  bluetooth: MockBluetooth;
  storage: MemoryStorage;
  events: TransportEvents;
  errors: unknown[];
  scans: Array<string | undefined>;
  connects: string[];
}

function makeHarness(overrides: Partial<TransportConfig> = {}): Harness {
  const bluetooth = new MockBluetooth();
  const storage = new MemoryStorage();
  const errors: unknown[] = [];
  const scans: Array<string | undefined> = [];
  const connects: string[] = [];
  const events: TransportEvents = {
    onError: (e) => errors.push(e),
    onScan: (name) => scans.push(name),
    onConnect: (uuid) => connects.push(uuid),
  };
  const transport = new OrpheBleTransport({
    requestDeviceOptions: { filters: [{ services: [SERVICE_A] }], optionalServices: [SERVICE_A, SERVICE_B] },
    storageKey: 'orphe_test_0',
    characteristics: {
      DEVICE_INFORMATION: { serviceUUID: SERVICE_A, characteristicUUID: CHAR_INFO },
      SENSOR_VALUES: { serviceUUID: SERVICE_B, characteristicUUID: CHAR_SENSOR },
    },
    bluetooth,
    storage,
    events,
    ...overrides,
  });
  return { transport, bluetooth, storage, events, errors, scans, connects };
}

function chr(device: MockDevice, serviceUUID: string, charUUID: string) {
  return device.gatt.getOrCreateService(serviceUUID).getOrCreate(charUUID);
}

// ─── デバイス選択 ────────────────────────────────────────────────

test('scan: デバイス未選択なら chooser を開き、設定したフィルタを渡す', async () => {
  const h = makeHarness();
  const device = new MockDevice('id-1', 'CR-1');
  h.bluetooth.chooserQueue.push(device);

  await h.transport.scan('DEVICE_INFORMATION');

  assert.equal(h.transport.device, device);
  assert.equal(h.bluetooth.requestDeviceCalls.length, 1);
  assert.deepEqual(h.bluetooth.requestDeviceCalls[0]!.filters, [{ services: [SERVICE_A] }]);
  assert.deepEqual(h.scans, ['CR-1']);
});

test('scan: デバイス選択済みなら chooser を開かない', async () => {
  const h = makeHarness();
  h.bluetooth.chooserQueue.push(new MockDevice('id-1', 'CR-1'));
  await h.transport.scan('DEVICE_INFORMATION');
  await h.transport.scan('DEVICE_INFORMATION');
  assert.equal(h.bluetooth.requestDeviceCalls.length, 1);
});

test('scan: chooser キャンセルは reject し onError にも報告される', async () => {
  const h = makeHarness();
  await assert.rejects(h.transport.scan('DEVICE_INFORMATION'), (e: Error) => e.name === 'NotFoundError');
  assert.equal(h.errors.length, 1);
});

test('scan: 記憶デバイスがあれば chooser なしで復元する', async () => {
  const h = makeHarness();
  const device = new MockDevice('id-2', 'CR-2');
  h.bluetooth.chooserQueue.push(device);
  await h.transport.scan('DEVICE_INFORMATION');
  h.transport.rememberCurrentDevice();

  // 新しいトランスポート（ページリロード相当）で同じ storage を使う
  const h2 = makeHarness();
  h2.storage.map = h.storage.map;
  h2.bluetooth.knownDevices = [device];

  await h2.transport.scan('DEVICE_INFORMATION');
  assert.equal(h2.transport.device, device);
  assert.equal(h2.bluetooth.requestDeviceCalls.length, 0);
  assert.deepEqual(h2.scans, ['CR-2']);
});

test('scan: forceDeviceSelection は記憶があっても chooser を開く', async () => {
  const h = makeHarness();
  const remembered = new MockDevice('id-old', 'CR-OLD');
  h.storage.setItem('orphe_test_0', JSON.stringify({ bluetoothId: 'id-old', bluetoothName: 'CR-OLD', lastConnectedAt: 1 }));
  h.bluetooth.knownDevices = [remembered];
  const fresh = new MockDevice('id-new', 'CR-NEW');
  h.bluetooth.chooserQueue.push(fresh);

  await h.transport.scan('DEVICE_INFORMATION', { forceDeviceSelection: true });
  assert.equal(h.transport.device, fresh);
  assert.equal(h.bluetooth.requestDeviceCalls.length, 1);
});

test('scan: deviceGuard が chooser 選択デバイスを拒否したら DEVICE_DISALLOWED で reject', async () => {
  const h = makeHarness({ deviceGuard: (d) => (d.id === 'taken' ? 'already assigned' : null) });
  h.bluetooth.chooserQueue.push(new MockDevice('taken', 'CR-X'));

  await assert.rejects(
    h.transport.scan('DEVICE_INFORMATION'),
    (e: TransportError) => e.code === 'DEVICE_DISALLOWED'
  );
  assert.equal(h.transport.device, null);
});

test('scan: deviceGuard が記憶デバイスを拒否したら記憶を破棄して chooser へフォールバック', async () => {
  const taken = new MockDevice('taken', 'CR-X');
  const h = makeHarness({ deviceGuard: (d) => (d.id === 'taken' ? 'already assigned' : null) });
  h.storage.setItem('orphe_test_0', JSON.stringify({ bluetoothId: 'taken', bluetoothName: 'CR-X', lastConnectedAt: 1 }));
  h.bluetooth.knownDevices = [taken];
  const fresh = new MockDevice('free', 'CR-Y');
  h.bluetooth.chooserQueue.push(fresh);

  await h.transport.scan('DEVICE_INFORMATION');
  assert.equal(h.transport.device, fresh);
  assert.equal(h.storage.getItem('orphe_test_0'), null); // 記憶は破棄済み
});

// ─── connectGATT / characteristic キャッシュ ─────────────────────

test('read: scan → connect → service → characteristic を辿って値を返す', async () => {
  const h = makeHarness();
  const device = new MockDevice('id-1', 'CR-1');
  const c = chr(device, SERVICE_A, CHAR_INFO);
  c.readValueData = new DataView(new Uint8Array([1, 2, 3]).buffer);
  h.bluetooth.chooserQueue.push(device);

  const value = await h.transport.read('DEVICE_INFORMATION');
  assert.equal(value.getUint8(2), 3);
  assert.deepEqual(h.connects, ['DEVICE_INFORMATION']);
});

test('connectGATT: 同一 UUID の再操作は characteristic キャッシュを使う', async () => {
  const h = makeHarness();
  const device = new MockDevice('id-1', 'CR-1');
  h.bluetooth.chooserQueue.push(device);

  await h.transport.read('DEVICE_INFORMATION');
  await h.transport.read('DEVICE_INFORMATION');

  assert.equal(device.gatt.connectCalls, 1);
  assert.deepEqual(h.connects, ['DEVICE_INFORMATION']); // onConnect は初回のみ
});

test('connectGATT: UUID を切り替えても両方キャッシュされ再取得しない', async () => {
  const h = makeHarness();
  const device = new MockDevice('id-1', 'CR-1');
  h.bluetooth.chooserQueue.push(device);

  await h.transport.read('DEVICE_INFORMATION');
  await h.transport.read('SENSOR_VALUES');
  await h.transport.read('DEVICE_INFORMATION'); // 切り替え戻し

  assert.equal(device.gatt.connectCalls, 2); // 各UUIDの初回のみ（gatt.connect は接続済みなら再取得のみ）
  assert.equal(chr(device, SERVICE_A, CHAR_INFO).readCalls, 2);
});

test('connectGATT: GATT リンク切断後はキャッシュを無効化して再取得する', async () => {
  const h = makeHarness();
  const device = new MockDevice('id-1', 'CR-1');
  h.bluetooth.chooserQueue.push(device);

  await h.transport.read('DEVICE_INFORMATION');
  device.gatt.simulateLinkLoss();
  await h.transport.read('DEVICE_INFORMATION');

  assert.equal(device.gatt.connectCalls, 2);
});

test('connectGATT: connectTimeoutMs 超過で CONNECT_TIMEOUT', async () => {
  const h = makeHarness({ connectTimeoutMs: 20 });
  const device = new MockDevice('id-1', 'CR-1');
  device.gatt.connectGate = deferred().promise; // 永遠に解決しない
  h.bluetooth.chooserQueue.push(device);

  await assert.rejects(
    h.transport.read('DEVICE_INFORMATION'),
    (e: TransportError) => e.code === 'CONNECT_TIMEOUT'
  );
});

test('connectGATT: 未登録 UUID は UNKNOWN_UUID', async () => {
  const h = makeHarness();
  h.bluetooth.chooserQueue.push(new MockDevice('id-1', 'CR-1'));
  await assert.rejects(
    h.transport.read('NOPE'),
    (e: TransportError) => e.code === 'UNKNOWN_UUID'
  );
});

test('記憶デバイスへの接続失敗で unavailable マークし、次回は chooser へ', async () => {
  const remembered = new MockDevice('id-r', 'CR-R');
  remembered.gatt.failNextConnect = new Error('link failed');
  const h = makeHarness();
  h.storage.setItem('orphe_test_0', JSON.stringify({ bluetoothId: 'id-r', bluetoothName: 'CR-R', lastConnectedAt: 1 }));
  h.bluetooth.knownDevices = [remembered];

  await assert.rejects(h.transport.read('DEVICE_INFORMATION'));
  assert.equal(h.transport.device, null);

  const fresh = new MockDevice('id-f', 'CR-F');
  h.bluetooth.chooserQueue.push(fresh);
  await h.transport.read('DEVICE_INFORMATION');
  assert.equal(h.transport.device, fresh);
});

// ─── write ───────────────────────────────────────────────────────

test('write: 配列を Uint8Array に変換して書き込み、onWrite が発火する', async () => {
  const writes: string[] = [];
  const h = makeHarness();
  h.events.onWrite = (uuid) => writes.push(uuid);
  const device = new MockDevice('id-1', 'CR-1');
  h.bluetooth.chooserQueue.push(device);

  await h.transport.write('DEVICE_INFORMATION', [0x02, 1, 3]);

  const c = chr(device, SERVICE_A, CHAR_INFO);
  assert.deepEqual([...c.written[0]!], [0x02, 1, 3]);
  assert.deepEqual(writes, ['DEVICE_INFORMATION']);
});

// ─── グローバル GATT キュー ──────────────────────────────────────

test('read と write は並行発行しても直列に実行される', async () => {
  const h = makeHarness();
  const device = new MockDevice('id-1', 'CR-1');
  const c = chr(device, SERVICE_A, CHAR_INFO);
  const gate = deferred();
  c.readGate = gate.promise;
  h.bluetooth.chooserQueue.push(device);

  const readPromise = h.transport.read('DEVICE_INFORMATION');
  const writePromise = h.transport.write('DEVICE_INFORMATION', [1]);

  await flushMicrotasks(30);
  assert.equal(c.readCalls, 1);
  assert.equal(c.written.length, 0); // read 完了まで write は始まらない

  gate.resolve();
  await readPromise;
  await writePromise;
  assert.equal(c.written.length, 1);
});

test('先行操作の失敗は後続操作を止めない', async () => {
  const h = makeHarness();
  const device = new MockDevice('id-1', 'CR-1');
  const c = chr(device, SERVICE_A, CHAR_INFO);
  c.failNextRead = new Error('read boom');
  h.bluetooth.chooserQueue.push(device);

  const readPromise = h.transport.read('DEVICE_INFORMATION');
  const writePromise = h.transport.write('DEVICE_INFORMATION', [7]);

  await assert.rejects(readPromise, /read boom/);
  await writePromise;
  assert.deepEqual([...c.written[0]!], [7]);
});

// ─── 切断・状態 ──────────────────────────────────────────────────

test('isConnected / connectionState / disconnect の基本遷移', async () => {
  const h = makeHarness();
  const device = new MockDevice('id-1', 'CR-1');
  h.bluetooth.chooserQueue.push(device);

  assert.equal(h.transport.isConnected(), false);
  assert.equal(h.transport.connectionState, 'disconnected');

  h.transport.setConnecting(true);
  assert.equal(h.transport.connectionState, 'connecting');

  await h.transport.read('DEVICE_INFORMATION');
  h.transport.setConnecting(false);
  assert.equal(h.transport.isConnected(), true);
  assert.equal(h.transport.connectionState, 'connected');

  h.transport.disconnect();
  assert.equal(h.transport.isConnected(), false);
});

test('リンクロスで onDisconnect イベントが発火する', async () => {
  const disconnects: unknown[] = [];
  const h = makeHarness();
  h.events.onDisconnect = (e) => disconnects.push(e);
  const device = new MockDevice('id-1', 'CR-1');
  h.bluetooth.chooserQueue.push(device);
  await h.transport.read('DEVICE_INFORMATION');

  device.gatt.simulateLinkLoss();
  assert.equal(disconnects.length, 1);
});

test('onDisconnect を後から差し替えても新しい関数が呼ばれる（遅延バインド）', async () => {
  const calls: string[] = [];
  const h = makeHarness();
  h.events.onDisconnect = () => calls.push('old');
  const device = new MockDevice('id-1', 'CR-1');
  h.bluetooth.chooserQueue.push(device);
  await h.transport.read('DEVICE_INFORMATION');

  h.events.onDisconnect = () => calls.push('new');
  device.gatt.simulateLinkLoss();
  assert.deepEqual(calls, ['new']);
});

test('reset: 切断してデバイス・キャッシュをクリアする', async () => {
  const h = makeHarness();
  const device = new MockDevice('id-1', 'CR-1');
  h.bluetooth.chooserQueue.push(device);
  await h.transport.read('DEVICE_INFORMATION');

  h.transport.reset();
  assert.equal(h.transport.device, null);
  assert.equal(device.gatt.connected, false);
});

test('ユーザコールバックの throw はトランスポートを壊さず onError に報告される', async () => {
  const h = makeHarness();
  h.events.onScan = () => {
    throw new Error('user callback boom');
  };
  const device = new MockDevice('id-1', 'CR-1');
  h.bluetooth.chooserQueue.push(device);

  const value = await h.transport.read('DEVICE_INFORMATION'); // reject しない
  assert.ok(value instanceof DataView);
  assert.equal(h.errors.length, 1);
});

test('selectDevice: 記憶を破棄して必ず chooser を開く', async () => {
  const h = makeHarness();
  const first = new MockDevice('id-1', 'CR-1');
  h.bluetooth.chooserQueue.push(first);
  await h.transport.read('DEVICE_INFORMATION');
  h.transport.rememberCurrentDevice();

  const second = new MockDevice('id-2', 'CR-2');
  h.bluetooth.chooserQueue.push(second);
  await h.transport.selectDevice();

  assert.equal(h.transport.device, second);
  assert.equal(first.gatt.connected, false); // 旧接続は切断
  assert.equal(h.storage.getItem('orphe_test_0'), null);
});

// ─── silent: 任意 characteristic の存在確認用の read ──────────────

test('silent read: chooser キャンセルは onError へ報告しない（例外は throw される）', async () => {
  const h = makeHarness();
  // chooserQueue が空 = ユーザがキャンセルした状態
  await assert.rejects(() => h.transport.read('DEVICE_INFORMATION', { silent: true }));
  assert.deepEqual(h.errors, []);
});

test('silent read: GATT 接続の失敗も onError へ報告しない', async () => {
  const h = makeHarness();
  const device = new MockDevice('dev-1', 'CR-01');
  h.bluetooth.chooserQueue.push(device);
  device.gatt.failNextConnect = new Error('GATT operation failed for unknown reason.');
  await assert.rejects(() => h.transport.read('DEVICE_INFORMATION', { silent: true }));
  assert.deepEqual(h.errors, []);
});

test('silent read: 未登録の論理名でも onError へ報告しない', async () => {
  const h = makeHarness();
  h.bluetooth.chooserQueue.push(new MockDevice('dev-1', 'CR-01'));
  await assert.rejects(() => h.transport.read('GET_FW_NAME', { silent: true }));
  assert.deepEqual(h.errors, []);
});

test('silent を付けない read は onError へ報告する', async () => {
  const h = makeHarness();
  await assert.rejects(() => h.transport.read('DEVICE_INFORMATION'));
  // scan() と read() の両方が報告するため 1 件とは限らない
  assert.ok(h.errors.length >= 1);
});
