/**
 * InsoleGait — 歩容解析（STEP_ANALYSIS）
 *
 * 1) デコード・集約・CSV の単体テスト
 * 2) OrpheCoreInsole + mock transport でのライフサイクル（購読・停止・多重 start・再接続）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GAIT_CSV_HEADER, GaitAggregator, buildGaitRow, gaitRowToCsv, stepDistance } from '../../src/gait/aggregator.ts';
import { InsoleGait } from '../../src/gait/analyzer.ts';
import { decodeGaitPacket } from '../../src/gait/packet.ts';
import type { GaitPacket } from '../../src/gait/packet.ts';
import type { GaitRow, GaitStepLossInfo } from '../../src/gait/aggregator.ts';
import { OrpheCoreInsole } from '../../src/device/orphe-core-insole.ts';
import type { BeginContext, DeviceProfile, SensorSample } from '../../src/device/profile.ts';
import type { BleRequestDeviceOptions } from '../../src/ble/web-bluetooth.ts';
import type { CharacteristicId } from '../../src/protocol/uuids.ts';
import { MemoryStorage, MockBluetooth, MockDevice, flushMicrotasks } from '../helpers/mock-bluetooth.ts';

// ── packet builder ───────────────────────────────────────────────────
function packet(bytes: number[]): DataView {
  if (bytes.length !== 20) throw new Error(`packet must be 20 bytes, got ${bytes.length}`);
  return new DataView(Uint8Array.from(bytes).buffer);
}

function f32bytes(value: number): number[] {
  const dv = new DataView(new ArrayBuffer(4));
  dv.setFloat32(0, value, false);
  return [dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3)];
}

function u16bytes(value: number): number[] {
  return [(value >> 8) & 0xff, value & 0xff];
}

function overviewPacket(step: number, opts: {
  gaitType?: number; direction?: number; calorieBits?: number;
  distance?: number; stance?: number; swing?: number;
} = {}): DataView {
  const b4 = ((opts.gaitType ?? 1) << 6) | ((opts.direction ?? 1) << 3);
  return packet([
    51, 0, ...u16bytes(step), b4, 0,
    ...u16bytes(opts.calorieBits ?? 0x3e00), // f16。既定 1.5
    ...f32bytes(opts.distance ?? 12.5),
    ...f32bytes(opts.stance ?? 0.5),
    ...f32bytes(opts.swing ?? 0.25),
  ]);
}

function stridePacket(step: number, opts: { footAngle?: number; x?: number; y?: number; z?: number } = {}): DataView {
  return packet([
    51, 1, ...u16bytes(step),
    ...f32bytes(opts.footAngle ?? 5.5),
    ...f32bytes(opts.x ?? 3),
    ...f32bytes(opts.y ?? 4),
    ...f32bytes(opts.z ?? 0),
  ]);
}

function pronationPacket(step: number, opts: { landing?: number; px?: number; py?: number; pz?: number } = {}): DataView {
  return packet([
    51, 2, ...u16bytes(step),
    ...f32bytes(opts.landing ?? 1.25),
    ...f32bytes(opts.px ?? -5),
    ...f32bytes(opts.py ?? -9.4000005),
    ...f32bytes(opts.pz ?? 2),
  ]);
}

function motionPacket(step: number): DataView {
  return packet([
    51, 4, ...u16bytes(step), 0b01001010, 0,
    0x3c, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, // quat w=1
    0x38, 0x00, 0x3c, 0x00, 0x40, 0x00, // delta 0.5, 1, 2
  ]);
}

// ── 単体: デコード ───────────────────────────────────────────────────
test('decodeGaitPacket: overview / stride / pronation / motion をデコードする', () => {
  const overview = decodeGaitPacket(overviewPacket(7));
  assert.ok(overview && overview.type === 'overview');
  assert.equal(overview.step_number, 7);
  assert.equal(overview.gait_type, 'walk');
  assert.equal(overview.stride_direction, 'forward');
  assert.equal(overview.calorie, 1.5);
  assert.equal(overview.distance_m, 12.5);
  assert.equal(overview.stance_phase_s, 0.5);
  assert.equal(overview.swing_phase_s, 0.25);

  const stride = decodeGaitPacket(stridePacket(7));
  assert.ok(stride && stride.type === 'stride');
  assert.equal(stride.foot_angle, 5.5);
  assert.deepEqual([stride.stride_x, stride.stride_y, stride.stride_z], [3, 4, 0]);

  const pronation = decodeGaitPacket(pronationPacket(7));
  assert.ok(pronation && pronation.type === 'pronation');
  assert.equal(pronation.landing_force, 1.25);
  assert.equal(pronation.pronation_x, -5);

  const motion = decodeGaitPacket(motionPacket(7));
  assert.ok(motion && motion.type === 'motion');
  assert.equal(motion.gait_cycle_phase, 1);
  assert.equal(motion.quat_w, 1);
  assert.equal(motion.delta_x, 0.5);
});

test('decodeGaitPacket: 非負量の -1 sentinel は null（負値が正当な角度はそのまま）', () => {
  const overview = decodeGaitPacket(overviewPacket(1, { stance: -1, swing: 0.25, distance: -1 }));
  assert.ok(overview && overview.type === 'overview');
  assert.equal(overview.stance_phase_s, null);
  assert.equal(overview.distance_m, null);
  assert.equal(overview.swing_phase_s, 0.25);

  const stride = decodeGaitPacket(stridePacket(1, { footAngle: -12.5 }));
  assert.ok(stride && stride.type === 'stride');
  assert.equal(stride.foot_angle, -12.5); // 負値が正当

  const pronation = decodeGaitPacket(pronationPacket(1, { landing: -1 }));
  assert.ok(pronation && pronation.type === 'pronation');
  assert.equal(pronation.landing_force, null);
});

test('decodeGaitPacket: ヘッダ不一致・長さ不足・未知サブヘッダーは null', () => {
  assert.equal(decodeGaitPacket(new DataView(new ArrayBuffer(19))), null);
  const wrongHeader = overviewPacket(1);
  new Uint8Array(wrongHeader.buffer)[0] = 50;
  assert.equal(decodeGaitPacket(wrongHeader), null);
  const unknownSub = overviewPacket(1);
  new Uint8Array(unknownSub.buffer)[1] = 3;
  assert.equal(decodeGaitPacket(unknownSub), null);
});

// ── 単体: 集約と派生指標 ─────────────────────────────────────────────
function feed(aggregator: GaitAggregator, dv: DataView): GaitRow | null {
  const decoded = decodeGaitPacket(dv);
  if (!decoded || decoded.type === 'motion') return null;
  return aggregator.add(decoded);
}

test('GaitAggregator: 3種揃った歩だけ row になり、重複送信は無視される', () => {
  const aggregator = new GaitAggregator();
  assert.equal(feed(aggregator, overviewPacket(10)), null);
  assert.equal(feed(aggregator, stridePacket(10)), null);
  const row = feed(aggregator, pronationPacket(10));
  assert.ok(row);
  assert.equal(row.step_number, 10);
  assert.equal(row.gait_type, 'walk');
  assert.equal(row.duration_s, 0.75); // 0.5 + 0.25
  assert.equal(row.cadence_hz, 1 / 0.75);
  assert.equal(row.stride_norm_m, 5); // |(3,4,0)|
  assert.equal(row.speed_mps, 5 / 0.75);
  assert.equal(row.foot_strike, 'heelStrike'); // px=-5
  assert.equal(row.pronation_type, 'neutral'); // py≈-9.4

  // 2回目の送信（重複）は無視
  assert.equal(feed(aggregator, overviewPacket(10)), null);
  assert.equal(feed(aggregator, pronationPacket(10)), null);
  assert.equal(aggregator.stats().completedSteps, 1);
});

test('GaitAggregator: gap 検出と後着による取り消し', () => {
  const aggregator = new GaitAggregator();
  const losses: GaitStepLossInfo[] = [];
  aggregator.onStepLoss = (info) => losses.push(info);

  for (const dv of [overviewPacket(1), stridePacket(1), pronationPacket(1)]) feed(aggregator, dv);
  feed(aggregator, overviewPacket(3)); // step 2 が飛んだ
  assert.equal(aggregator.stats().gapSteps, 1);
  assert.deepEqual(losses[0], { reason: 'gap', steps: [2], count: 1 });

  // step 2 が遅れて届いたら gap 計上を取り消す
  feed(aggregator, overviewPacket(2));
  assert.equal(aggregator.stats().gapSteps, 0);
});

test('GaitAggregator: 揃わないまま古くなった歩は incomplete、巨大ジャンプは jump', () => {
  const aggregator = new GaitAggregator();
  const losses: GaitStepLossInfo[] = [];
  aggregator.onStepLoss = (info) => losses.push(info);

  feed(aggregator, overviewPacket(1)); // stride/pronation が来ない
  feed(aggregator, overviewPacket(9)); // 1 は STALE_STEP_DISTANCE=8 以上古い → incomplete
  const stats = aggregator.stats();
  assert.equal(stats.incompleteSteps, 1);
  assert.equal(stats.missingParts.stride, 1);
  assert.equal(stats.missingParts.pronation, 1);
  assert.equal(stats.missingParts.overview, 0);

  feed(aggregator, overviewPacket(9 + 1000)); // GAP_COUNT_LIMIT 超え → jump
  assert.equal(aggregator.stats().jumps, 1);
});

test('stepDistance: uint16 wraparound をまたいでも前進距離が正しい', () => {
  assert.equal(stepDistance(65534, 2), 4);
  assert.equal(stepDistance(2, 65534), 65532);
  assert.equal(stepDistance(5, 5), 0);
});


function rowFor(opts: Parameters<typeof overviewPacket>[1] = {}): GaitRow {
  const overview = decodeGaitPacket(overviewPacket(5, opts));
  const stride = decodeGaitPacket(stridePacket(5));
  const pronation = decodeGaitPacket(pronationPacket(5));
  assert.ok(overview?.type === 'overview' && stride?.type === 'stride' && pronation?.type === 'pronation');
  return buildGaitRow(5, { overview, stride, pronation });
}

test('buildGaitRow: 立脚期・遊脚期が欠けるか合計 0 なら duration / cadence / speed は null', () => {
  for (const opts of [{ stance: -1 }, { swing: -1 }, { stance: 0, swing: 0 }]) {
    const row = rowFor(opts);
    assert.deepEqual([row.duration_s, row.cadence_hz, row.speed_mps], [null, null, null], JSON.stringify(opts));
  }

  const noDistance = rowFor({ distance: -1 });
  assert.equal(noDistance.distance_m, null);
  assert.equal(noDistance.duration_s, 0.75); // 距離の欠損は他の指標に影響しない
});

test('gaitRowToCsv: ヘッダの並びで、整数はそのまま・小数は 4 桁・null は空欄', () => {
  assert.equal(GAIT_CSV_HEADER.split(',').length, 21);
  assert.equal(
    gaitRowToCsv(rowFor()),
    '5,walk,forward,12.5000,0.5000,0.2500,0.7500,1.3333,6.6667,5.5000,3,4,0,5,1.2500,-5,heelStrike,-9.4000,neutral,2,1.5000'
  );
  assert.equal(
    gaitRowToCsv(rowFor({ stance: -1 })),
    '5,walk,forward,12.5000,,0.2500,,,,5.5000,3,4,0,5,1.2500,-5,heelStrike,-9.4000,neutral,2,1.5000'
  );
});

test('GaitAggregator: 巻き戻りをまたいだ欠損は gap、大きな前進は step_number_jump として通知する', () => {
  const aggregator = new GaitAggregator();
  const losses: GaitStepLossInfo[] = [];
  aggregator.onStepLoss = (info) => losses.push(info);
  const rows: number[] = [];
  const add = (dv: DataView) => {
    const row = feed(aggregator, dv);
    if (row) rows.push(row.step_number);
  };

  for (const step of [65534, 1]) {
    add(overviewPacket(step));
    add(stridePacket(step));
    add(pronationPacket(step));
  }
  add(overviewPacket(1 + 1000));

  assert.deepEqual(rows, [65534, 1]);
  assert.deepEqual(losses, [
    { reason: 'gap', steps: [65535, 0], count: 2 },
    { reason: 'step_number_jump', from: 1, to: 1001, forward: 1000 },
  ]);
  assert.deepEqual(aggregator.stats(), {
    completedSteps: 2,
    incompleteSteps: 0,
    missingParts: { overview: 0, stride: 0, pronation: 0 },
    gapSteps: 2,
    jumps: 1,
    lastSeenStep: 1001,
    pendingSteps: 1,
  });
});

// ── ライフサイクル（mock transport） ──────────────────────────────────
const SERVICE_A = '01a9d6b5-ff6e-444a-b266-0be75e85c064';
const CHAR_INFO = '24354f22-1c46-430e-a4ab-a1eeabbcdfc0';
const SERVICE_B = 'db1b7aca-cda5-4453-a49b-33a53d3f0833';
const CHAR_SENSOR = 'f3f9c7ce-46ee-4205-89ac-abe64e626c0f';
const CHAR_STEP = '4eb776dc-cf99-4af7-b2d3-ad0f791a79dd';

class FakeInsoleProfile implements DeviceProfile {
  readonly kind = 'insole';
  readonly defaultNotificationType = 'SENSOR_VALUES';

  storageKey(id: number): string {
    return `orphe_gait_test_device_${id}`;
  }

  requestDeviceOptions(): BleRequestDeviceOptions {
    return { filters: [{ namePrefix: 'INS' }] };
  }

  characteristics(): Record<string, CharacteristicId> {
    return {
      DEVICE_INFORMATION: { serviceUUID: SERVICE_A, characteristicUUID: CHAR_INFO },
      SENSOR_VALUES: { serviceUUID: SERVICE_B, characteristicUUID: CHAR_SENSOR },
      STEP_ANALYSIS: { serviceUUID: SERVICE_B, characteristicUUID: CHAR_STEP },
    };
  }

  async begin(context: BeginContext): Promise<string> {
    await context.transport.startNotify('SENSOR_VALUES');
    return 'ok';
  }

  parse(uuid: string): SensorSample[] | null {
    if (uuid !== 'SENSOR_VALUES') return null;
    return null;
  }
}

function makeHarness() {
  const bluetooth = new MockBluetooth();
  const storage = new MemoryStorage();
  const device = new MockDevice('ins-1', 'INS-01');
  bluetooth.chooserQueue.push(device);
  device.gatt.getOrCreateService(SERVICE_B).getOrCreate(CHAR_SENSOR);
  const stepCharacteristic = device.gatt.getOrCreateService(SERVICE_B).getOrCreate(CHAR_STEP);
  const errors: unknown[] = [];
  const ble = new OrpheCoreInsole({
    profile: new FakeInsoleProfile(),
    id: 0,
    bluetooth,
    storage,
    events: { onError: (error) => errors.push(error) },
    wait: async () => {},
  });
  return { ble, device, stepCharacteristic, errors };
}

test('InsoleGait: start で STEP_ANALYSIS を購読し、3種揃った歩が onGait に届く', async () => {
  const h = makeHarness();
  await h.ble.begin();
  const gait = new InsoleGait(h.ble);
  const rows: GaitRow[] = [];
  const motions: unknown[] = [];
  gait.onGait = (_id, row) => rows.push(row);
  gait.onMotion = (_id, motion) => motions.push(motion);

  assert.equal(await gait.start(), true);
  assert.equal(gait.isRunning, true);

  h.stepCharacteristic.emit(overviewPacket(1));
  h.stepCharacteristic.emit(motionPacket(1));
  h.stepCharacteristic.emit(stridePacket(1));
  h.stepCharacteristic.emit(pronationPacket(1));

  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.step_number, 1);
  assert.equal(motions.length, 1);
  assert.equal(gait.stepCount, 1);
  assert.ok(gait.toCSV().includes('\n1,walk,forward,'));

  const diagnostics = gait.diagnostics();
  assert.equal(diagnostics.subscribed, true);
  assert.equal(diagnostics.transportNotifications, 4);
  assert.equal(diagnostics.validPackets, 4);
  assert.equal(diagnostics.stepLoss.completedSteps, 1);

  await gait.stop();
  assert.equal(gait.isRunning, false);
  // 停止後のパケットは届かない
  h.stepCharacteristic.emit(overviewPacket(2));
  assert.equal(gait.diagnostics().transportNotifications, 4);
});

test('InsoleGait: 未接続では start できない', async () => {
  const h = makeHarness();
  const gait = new InsoleGait(h.ble);
  assert.equal(await gait.start(), false);
  assert.equal(h.errors.length, 1);
  assert.match(String(h.errors[0]), /not connected/);
});

test('InsoleGait: 同じ OrpheCoreInsole への多重 start は失敗する（1 active gait のみ）', async () => {
  const h = makeHarness();
  await h.ble.begin();
  const first = new InsoleGait(h.ble);
  const second = new InsoleGait(h.ble);
  assert.equal(await first.start(), true);
  assert.equal(await second.start(), false);
  assert.ok(h.errors.some((error) => String(error).includes('already installed')));

  // first を止めれば second を開始できる
  await first.stop();
  assert.equal(await second.start(), true);
  await second.stop();
});

test('InsoleGait: 自動再接続後に STEP_ANALYSIS を再購読し、集約状態は維持される', async () => {
  const h = makeHarness();
  await h.ble.begin('SENSOR_VALUES', { autoReconnect: true, reconnect: { intervalMs: 0, maxAttempts: 3 } });
  const gait = new InsoleGait(h.ble);
  const rows: GaitRow[] = [];
  gait.onGait = (_id, row) => rows.push(row);
  await gait.start();

  for (const dv of [overviewPacket(1), stridePacket(1), pronationPacket(1)]) h.stepCharacteristic.emit(dv);
  assert.equal(rows.length, 1);

  h.device.gatt.simulateLinkLoss();
  await flushMicrotasks(100);
  assert.equal(h.ble.isConnected(), true); // 再接続済み

  // 再購読されて受信が続く。step 1 の重複は dedup され、step 2 は row になる
  for (const dv of [overviewPacket(1), overviewPacket(2), stridePacket(2), pronationPacket(2)]) {
    h.stepCharacteristic.emit(dv);
  }
  assert.equal(rows.length, 2);
  assert.equal(rows[1]!.step_number, 2);
  await gait.stop();
});

test('InsoleGait: refreshSubscription は rows/aggregator を維持したまま再購読する', async () => {
  const h = makeHarness();
  await h.ble.begin();
  const gait = new InsoleGait(h.ble);
  await gait.start();
  for (const dv of [overviewPacket(1), stridePacket(1), pronationPacket(1)]) h.stepCharacteristic.emit(dv);
  assert.equal(gait.rows.length, 1);

  assert.equal(await gait.refreshSubscription(), true);
  assert.equal(gait.rows.length, 1); // 維持
  for (const dv of [overviewPacket(2), stridePacket(2), pronationPacket(2)]) h.stepCharacteristic.emit(dv);
  assert.equal(gait.rows.length, 2);
  await gait.stop();
});

test('InsoleGait: waitForPacket は packet 到着で true、timeout で false', async () => {
  const h = makeHarness();
  await h.ble.begin();
  const gait = new InsoleGait(h.ble);
  await gait.start();

  const waiting = gait.waitForPacket({ timeoutMs: 1000 });
  h.stepCharacteristic.emit(overviewPacket(1));
  assert.equal(await waiting, true);

  assert.equal(await gait.waitForPacket({ timeoutMs: 10 }), false);
  await gait.stop();
});

test('InsoleGait: start をやり直すと rows はリセットされる', async () => {
  const h = makeHarness();
  await h.ble.begin();
  const gait = new InsoleGait(h.ble);
  await gait.start();
  for (const dv of [overviewPacket(1), stridePacket(1), pronationPacket(1)]) h.stepCharacteristic.emit(dv);
  assert.equal(gait.rows.length, 1);
  await gait.stop();

  await gait.start();
  assert.equal(gait.rows.length, 0);
  assert.equal(gait.diagnostics().stepLoss.completedSteps, 0);
  await gait.stop();
});

// GaitPacket 型が discriminated union として機能することの型テスト
test('型: GaitPacket の判別が効く', () => {
  const decoded: GaitPacket | null = decodeGaitPacket(overviewPacket(1));
  if (decoded && decoded.type === 'overview') {
    const calorie: number | null = decoded.calorie;
    assert.equal(calorie, 1.5);
  } else {
    assert.fail('expected overview');
  }
});

// ─── reset() ─────────────────────────────────────────────────────

test('reset(): 集約結果と診断カウンタを捨てる', () => {
  const h = makeHarness();
  const gait = new InsoleGait(h.ble);
  gait.rows.push({
    step_number: 1, gait_type: 'walk', stride_direction: 'forward',
    distance_m: 1, stance_phase_s: 1, swing_phase_s: 1, duration_s: 2,
    cadence_hz: 0.5, speed_mps: 0.5, foot_angle_deg: 0,
    stride_x_m: 0, stride_y_m: 0, stride_z_m: 0, stride_norm_m: 0,
    landing_force: 0, strike_angle_deg: 0, foot_strike: 'midfoot',
    pronation_deg: 0, pronation_type: 'neutral', pronation_z_deg: 0, calorie: 0,
  });
  assert.equal(gait.stepCount, 1);

  gait.reset();

  assert.equal(gait.stepCount, 0);
  const diagnostics = gait.diagnostics();
  assert.equal(diagnostics.transportNotifications, 0);
  assert.equal(diagnostics.validPackets, 0);
  assert.equal(diagnostics.lastTransport, null);
  assert.equal(diagnostics.stepLoss.completedSteps, 0);
});

test('reset(): 解析中は何も捨てない', async () => {
  const h = makeHarness();
  const gait = new InsoleGait(h.ble);
  await h.ble.begin('SENSOR_VALUES');
  await gait.start();
  const diagnosticsBefore = gait.diagnostics();
  gait.reset();
  assert.equal(gait.isRunning, true);
  assert.equal(gait.diagnostics().subscribed, diagnosticsBefore.subscribed);
});
