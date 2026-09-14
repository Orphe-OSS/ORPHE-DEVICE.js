/**
 * InsoleToolkitSession: FW バージョンの解決と、Step Analysis が未確認の FW での警告。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { INSOLE_TOOLKIT_STEP_UNSUPPORTED_FW, InsoleToolkitSession } from '../../src/session/insole-toolkit-session.ts';

class FakeInsole {
  id = 0;
  connected = false;
  streaming_mode = 4;
  firmwareVersion: string | null;

  constructor(firmwareVersion: string | null) {
    this.firmwareVersion = firmwareVersion;
  }

  async begin(_type: string, options: Record<string, unknown>): Promise<string> {
    this.connected = true;
    this.streaming_mode = options.streamingMode as number;
    return 'connected';
  }

  reset(): void { this.connected = false; }
  isConnected(): boolean { return this.connected; }
  async setDataStreamingMode(mode: number): Promise<void> { this.streaming_mode = mode; }
  async startNotify(): Promise<void> { }
  async stopNotify(): Promise<void> { }
  async getFirmwareVersion(): Promise<string | null> { return this.firmwareVersion; }
}

class FakeGait {
  isRunning = false;
  diagnostics?: () => unknown;
  waitForPacket?: () => Promise<boolean>;
  async start(): Promise<boolean> { this.isRunning = true; return true; }
  async stop(): Promise<void> { this.isRunning = false; }
  async refreshSubscription(): Promise<boolean> { return this.isRunning; }
}

function createSession(firmwareVersion: string | null) {
  const insole = new FakeInsole(firmwareVersion);
  const diagnostics: Array<{ type: string; firmwareVersion?: string }> = [];
  const session = new InsoleToolkitSession(insole, {
    onError() { },
    gait: {
      verifyTimeoutMs: 50,
      verifyRetries: 1,
      onDiagnostic(_deviceId: number, info: { type: string; firmwareVersion?: string }) { diagnostics.push(info); },
    },
  }, { GaitClass: FakeGait });
  return { session, gait: session.gait as unknown as FakeGait, diagnostics };
}

test('未確認 FW の一覧は凍結されていて 1.0.1 を含む', () => {
  assert.equal(Object.isFrozen(INSOLE_TOOLKIT_STEP_UNSUPPORTED_FW), true);
  assert.ok(INSOLE_TOOLKIT_STEP_UNSUPPORTED_FW.includes('1.0.1'));
});

test('既知の未確認 FW: 警告診断を 1 回だけ出し、エラー文言に FW バージョンを含める', async () => {
  const { session, gait, diagnostics } = createSession('1.0.1');
  await session.connect();
  gait.diagnostics = () => ({ transportNotifications: 0, validPackets: 0, invalidPackets: 0 });
  gait.waitForPacket = async () => false;

  const caught = await session.applyProfile('realtime-full-step').then(() => null, (error: unknown) => error) as
    { code?: string; firmwareVersion?: string; message: string } | null;
  assert.ok(caught, 'applyProfile は失敗すること');
  assert.equal(caught.code, 'GAIT_NO_NOTIFICATIONS');
  assert.equal(caught.firmwareVersion, '1.0.1');
  assert.match(caught.message, /may not support Step Analysis output \(FW 1\.0\.1\)/);

  const warned = diagnostics.filter((info) => info.type === 'fw-step-analysis-unconfirmed');
  assert.equal(warned.length, 1, '未確認FW警告は1回だけ出ること');
  assert.equal(warned[0]?.firmwareVersion, '1.0.1');
});

test('FW バージョン不明: 文言は unknown、警告診断は出ない', async () => {
  const { session, gait, diagnostics } = createSession(null);
  await session.connect();
  gait.diagnostics = () => ({ transportNotifications: 0, validPackets: 0, invalidPackets: 0 });
  gait.waitForPacket = async () => false;

  await assert.rejects(
    () => session.applyProfile('realtime-full-step'),
    (error: { code?: string; firmwareVersion?: string | null; message: string }) => error.code === 'GAIT_NO_NOTIFICATIONS'
      && error.firmwareVersion === null
      && /firmware version unknown/.test(error.message)
  );
  assert.equal(diagnostics.filter((info) => info.type === 'fw-step-analysis-unconfirmed').length, 0);
});

test('一覧外の FW: 警告診断は出ず、transport ありなら GAIT_INVALID_PACKETS', async () => {
  const { session, gait, diagnostics } = createSession('3.0.0');
  await session.connect();
  let transport = 0;
  gait.diagnostics = () => ({
    // 呼ばれるたびに増える = 購読後に transport 通知が届いている状況
    transportNotifications: (transport += 5),
    validPackets: 0,
    invalidPackets: 1,
  });
  gait.waitForPacket = async () => false;

  await assert.rejects(
    () => session.applyProfile('realtime-full-step'),
    (error: { code?: string; message: string }) => error.code === 'GAIT_INVALID_PACKETS'
      && !/may not support/.test(error.message)
  );
  assert.equal(diagnostics.filter((info) => info.type === 'fw-step-analysis-unconfirmed').length, 0);
});
