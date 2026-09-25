/**
 * BleSharedBridge: 複数タブ間で BLE 接続を共有するブリッジ。
 * - Primary: localStorage ハートビート + BroadcastChannel 配信
 * - Secondary: チャネル購読 + Primary 喪失検知（storage イベント / ポーリング）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BleSharedBridge } from '../src/bridge.ts';
import type { BridgeChannel, BridgeEnvironment } from '../src/bridge.ts';
import { MemoryStorage } from './helpers/mock-bluetooth.ts';

/** BroadcastChannel + window イベントのモック環境（タブ横断で共有する） */
class MockTabWorld {
  storage = new MemoryStorage();
  private buses = new Map<string, Set<MockChannel>>();

  /** 1タブ分の環境を作る */
  createEnvironment(): MockTabEnvironment {
    return new MockTabEnvironment(this);
  }

  channelBus(name: string): Set<MockChannel> {
    let bus = this.buses.get(name);
    if (!bus) {
      bus = new Set();
      this.buses.set(name, bus);
    }
    return bus;
  }
}

class MockChannel implements BridgeChannel {
  onmessage: ((event: { data: unknown }) => void) | null = null;
  closed = false;
  private readonly world: MockTabWorld;
  private readonly name: string;
  constructor(world: MockTabWorld, name: string) {
    this.world = world;
    this.name = name;
    world.channelBus(name).add(this);
  }
  postMessage(message: unknown): void {
    if (this.closed) return;
    // BroadcastChannel と同じく自分自身へは配送しない
    for (const peer of this.world.channelBus(this.name)) {
      if (peer !== this && !peer.closed) peer.onmessage?.({ data: message });
    }
  }
  close(): void {
    this.closed = true;
    this.world.channelBus(this.name).delete(this);
  }
}

class MockTabEnvironment implements BridgeEnvironment {
  storage: MemoryStorage;
  windowListeners = new Map<string, Set<(event: unknown) => void>>();
  private readonly world: MockTabWorld;
  constructor(world: MockTabWorld) {
    this.world = world;
    this.storage = world.storage;
  }
  createChannel(name: string): BridgeChannel | null {
    return new MockChannel(this.world, name);
  }
  addWindowListener(type: string, listener: (event: unknown) => void): void {
    let set = this.windowListeners.get(type);
    if (!set) {
      set = new Set();
      this.windowListeners.set(type, set);
    }
    set.add(listener);
  }
  removeWindowListener(type: string, listener: (event: unknown) => void): void {
    this.windowListeners.get(type)?.delete(listener);
  }
  dispatchWindowEvent(type: string, event: unknown): void {
    for (const listener of [...(this.windowListeners.get(type) ?? [])]) listener(event);
  }
  listenerCount(type: string): number {
    return this.windowListeners.get(type)?.size ?? 0;
  }
}

const FAST = { heartbeatIntervalMs: 5, heartbeatTimeoutMs: 50, watchIntervalMs: 10 };

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

test('claimPrimary: ハートビートを書き込み、他タブから Primary として見える', async (t) => {
  const world = new MockTabWorld();
  const primary = new BleSharedBridge(0, world.createEnvironment(), FAST);
  const other = new BleSharedBridge(0, world.createEnvironment(), FAST);
  t.after(() => {
    primary.release();
    other.release();
  });

  assert.equal(other.isRemotePrimaryAvailable(), false);
  primary.claimPrimary();
  assert.equal(primary.isPrimary, true);
  assert.equal(other.isRemotePrimaryAvailable(), true);
  // 自分自身のハートビートは「他タブの Primary」ではない
  assert.equal(primary.isRemotePrimaryAvailable(), false);
});

test('期限切れハートビートは Primary と見なさない', () => {
  const world = new MockTabWorld();
  world.storage.setItem('orphe_bridge_primary_0', JSON.stringify({
    timestamp: Date.now() - 10_000,
    tabId: 'tab_other',
  }));
  const bridge = new BleSharedBridge(0, world.createEnvironment(), FAST);
  assert.equal(bridge.isRemotePrimaryAvailable(), false);
});

test('broadcastBatch: Secondary のコールバックへ配送され、deviceId が違えば無視', async (t) => {
  const world = new MockTabWorld();
  const primary = new BleSharedBridge(0, world.createEnvironment(), FAST);
  const secondary = new BleSharedBridge(0, world.createEnvironment(), FAST);
  const otherDevice = new BleSharedBridge(1, world.createEnvironment(), FAST);
  t.after(() => {
    primary.release();
    secondary.release();
    otherDevice.release();
  });

  primary.claimPrimary();
  const received: Array<{ name: string; data: unknown }> = [];
  secondary.subscribeAsSecondary({
    gotAcc: (d: unknown) => received.push({ name: 'gotAcc', data: d }),
    gotQuat: (d: unknown) => received.push({ name: 'gotQuat', data: d }),
  });
  const otherReceived: unknown[] = [];
  otherDevice.subscribeAsSecondary({
    gotAcc: (d: unknown) => otherReceived.push(d),
  });

  primary.broadcastBatch({ gotAcc: { x: 1 }, gotQuat: { w: 1 } });
  assert.equal(received.length, 2);
  assert.deepEqual(received[0], { name: 'gotAcc', data: { x: 1 } });
  assert.deepEqual(otherReceived, []); // deviceId 1 のチャネルには流れない
});

test('broadcast: 単一コールバック互換 API', async (t) => {
  const world = new MockTabWorld();
  const primary = new BleSharedBridge(0, world.createEnvironment(), FAST);
  const secondary = new BleSharedBridge(0, world.createEnvironment(), FAST);
  t.after(() => {
    primary.release();
    secondary.release();
  });

  primary.claimPrimary();
  const received: unknown[] = [];
  secondary.subscribeAsSecondary({ gotGait: (d: unknown) => received.push(d) });

  primary.broadcast('gotGait', { steps: 3 });
  assert.deepEqual(received, [{ steps: 3 }]);
});

test('broadcastDisconnect: Secondary の onPrimaryLost が1回だけ発火する', async (t) => {
  const world = new MockTabWorld();
  const primary = new BleSharedBridge(0, world.createEnvironment(), FAST);
  const secondary = new BleSharedBridge(0, world.createEnvironment(), FAST);
  t.after(() => {
    primary.release();
    secondary.release();
  });

  primary.claimPrimary();
  let lost = 0;
  secondary.subscribeAsSecondary({ onPrimaryLost: () => lost++ });

  primary.broadcastDisconnect();
  primary.broadcastDisconnect(); // 二重通知でも
  assert.equal(lost, 1);
});

test('storage イベントで Primary エントリ削除を即時検知する', async (t) => {
  const world = new MockTabWorld();
  const env = world.createEnvironment() as MockTabEnvironment;
  const secondary = new BleSharedBridge(0, env, FAST);
  t.after(() => secondary.release());

  world.storage.setItem('orphe_bridge_primary_0', JSON.stringify({ timestamp: Date.now(), tabId: 'tab_other' }));
  let lost = 0;
  secondary.subscribeAsSecondary({ onPrimaryLost: () => lost++ });

  env.dispatchWindowEvent('storage', { key: 'orphe_bridge_primary_0', newValue: null });
  assert.equal(lost, 1);

  // 関係ないキーでは発火しない（発火済みフラグとは独立に検証するため新インスタンス）
  const secondary2 = new BleSharedBridge(0, env, FAST);
  t.after(() => secondary2.release());
  let lost2 = 0;
  secondary2.subscribeAsSecondary({ onPrimaryLost: () => lost2++ });
  env.dispatchWindowEvent('storage', { key: 'unrelated_key', newValue: null });
  assert.equal(lost2, 0);
});

test('フォールバックポーリングでハートビート途絶を検知する', async (t) => {
  const world = new MockTabWorld();
  const secondary = new BleSharedBridge(0, world.createEnvironment(), FAST);
  t.after(() => secondary.release());

  // 有効な Primary を置いてから購読開始
  world.storage.setItem('orphe_bridge_primary_0', JSON.stringify({ timestamp: Date.now(), tabId: 'tab_other' }));
  let lost = 0;
  secondary.subscribeAsSecondary({ onPrimaryLost: () => lost++ });
  await sleep(30);
  assert.equal(lost, 0); // まだ生きている

  // ハートビートを期限切れにする（Primary タブがフリーズ/クラッシュした相当）
  world.storage.setItem('orphe_bridge_primary_0', JSON.stringify({ timestamp: Date.now() - 10_000, tabId: 'tab_other' }));
  await sleep(50);
  assert.equal(lost, 1);
});

test('release: Primary の自分のエントリのみ削除し、他タブの新エントリは消さない', async (t) => {
  const world = new MockTabWorld();
  const primary = new BleSharedBridge(0, world.createEnvironment(), FAST);
  t.after(() => primary.release());

  primary.claimPrimary();
  assert.ok(world.storage.getItem('orphe_bridge_primary_0'));

  // 別タブが先に Primary を奪取したケース
  world.storage.setItem('orphe_bridge_primary_0', JSON.stringify({ timestamp: Date.now(), tabId: 'tab_newer' }));
  primary.release();
  assert.ok(world.storage.getItem('orphe_bridge_primary_0')); // 他タブのエントリは残る

  // 自分のエントリなら消える
  const primary2 = new BleSharedBridge(0, world.createEnvironment(), FAST);
  primary2.claimPrimary();
  primary2.release();
  assert.equal(world.storage.getItem('orphe_bridge_primary_0'), null);
});

test('release: window リスナーと interval がすべて解放される', async (t) => {
  const world = new MockTabWorld();
  const env = world.createEnvironment() as MockTabEnvironment;
  const bridge = new BleSharedBridge(0, env, FAST);
  t.after(() => bridge.release());

  world.storage.setItem('orphe_bridge_primary_0', JSON.stringify({ timestamp: Date.now(), tabId: 'tab_other' }));
  bridge.subscribeAsSecondary({ onPrimaryLost: () => {} });
  assert.equal(env.listenerCount('storage'), 1);

  bridge.release();
  assert.equal(env.listenerCount('storage'), 0);
  assert.equal(bridge.isPrimary, false);
});

test('pagehide で Primary エントリ削除と切断通知が走る', async (t) => {
  const world = new MockTabWorld();
  const env = world.createEnvironment() as MockTabEnvironment;
  const primary = new BleSharedBridge(0, env, FAST);
  const secondary = new BleSharedBridge(0, world.createEnvironment(), FAST);
  t.after(() => {
    primary.release();
    secondary.release();
  });

  primary.claimPrimary();
  let lost = 0;
  secondary.subscribeAsSecondary({ onPrimaryLost: () => lost++ });

  env.dispatchWindowEvent('pagehide', {});
  assert.equal(world.storage.getItem('orphe_bridge_primary_0'), null);
  assert.equal(lost, 1);
});
