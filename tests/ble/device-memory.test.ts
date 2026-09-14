/**
 * DeviceMemory: 接続成功デバイスの記憶と getDevices() による復元
 * （両SDKの _rememberBluetoothDevice / _findBluetoothDevice 系の共通化）。
 * - localStorage に {bluetoothId, bluetoothName, lastConnectedAt} を保存
 * - id 一致 → 名前一意一致 の順で復元
 * - getDevices 未対応 / storage 例外は null 扱い（throw しない)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DeviceMemory } from '../../src/ble/device-memory.ts';
import { MemoryStorage, MockBluetooth, MockDevice } from '../helpers/mock-bluetooth.ts';

const KEY = 'orphe_test_device_0';

test('remember() で保存し load() で読み出せる', () => {
  const storage = new MemoryStorage();
  const memory = new DeviceMemory(KEY, storage);
  const device = new MockDevice('dev-id-1', 'CR-1234');

  memory.remember(device);
  const info = memory.load();
  assert.ok(info);
  assert.equal(info.bluetoothId, 'dev-id-1');
  assert.equal(info.bluetoothName, 'CR-1234');
  assert.ok(typeof info.lastConnectedAt === 'number');
});

test('forget() で記憶が消える', () => {
  const storage = new MemoryStorage();
  const memory = new DeviceMemory(KEY, storage);
  memory.remember(new MockDevice('dev-id-1', 'CR-1234'));
  memory.forget();
  assert.equal(memory.load(), null);
});

test('id が一致するデバイスを最優先で復元する', async () => {
  const storage = new MemoryStorage();
  const memory = new DeviceMemory(KEY, storage);
  const target = new MockDevice('dev-id-2', 'CR-A');
  memory.remember(target);

  const bluetooth = new MockBluetooth();
  bluetooth.knownDevices = [new MockDevice('dev-id-1', 'CR-A'), target];

  const found = await memory.restore(bluetooth);
  assert.equal(found, target);
});

test('id 不一致でも名前が一意に一致すれば復元する', async () => {
  const storage = new MemoryStorage();
  const memory = new DeviceMemory(KEY, storage);
  memory.remember(new MockDevice('gone-id', 'CR-UNIQUE'));

  const match = new MockDevice('new-id', 'CR-UNIQUE');
  const bluetooth = new MockBluetooth();
  bluetooth.knownDevices = [new MockDevice('x', 'CR-OTHER'), match];

  const found = await memory.restore(bluetooth);
  assert.equal(found, match);
});

test('同名デバイスが複数あるときは名前では復元しない', async () => {
  const storage = new MemoryStorage();
  const memory = new DeviceMemory(KEY, storage);
  memory.remember(new MockDevice('gone-id', 'CR-DUP'));

  const bluetooth = new MockBluetooth();
  bluetooth.knownDevices = [new MockDevice('a', 'CR-DUP'), new MockDevice('b', 'CR-DUP')];

  assert.equal(await memory.restore(bluetooth), null);
});

test('getDevices 未対応環境では null（throw しない）', async () => {
  const storage = new MemoryStorage();
  const memory = new DeviceMemory(KEY, storage);
  memory.remember(new MockDevice('dev-id-1', 'CR-1234'));

  const bluetooth = new MockBluetooth({ supportsGetDevices: false });
  assert.equal(await memory.restore(bluetooth), null);
});

test('記憶なしなら restore は null', async () => {
  const memory = new DeviceMemory(KEY, new MemoryStorage());
  assert.equal(await memory.restore(new MockBluetooth()), null);
});

test('壊れた JSON は null 扱い', () => {
  const storage = new MemoryStorage();
  storage.setItem(KEY, '{broken');
  const memory = new DeviceMemory(KEY, storage);
  assert.equal(memory.load(), null);
});

test('storage が例外を投げても throw しない（プライベートモード等）', () => {
  const throwingStorage = {
    getItem(): string | null {
      throw new Error('SecurityError');
    },
    setItem(): void {
      throw new Error('SecurityError');
    },
    removeItem(): void {
      throw new Error('SecurityError');
    },
  };
  const memory = new DeviceMemory(KEY, throwingStorage);
  memory.remember(new MockDevice('a', 'b'));
  memory.forget();
  assert.equal(memory.load(), null);
});

test('unavailable フラグ: markUnavailable で復元を止め、remember/forget で解除', async () => {
  const storage = new MemoryStorage();
  const memory = new DeviceMemory(KEY, storage);
  const device = new MockDevice('dev-id-1', 'CR-1');
  memory.remember(device);

  const bluetooth = new MockBluetooth();
  bluetooth.knownDevices = [device];

  memory.markUnavailable();
  assert.equal(memory.shouldTryRestore(), false);

  memory.remember(device);
  assert.equal(memory.shouldTryRestore(), true);
  assert.equal(await memory.restore(bluetooth), device);
});

// ─── 在圏確認（watchAdvertisements） ──────────────────────────────

/** watchAdvertisements に対応し、広告の発火を手動で制御できるデバイス */
class AdvertisingDevice extends MockDevice {
  watchCalls = 0;
  private advertise: boolean;

  constructor(id: string, name: string, options: { advertise?: boolean } = {}) {
    super(id, name);
    this.advertise = options.advertise ?? true;
  }

  async watchAdvertisements(): Promise<void> {
    this.watchCalls += 1;
    if (this.advertise) setTimeout(() => this.dispatch('advertisementreceived', {}), 0);
  }
}

function memoryWith(device: MockDevice): { memory: DeviceMemory; bluetooth: MockBluetooth } {
  const memory = new DeviceMemory(KEY, new MemoryStorage());
  memory.remember(device);
  const bluetooth = new MockBluetooth();
  bluetooth.knownDevices = [device];
  return { memory, bluetooth };
}

test('restore(): 広告を受信できたデバイスは復元する', async () => {
  const device = new AdvertisingDevice('dev-adv', 'CR-ADV');
  const { memory, bluetooth } = memoryWith(device);
  assert.equal(await memory.restore(bluetooth, { advertisementTimeoutMs: 100 }), device);
  assert.equal(device.watchCalls, 1);
});

test('restore(): 広告が来ないデバイスは圏外とみなし null（chooser へ回す）', async () => {
  const device = new AdvertisingDevice('dev-far', 'CR-FAR', { advertise: false });
  const { memory, bluetooth } = memoryWith(device);
  assert.equal(await memory.restore(bluetooth, { advertisementTimeoutMs: 30 }), null);
});

test('restore(): watchAdvertisements 未対応の環境ではそのまま復元する', async () => {
  const device = new MockDevice('dev-plain', 'CR-PLAIN');
  const { memory, bluetooth } = memoryWith(device);
  assert.equal(await memory.restore(bluetooth, { advertisementTimeoutMs: 30 }), device);
});

test('restore(): すでに GATT 接続済みなら広告を待たない', async () => {
  const device = new AdvertisingDevice('dev-live', 'CR-LIVE', { advertise: false });
  device.gatt.connected = true;
  const { memory, bluetooth } = memoryWith(device);
  assert.equal(await memory.restore(bluetooth, { advertisementTimeoutMs: 30 }), device);
  assert.equal(device.watchCalls, 0);
});

test('restore(): watchAdvertisements が失敗しても復元は諦めない', async () => {
  const device = new AdvertisingDevice('dev-err', 'CR-ERR', { advertise: false });
  device.watchAdvertisements = async () => { throw new Error('not supported'); };
  const { memory, bluetooth } = memoryWith(device);
  assert.equal(await memory.restore(bluetooth, { advertisementTimeoutMs: 30 }), device);
});
