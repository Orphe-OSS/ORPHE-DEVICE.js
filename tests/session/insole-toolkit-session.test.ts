/**
 * InsoleToolkitSession: プロファイル切替・FIFO / Gait のライフサイクル・計測区間の記録。
 * デバイスと FIFO / Gait はフェイクで置き換え、呼び出し順を検証する。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  INSOLE_TOOLKIT_PROFILES,
  InsoleToolkitSession,
  insoleToolkitMeasurementToCSV,
  normalizeInsoleSensorDataMode,
  normalizeInsoleToolkitConfiguration,
  normalizeInsoleToolkitOutputs,
  resolveInsoleToolkitProfile,
} from '../../src/session/insole-toolkit-session.ts';
import type { InsoleSessionSensorDataEvent, InsoleToolkitSessionOptions } from '../../src/session/insole-toolkit-session.ts';

type Listener = (event: InsoleSessionSensorDataEvent) => void;
type Callback = ((...args: never[]) => void) | null | undefined;

class FakeInsole {
  id: number;
  connected = false;
  streaming_mode = 4;
  calls: string[] = [];
  sensorDataListeners = new Set<Listener>();
  reconnectHooks: Array<() => unknown> = [];

  constructor(id = 0) {
    this.id = id;
  }

  async begin(type: string, options: Record<string, unknown>): Promise<string> {
    this.calls.push(`begin:${type}:${options.streamingMode}`);
    this.connected = true;
    this.streaming_mode = options.streamingMode as number;
    return 'connected';
  }

  reset(): void {
    this.calls.push('reset');
    this.connected = false;
  }

  isConnected(): boolean {
    return this.connected;
  }

  async setDataStreamingMode(mode: number): Promise<void> {
    this.calls.push(`mode:${mode}`);
    this.streaming_mode = mode;
  }

  async startNotify(type: string): Promise<void> {
    this.calls.push(`notify:start:${type}`);
  }

  async stopNotify(type: string): Promise<void> {
    this.calls.push(`notify:stop:${type}`);
  }

  addSensorDataListener(listener: Listener): () => boolean {
    this.sensorDataListeners.add(listener);
    return () => this.sensorDataListeners.delete(listener);
  }

  addAfterReconnectSuccessHook(hook: () => unknown): () => void {
    this.reconnectHooks.push(hook);
    return () => { this.reconnectHooks = this.reconnectHooks.filter(h => h !== hook); };
  }

  emitPacket(serialNumber: number, samples: unknown[]): void {
    const packet = { header: 50, serial_number: serialNumber, timestamp: 1000, samples };
    for (const listener of this.sensorDataListeners) {
      listener({ packet });
    }
  }
}

const checkpoint = { captureId: 1, serial: 99, dropped: 0, collected: 0 };

class FakeFifo {
  insole: FakeInsole;
  startResult = true;
  onSamples: Callback = null;
  onStopped: Callback = null;
  summary = {
    available: true,
    first: 100,
    last: 101,
    expected: 2,
    received: 2,
    missing: 0,
    missingRate: 0,
    dropped: 0,
    checkpoint,
  };

  constructor(insole: FakeInsole) {
    this.insole = insole;
  }

  async start(): Promise<boolean> {
    this.insole.calls.push('fifo:start');
    return this.startResult;
  }

  async stop(): Promise<Map<number, DataView>> {
    this.insole.calls.push('fifo:stop');
    (this.onSamples as ((id: number, samples: unknown[]) => void) | null)?.(this.insole.id, [{
      timestamp: 1010,
      serial_number: 101,
      packet_number: 0,
      converted_acc: { x: 0, y: 0, z: 1 },
      converted_gyro: { x: 0, y: 0, z: 0 },
      press: { values: [1, 2, 3, 4, 5, 6] },
    }]);
    (this.onStopped as ((info: unknown) => void) | null)?.({ reason: 'manual' });
    return new Map();
  }

  createCheckpoint(): typeof checkpoint {
    return checkpoint;
  }

  summarizeSince(given: typeof checkpoint): FakeFifo['summary'] {
    assert.equal(given, checkpoint);
    return this.summary;
  }

  emitSamples(samples: unknown[]): void {
    (this.onSamples as ((id: number, samples: unknown[]) => void) | null)?.(this.insole.id, samples);
  }
}

class FakeGait {
  insole: FakeInsole;
  startResult = true;
  isRunning = false;
  onRaw: Callback = null;
  onGait: Callback = null;
  diagnostics?: () => unknown;
  waitForPacket?: () => Promise<boolean>;

  constructor(insole: FakeInsole) {
    this.insole = insole;
  }

  async start(): Promise<boolean> {
    this.insole.calls.push('gait:start');
    this.isRunning = this.startResult;
    return this.startResult;
  }

  async stop(): Promise<void> {
    this.insole.calls.push('gait:stop');
    this.isRunning = false;
  }

  async refreshSubscription(): Promise<boolean> {
    this.insole.calls.push('gait:refresh');
    return this.isRunning;
  }

  emitPacket(packet: unknown): void {
    (this.onRaw as ((id: number, packet: unknown) => void) | null)?.(this.insole.id, packet);
  }

  emitRow(row: unknown): void {
    (this.onGait as ((id: number, row: unknown) => void) | null)?.(this.insole.id, row);
  }
}

function createSession(options: InsoleToolkitSessionOptions = {}) {
  const insole = new FakeInsole();
  const session = new InsoleToolkitSession(insole, { onError() {}, ...options }, {
    FifoClass: FakeFifo,
    GaitClass: FakeGait,
  });
  const fifo = session.fifo as unknown as FakeFifo;
  const gait = session.gait as unknown as FakeGait;
  return { insole, session, fifo, gait };
}

function hasCode(code: string) {
  return (error: unknown) => (error as { code?: string }).code === code;
}

test('プロファイルと設定の正規化', () => {
  assert.equal(Object.isFrozen(INSOLE_TOOLKIT_PROFILES), true);
  assert.equal(Object.isFrozen(INSOLE_TOOLKIT_PROFILES['fifo-recording']), true);
  assert.equal(resolveInsoleToolkitProfile('realtime-full').streamingMode, 4);
  assert.throws(() => resolveInsoleToolkitProfile('does-not-exist'), hasCode('PROFILE_NOT_FOUND'));
  assert.deepEqual(
    normalizeInsoleToolkitConfiguration(
      { outputs: { stepAnalysis: true } },
      {
        streamingMode: 4,
        sensorDataMode: 'realtime',
        outputs: { sensorValues: true, stepAnalysis: false },
      }
    ),
    {
      streamingMode: 4,
      sensorDataMode: 'realtime',
      outputs: { sensorValues: true, stepAnalysis: true },
    }
  );
  assert.deepEqual(normalizeInsoleToolkitOutputs(), { sensorValues: true, stepAnalysis: false });
  assert.equal(normalizeInsoleSensorDataMode('fifo'), 'fifo');
  assert.equal(normalizeInsoleSensorDataMode('unknown'), 'realtime');
  assert.throws(
    () => normalizeInsoleToolkitOutputs({ sensorValues: false, stepAnalysis: false }),
    hasCode('NO_DATA_OUTPUT')
  );
  assert.throws(
    () => normalizeInsoleToolkitConfiguration({
      streamingMode: 4,
      sensorDataMode: 'fifo',
      outputs: { sensorValues: false, stepAnalysis: true },
    }),
    hasCode('FIFO_REQUIRES_SENSOR_VALUES')
  );
  assert.throws(
    () => normalizeInsoleToolkitConfiguration({ sensorDataMode: 'batch' }),
    hasCode('INVALID_SENSOR_DATA_MODE')
  );
});

test('connect: SENSOR_VALUES で begin し、Realtime Full になる', async () => {
  const { insole, session } = createSession();
  await session.connect();
  assert.equal(session.connected, true);
  assert.equal(session.sensorNotifyActive, true);
  assert.equal(session.fifoActive, false);
  assert.equal(session.gaitActive, false);
  assert.equal(session.profileId, 'realtime-full');
  assert.deepEqual(insole.calls, ['begin:SENSOR_VALUES:4']);
});

test('出力と取得経路の切替順序', async () => {
  const { insole, session } = createSession();
  await session.connect();
  insole.calls.length = 0;
  await session.setOutputs({ sensorValues: true, stepAnalysis: true });
  assert.equal(session.gaitActive, true);
  assert.deepEqual(insole.calls, ['gait:start']);

  insole.calls.length = 0;
  await session.setOutputs({ sensorValues: false, stepAnalysis: true });
  assert.equal(session.sensorNotifyActive, false);
  assert.deepEqual(insole.calls, ['notify:stop:SENSOR_VALUES']);

  insole.calls.length = 0;
  await assert.rejects(() => session.setSensorDataMode('fifo'), hasCode('FIFO_REQUIRES_SENSOR_VALUES'));
  assert.deepEqual(session.outputs, { sensorValues: false, stepAnalysis: true });
  assert.equal(session.fifoActive, false);
  assert.deepEqual(insole.calls, []);

  await session.applyProfile('fifo-recording');
  assert.equal(session.fifoActive, true);
  assert.deepEqual(insole.calls, [
    'gait:stop',
    'mode:4',
    'notify:start:SENSOR_VALUES',
    'fifo:start',
  ]);

  insole.calls.length = 0;
  await session.setSensorDataMode('realtime');
  assert.equal(session.fifoActive, false);
  assert.deepEqual(insole.calls, ['fifo:stop']);
});

test('Step-only は実 packet の到着を確認してから SENSOR_VALUES を止める', async () => {
  const { insole, session, gait } = createSession({ gait: { verifyTimeoutMs: 200, verifyRetries: 2 } });
  await session.connect();
  gait.diagnostics = () => ({ transportNotifications: 1, validPackets: 1, invalidPackets: 0 });
  gait.waitForPacket = async () => {
    insole.calls.push('gait:wait');
    return true;
  };
  insole.calls.length = 0;

  await session.applyProfile('step-analysis');
  assert.deepEqual(insole.calls, [
    'gait:start',
    'gait:wait',
    'notify:stop:SENSOR_VALUES',
  ], 'Step-onlyは実packet確認後にSENSOR_VALUESを停止');
  assert.equal((session.snapshot().gaitDiagnostics as { validPackets: number }).validPackets, 1);

  insole.calls.length = 0;
  await session.applyProfile('step-analysis');
  assert.deepEqual(
    insole.calls,
    ['mode:4', 'notify:start:SENSOR_VALUES', 'gait:wait', 'notify:stop:SENSOR_VALUES'],
    '同じStep profileの再適用でも現在の実packetを確認'
  );
});

test('無通知なら mode 再適用と STEP_ANALYSIS 再購読を行う', async () => {
  const { insole, session, gait } = createSession({ gait: { verifyTimeoutMs: 200, verifyRetries: 2 } });
  await session.connect();
  let validPackets = 0;
  let waits = 0;
  gait.diagnostics = () => ({ transportNotifications: validPackets, validPackets, invalidPackets: 0 });
  gait.waitForPacket = async () => {
    insole.calls.push('gait:wait');
    waits++;
    if (waits === 1) return false;
    validPackets = 1;
    return true;
  };
  insole.calls.length = 0;

  await session.applyProfile('realtime-full-step');
  assert.deepEqual(insole.calls, [
    'gait:start',
    'gait:wait',
    'mode:4',
    'gait:refresh',
    'gait:wait',
  ], '無通知時はmode再適用とSTEP_ANALYSIS再購読を行う');
  assert.equal(session.gaitActive, true);
});

test('全試行で有効 packet が無ければ GAIT_NO_NOTIFICATIONS で元の profile に戻す', async () => {
  const { insole, session, gait } = createSession({ gait: { verifyTimeoutMs: 200, verifyRetries: 2 } });
  await session.connect();
  gait.diagnostics = () => ({ transportNotifications: 7, validPackets: 5, invalidPackets: 2 });
  gait.waitForPacket = async () => {
    insole.calls.push('gait:wait');
    return false;
  };
  insole.calls.length = 0;

  await assert.rejects(() => session.applyProfile('realtime-full-step'), hasCode('GAIT_NO_NOTIFICATIONS'));
  assert.equal(session.gaitActive, false);
  assert.equal(session.profileId, 'realtime-full', '失敗時は元profileへrollback');
  assert.deepEqual(session.outputs, { sensorValues: true, stepAnalysis: false });
  assert.equal(insole.calls.filter((call) => call === 'gait:wait').length, 3);
  assert.equal(insole.calls.filter((call) => call === 'gait:refresh').length, 2);
  assert.equal(insole.calls.at(-1), 'gait:stop');
});

test('transport はあるが有効 packet が無ければ GAIT_INVALID_PACKETS', async () => {
  const { session, gait } = createSession({ gait: { verifyTimeoutMs: 200, verifyRetries: 0 } });
  await session.connect();
  let invalidTransportArrived = false;
  gait.diagnostics = () => ({
    transportNotifications: invalidTransportArrived ? 3 : 0,
    validPackets: 0,
    invalidPackets: invalidTransportArrived ? 3 : 0,
  });
  gait.waitForPacket = async () => {
    invalidTransportArrived = true;
    return false;
  };
  await assert.rejects(
    () => session.applyProfile('step-analysis'),
    (error: { code?: string; transportDelta?: number; invalidDelta?: number }) => (
      error.code === 'GAIT_INVALID_PACKETS'
      && error.transportDelta === 3
      && error.invalidDelta === 3
    )
  );
});

test('Step Analysis 中は FIFO を選べない', async () => {
  const { insole, session } = createSession();
  await session.connect();
  await session.setOutputs({ sensorValues: true, stepAnalysis: true });
  insole.calls.length = 0;

  await assert.rejects(() => session.setSensorDataMode('fifo'), hasCode('FIFO_STEP_INCOMPATIBLE'));
  assert.equal(session.sensorDataMode, 'realtime');
  assert.equal(session.fifoActive, false);
  assert.equal(session.gaitActive, true);
  assert.deepEqual(insole.calls, []);

  assert.throws(
    () => createSession({ sensorDataMode: 'fifo', outputs: { sensorValues: true, stepAnalysis: true } }),
    hasCode('FIFO_STEP_INCOMPATIBLE')
  );
});

test('不正な出力・モードは現在の設定を変えない', async () => {
  const { insole, session } = createSession();
  await session.connect();
  await assert.rejects(
    () => session.setOutputs({ sensorValues: false, stepAnalysis: false }),
    hasCode('NO_DATA_OUTPUT')
  );
  assert.deepEqual(session.outputs, { sensorValues: true, stepAnalysis: false });

  await assert.rejects(() => session.setStreamingMode(2), hasCode('INVALID_MODE'));
  assert.equal(session.streamingMode, 4);
  assert.equal(insole.streaming_mode, 4);
});

test('FIFO の開始に失敗したら Realtime のまま', async () => {
  const { insole, session, fifo } = createSession();
  await session.connect();
  fifo.startResult = false;
  await assert.rejects(() => session.setSensorDataMode('fifo'), hasCode('FIFO_START_FAILED'));
  assert.equal(session.sensorDataMode, 'realtime');
  assert.equal(session.fifoActive, false);
  assert.equal(insole.streaming_mode, 4);
});

test('再接続後は Step 購読の後に SENSOR_VALUES を止め直す', async () => {
  const { insole, session } = createSession({ outputs: { sensorValues: false, stepAnalysis: true } });
  await session.connect();
  assert.equal(session.sensorNotifyActive, false);
  insole.calls.length = 0;
  for (const hook of insole.reconnectHooks) hook();
  await session.whenIdle();
  assert.deepEqual(insole.calls, ['gait:start', 'notify:stop:SENSOR_VALUES']);
});

test('並行した設定変更は直列に適用され、最後の状態に収束する', async () => {
  const { session } = createSession();
  await session.connect();
  await Promise.all([
    session.setSensorDataMode('fifo'),
    session.setSensorDataMode('realtime'),
    session.setOutputs({ sensorValues: true, stepAnalysis: true }),
  ]);
  assert.equal(session.sensorDataMode, 'realtime');
  assert.equal(session.fifoActive, false);
  assert.equal(session.gaitActive, true);
});

test('Realtime 計測: 上限・歩容 row・CSV・多重 stop', async () => {
  const { insole, session, gait } = createSession();
  await session.connect();
  await session.startMeasurement({
    profile: 'realtime-full-step',
    metadata: { participant: 'P001' },
    maxSamples: 1,
    maxStepRows: 1,
  });
  assert.equal(session.measurementPhase, 'recording');
  assert.equal(insole.sensorDataListeners.size, 1);
  insole.emitPacket(10, [{
    timestamp: 1000,
    serial_number: 10,
    packet_number: 0,
    acc: { x: 0, y: 0, z: 1 },
    press: { values: [1, 2, 3, 4, 5, 6] },
  }, {
    timestamp: 1010,
    serial_number: 10,
    packet_number: 1,
    acc: { x: 0, y: 0, z: 1 },
    press: { values: [6, 5, 4, 3, 2, 1] },
  }]);
  gait.emitPacket({ type: 'overview', step_number: 1 });
  gait.emitRow({ step_number: 1, gait_type: 'walk' });
  gait.emitRow({ step_number: 2, gait_type: 'walk' });

  await assert.rejects(() => session.applyProfile('step-analysis'), hasCode('MEASUREMENT_ACTIVE'));

  const result = (await session.stopMeasurement({ reason: 'test' }))!;
  assert.equal(result.status, 'completed');
  assert.equal(result.reason, 'test');
  assert.equal(result.raw.packets, 1);
  assert.equal(result.raw.samples.length, 1);
  assert.equal(result.raw.truncated, true);
  assert.equal(result.raw.serial.missing, 0);
  assert.equal(result.step.packets, 1);
  assert.equal(result.step.rows.length, 1);
  assert.equal(result.step.truncated, true);
  assert.equal(result.metadata.participant, 'P001');
  assert.equal(session.measurementPhase, 'idle');
  assert.equal(insole.sensorDataListeners.size, 0);
  const last = session.snapshot().lastMeasurement as { raw: { samples: unknown } };
  assert.equal(last.raw.samples, 1);
  assert.equal(Array.isArray(last.raw.samples), false);
  assert.match(insoleToolkitMeasurementToCSV(result), /serial_number/);
  assert.match(insoleToolkitMeasurementToCSV(result, 'step'), /step_number/);
  assert.equal(await session.stopMeasurement(), result);
});

test('FIFO 計測: drain 中のサンプルも含め、終了後は Realtime Full に戻る', async () => {
  const { session, fifo } = createSession();
  await session.connect();
  await session.startMeasurement({ profile: 'fifo-recording' });
  fifo.emitSamples([{
    timestamp: 1000,
    serial_number: 100,
    packet_number: 0,
    converted_acc: { x: 0, y: 0, z: 1 },
    converted_gyro: { x: 0, y: 0, z: 0 },
    press: { values: [1, 2, 3, 4, 5, 6] },
  }]);
  const result = (await session.stopMeasurement())!;
  assert.equal(result.raw.samples.length, 2, 'drain samples are included');
  assert.equal(result.raw.serial.first, 100);
  assert.equal(result.raw.serial.last, 101);
  assert.equal(result.raw.serial.missing, 0);
  assert.equal(session.profileId, 'realtime-full');
  assert.equal(session.fifoActive, false);
  assert.equal(session.measurementPhase, 'idle');
});

for (const previousProfile of ['realtime-full-step', 'step-analysis']) {
  test(`FIFO 計測の終了後は直前の ${previousProfile} に戻る`, async () => {
    const { session } = createSession();
    await session.connect();
    await session.applyProfile(previousProfile);
    await session.startMeasurement({
      profile: 'fifo-recording',
      metadata: { source: 'showcase-fifo-card' },
    });
    assert.equal(session.profileId, 'fifo-recording');
    assert.equal(session.fifoActive, true);
    assert.equal(session.gaitActive, false);

    await session.stopMeasurement({ reason: 'test' });
    assert.equal(session.profileId, previousProfile);
    assert.equal(session.fifoActive, false);
    assert.equal(session.gaitActive, true);
    assert.deepEqual(
      session.outputs,
      previousProfile === 'step-analysis'
        ? { sensorValues: false, stepAnalysis: true }
        : { sensorValues: true, stepAnalysis: true }
    );
  });
}

test('FIFO 計測後の Step 復元に失敗したら Realtime Full に退避し、結果は error.measurement に残す', async () => {
  const { insole, session, gait } = createSession({ gait: { verifyTimeoutMs: 200, verifyRetries: 0 } });
  await session.connect();
  gait.diagnostics = () => ({ transportNotifications: 0, validPackets: 0, invalidPackets: 0 });
  let gaitPacketsAvailable = true;
  gait.waitForPacket = async () => gaitPacketsAvailable;
  await session.applyProfile('realtime-full-step');
  await session.startMeasurement({ profile: 'fifo-recording' });
  gaitPacketsAvailable = false;

  await assert.rejects(
    () => session.stopMeasurement({ reason: 'restore-liveness-failed' }),
    (error: { code?: string; measurement?: { status?: string } }) => (
      error.code === 'GAIT_NO_NOTIFICATIONS'
      && error.measurement?.status === 'completed'
    )
  );
  assert.equal(session.profileId, 'realtime-full', '復元失敗時はFIFOへrollbackしない');
  assert.equal(session.fifoActive, false);
  assert.equal(session.gaitActive, false);
  assert.equal(session.sensorNotifyActive, true);
  assert.equal(session.activeMeasurement, null);
  assert.equal(session.measurementPhase, 'idle');
  assert.equal(session.lastMeasurement?.status, 'completed');
  assert.equal(insole.calls.filter((call) => call === 'fifo:start').length, 1);
});

test('計測区間のシリアル集計は uint16 の巻き戻りと順序入れ替わりに対応する', async () => {
  const { insole, session } = createSession();
  await session.connect();
  await session.startMeasurement({ profile: 'realtime-full' });
  for (const serial of [65534, 65535, 1, 0]) {
    insole.emitPacket(serial, [{
      timestamp: 1000,
      serial_number: serial,
      packet_number: 0,
      acc: { x: 0, y: 0, z: 1 },
    }]);
  }
  const result = (await session.stopMeasurement())!;
  assert.deepEqual(result.raw.serial, {
    first: 65534,
    last: 1,
    expected: 4,
    received: 4,
    missing: 0,
    missingRate: 0,
  });
});

test('計測中の disconnect は FIFO を止めて reset し、結果を残す', async () => {
  const { insole, session } = createSession();
  await session.connect();
  await session.startMeasurement({ profile: 'fifo-recording' });
  insole.calls.length = 0;
  await session.disconnect();
  assert.deepEqual(insole.calls, ['fifo:stop', 'reset']);
  assert.equal(session.activeMeasurement, null);
  assert.equal(session.measurementPhase, 'idle');
  assert.equal(session.lastMeasurement?.status, 'completed');
});

test('FIFO / Gait が無いセッションではそれぞれのプロファイルを選べない', async () => {
  const insole = new FakeInsole();
  const session = new InsoleToolkitSession(insole, { onError() {} }, { FifoClass: null, GaitClass: null });
  await assert.rejects(() => session.applyProfile('fifo-recording'), hasCode('FIFO_UNAVAILABLE'));
  await assert.rejects(() => session.applyProfile('step-analysis'), hasCode('GAIT_UNAVAILABLE'));
});

test('insoleToolkitMeasurementToCSV: 不正な入力', () => {
  assert.throws(() => insoleToolkitMeasurementToCSV(null), hasCode('INVALID_MEASUREMENT'));
  assert.throws(() => insoleToolkitMeasurementToCSV({ raw: { samples: [] } }, 'binary'), hasCode('INVALID_CSV_KIND'));
});

test('addStateListener: 状態変化のたびに呼ばれ、解除できる', async () => {
  const { session } = createSession();
  let calls = 0;
  const remove = session.addStateListener(() => { calls++; });
  await session.connect();
  assert.ok(calls >= 2, '遷移の開始と終了で通知される');
  remove();
  const before = calls;
  await session.setStreamingMode(3);
  assert.equal(calls, before);
});
