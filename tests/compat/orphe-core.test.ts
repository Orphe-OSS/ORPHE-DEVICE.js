/**
 * Orphe（互換 API）: `new Orphe(0)` + got* 代入スタイルが OrpheCoreInsole + coreProfile の上で
 * 同じように動くこと。CORE 固有コマンドとタブ間共有も含む。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Orphe } from '../../src/compat/orphe-core.ts';
import { ORPHE_UUID } from '../../src/protocol/uuids.ts';
import type { BridgeChannel, BridgeEnvironment } from '../../src/bridge.ts';
import { MemoryStorage, MockBluetooth, waitFor } from '../helpers/mock-bluetooth.ts';
import { mockCoreDevice } from '../helpers/core-device.ts';

function makeCore(id = 0, storage = new MemoryStorage(), bridgeEnvironment?: BridgeEnvironment) {
  const bluetooth = new MockBluetooth();
  const ble = new Orphe(id, {
    bluetooth,
    storage,
    wait: async () => {},
    profile: { settleMs: 0, timeSyncSamples: 1 },
    bridgeEnvironment,
    bridgeTiming: { heartbeatIntervalMs: 20, heartbeatTimeoutMs: 100, watchIntervalMs: 20, electionMaxDelayMs: 0 },
  });
  const errors: unknown[] = [];
  ble.onError = (error) => { errors.push(error); };
  return { ble, bluetooth, storage, errors };
}

/** STEP_ANALYSIS の概要パケット（sub 0）。steps と type だけ埋める */
function gaitPacket(steps: number, type: number): DataView {
  const data = new DataView(new ArrayBuffer(20));
  data.setUint8(0, 51);
  data.setUint8(1, 0);
  data.setUint16(2, steps);
  data.setUint8(4, type << 6);
  return data;
}

/** SENSOR_VALUES header 40 の単一サンプル（quat/gyro/acc は 0） */
function sensorPacket40(): DataView {
  const data = new DataView(new ArrayBuffer(20));
  data.setUint8(0, 40);
  data.setInt16(1, 16384); // quat.w = 1.0（Q14）
  return data;
}

test('begin(): DeviceInfo 読取 → range 反映書込 → 時刻同期 → 種別ごとの notify 開始', async () => {
  const { ble, bluetooth, storage, errors } = makeCore();
  const { device, deviceInfo, dateTime, sensor, step } = mockCoreDevice();
  bluetooth.chooserQueue.push(device);

  const result = await ble.begin('STEP_ANALYSIS_AND_SENSOR_VALUES', { range: { acc: 8, gyro: 1000 } });

  assert.equal(result, 'done begin(); STEP_ANALYSIS and SENSOR VALUES');
  assert.equal(ble.connectionState, 'connected');
  assert.equal(ble.bluetoothDevice, device);
  const info = ble.device_information as { battery: number; lr: number; range: { acc: number; gyro: number }; data: DataView };
  assert.equal(info.battery, 2);
  assert.equal(info.lr, 1);
  assert.deepEqual(info.range, { acc: 2, gyro: 2 });
  assert.ok(info.data instanceof DataView, '旧 API の data も参照できる');
  assert.deepEqual([...deviceInfo.written[0]!], [0x01, 1, 100, 0, 0, 0, 0, 2, 2]);
  assert.equal(dateTime.readCalls, 1);
  assert.equal(step.notifying, true);
  assert.equal(sensor.notifying, true);
  assert.equal(JSON.parse(storage.getItem('orphe_last_bluetooth_device_0')!).bluetoothId, device.id);
  assert.deepEqual(errors, []);
});

test('STEP_ANALYSIS の notify が gotGait / gotType / gotStepsNumber へ届き、状態も更新される', async () => {
  const { ble, bluetooth } = makeCore();
  const { device, step } = mockCoreDevice();
  bluetooth.chooserQueue.push(device);
  await ble.begin('STEP_ANALYSIS', {});

  const order: string[] = [];
  ble.gotStepsNumber = function (steps) { order.push(`steps:${steps.value}`); };
  ble.gotGait = function (gait) { order.push(`gait:${gait.type}`); };
  ble.gotType = function (type) { order.push(`type:${type.value}`); };
  step.emit(gaitPacket(5, 2));

  assert.deepEqual(order.slice(0, 3), ['steps:5', 'gait:2', 'type:2']);
  assert.equal(ble.steps_number, 5);
  assert.equal(ble.gait.steps, 5);
  assert.equal(ble.gait.type, 2);
});

test('SENSOR_VALUES の notify が gotQuat / gotEuler へ届く', async () => {
  const { ble, bluetooth } = makeCore();
  const { device, sensor } = mockCoreDevice();
  bluetooth.chooserQueue.push(device);
  await ble.begin('SENSOR_VALUES', {});

  const order: string[] = [];
  ble.gotQuat = function () { order.push('quat'); };
  ble.gotAcc = function () { order.push('acc'); };
  ble.gotEuler = function () { order.push('euler'); };
  sensor.emit(sensorPacket40());
  assert.deepEqual(order, ['acc', 'quat', 'euler']);
  assert.equal(ble.quat.w, 1);
});

test('CORE 固有コマンド: setLED / resetMotionSensorAttitude / resetAnalysisLogs / setMountPosition', async () => {
  const { ble, bluetooth } = makeCore();
  const { device, deviceInfo } = mockCoreDevice();
  bluetooth.chooserQueue.push(device);
  await ble.begin('STEP_ANALYSIS', {});
  deviceInfo.written.length = 0;

  await ble.setLED(1, 3);
  assert.deepEqual([...deviceInfo.written.at(-1)!], [0x02, 1, 3]);
  await ble.resetMotionSensorAttitude();
  assert.deepEqual([...deviceInfo.written.at(-1)!], [0x03]);

  ble.steps_number = 9;
  await ble.resetAnalysisLogs();
  assert.deepEqual([...deviceInfo.written.at(-1)!], [0x04]);
  assert.equal(ble.steps_number, 0);

  await ble.setMountPosition(2);
  assert.deepEqual([...deviceInfo.written.at(-1)!], [0x01, 2, 100, 0, 0, 0, 0, 3, 3]);
  await assert.rejects(() => ble.setMountPosition(7), /Invalid position/);

  await ble.setLEDBrightness(0);
  assert.deepEqual([...deviceInfo.written.at(-1)!], [0x01, 2, 0, 0, 0, 0, 0, 3, 3]);
});

test('begin() は失敗を reject で伝える（chooser キャンセル / 不正な種別）', async () => {
  const { ble, errors } = makeCore();
  await assert.rejects(() => ble.begin('STEP_ANALYSIS', {}), /cancelled/);
  assert.equal(ble.connectionState, 'disconnected');
  assert.ok(errors.length >= 1);

  const { ble: other, bluetooth } = makeCore(1);
  const { device } = mockCoreDevice();
  bluetooth.chooserQueue.push(device);
  await assert.rejects(() => other.begin('BOGUS', {}), (error: { code?: string }) => error.code === 'INVALID_MODE');
});

test('chooser は既定で CR- の名前とサービス UUID のどちらでも CORE を拾う', async () => {
  const { ble, bluetooth } = makeCore();
  await assert.rejects(() => ble.begin('STEP_ANALYSIS', {}), /cancelled/);
  assert.deepEqual(bluetooth.requestDeviceCalls[0]?.filters, [
    { namePrefix: 'CR-' },
    { services: [ORPHE_UUID.INFORMATION_SERVICE] },
  ]);

  const custom = new Orphe(1, { bluetooth, storage: new MemoryStorage(), profile: { namePrefix: 'CORE-' } });
  custom.onError = () => {};
  await assert.rejects(() => custom.begin('STEP_ANALYSIS', {}), /cancelled/);
  assert.deepEqual(bluetooth.requestDeviceCalls[1]?.filters?.[0], { namePrefix: 'CORE-' });

  custom.profile.setNamePrefix('ORPHE');
  await assert.rejects(() => custom.begin('STEP_ANALYSIS'), /cancelled/);
  assert.deepEqual(bluetooth.requestDeviceCalls[2]?.filters?.[0], { namePrefix: 'ORPHE' }, '生成後に変えた接頭辞は次の chooser から効く');
});

test('自動再接続: 切断後に同じ種別で再接続し、notify が再開する', async () => {
  const { ble, bluetooth } = makeCore();
  const { device, step } = mockCoreDevice();
  bluetooth.chooserQueue.push(device);
  bluetooth.knownDevices!.push(device);
  const events: string[] = [];
  ble.onDisconnect = () => { events.push('disconnect'); };
  ble.onReconnectSuccess = () => { events.push('success'); };
  await ble.begin('STEP_ANALYSIS', { autoReconnect: true, reconnectIntervalMs: 0, reconnectMaxAttempts: 3 });

  device.gatt.simulateLinkLoss();
  await waitFor(() => events.includes('success'), 'reconnect success');
  assert.deepEqual(events, ['disconnect', 'success']);
  assert.equal(ble.connectionState, 'connected');
  assert.equal(step.notifying, true);
  ble.stop();
});

// ─── タブ間共有 ──────────────────────────────────────────────

/** 同一オリジンの複数タブを模した環境。storage とチャネルを共有する */
class MockTabWorld {
  readonly storage = new MemoryStorage();
  private readonly channels = new Map<string, Set<FakeChannel>>();
  private readonly windowListeners = new Map<string, Set<(event: unknown) => void>>();

  createEnvironment(): BridgeEnvironment {
    const world = this;
    return {
      storage: this.storage,
      createChannel(name) { return new FakeChannel(world, name); },
      addWindowListener(type, listener) {
        if (!world.windowListeners.has(type)) world.windowListeners.set(type, new Set());
        world.windowListeners.get(type)!.add(listener);
      },
      removeWindowListener(type, listener) { world.windowListeners.get(type)?.delete(listener); },
    };
  }

  channelBus(name: string): Set<FakeChannel> {
    if (!this.channels.has(name)) this.channels.set(name, new Set());
    return this.channels.get(name)!;
  }
}

class FakeChannel implements BridgeChannel {
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
    for (const peer of this.world.channelBus(this.name)) {
      if (peer !== this && !peer.closed) peer.onmessage?.({ data: message });
    }
  }
  close(): void {
    this.closed = true;
    this.world.channelBus(this.name).delete(this);
  }
}

test('タブ間共有は既定で無効（別タブが接続中でも自分で接続する）', async () => {
  const world = new MockTabWorld();
  const first = makeCore(0, new MemoryStorage(), world.createEnvironment());
  first.bluetooth.chooserQueue.push(mockCoreDevice().device);
  await first.ble.begin('STEP_ANALYSIS');

  const second = makeCore(0, new MemoryStorage(), world.createEnvironment());
  second.bluetooth.chooserQueue.push(mockCoreDevice().device);
  assert.equal(await second.ble.begin('STEP_ANALYSIS'), 'done begin(); STEP ANALYSIS');
  assert.equal(second.ble.isBridgeSecondary, false);
  assert.equal(second.bluetooth.requestDeviceCalls.length, 1);
});

test('タブ間共有: Primary が配信し、別タブの Orphe は Secondary として got* を受ける', async () => {
  const world = new MockTabWorld();
  const primary = makeCore(0, new MemoryStorage(), world.createEnvironment());
  const { device, step } = mockCoreDevice();
  primary.bluetooth.chooserQueue.push(device);
  await primary.ble.begin('STEP_ANALYSIS', { useSharedBridge: true });
  assert.equal(primary.ble.isBridgeSecondary, false);

  const secondary = makeCore(0, new MemoryStorage(), world.createEnvironment());
  const result = await secondary.ble.begin('STEP_ANALYSIS', { useSharedBridge: true });
  assert.equal(result, 'done begin(); BRIDGE SECONDARY');
  assert.equal(secondary.ble.isBridgeSecondary, true);
  assert.equal(secondary.bluetooth.requestDeviceCalls.length, 0, 'Secondary は BLE に触らない');

  const received: number[] = [];
  secondary.ble.gotStepsNumber = function (steps) { received.push(steps.value); };
  step.emit(gaitPacket(3, 1));
  assert.deepEqual(received, [3]);
  assert.equal(secondary.ble.steps_number, 3);

  // Primary が切断すると Secondary は onDisconnect を受け、自分で接続しにいく
  let disconnected = 0;
  secondary.ble.onDisconnect = () => { disconnected++; };
  primary.ble.stop();
  await waitFor(() => disconnected === 1, 'secondary onDisconnect');
  await waitFor(() => secondary.errors.some(error => /Primary tab closed/.test(String(error))), 'secondary reconnect failure reported');
  assert.equal(secondary.ble.isBridgeSecondary, false);
});
