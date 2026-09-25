/**
 * InsoleToolkitSession — 1 台の OrpheInsole に対する通知と FIFO / Gait のライフサイクルを直列化する。
 *
 * 画面を持たない計測セッション管理。InsoleToolkit の設定モーダルもこのセッション経由で操作するため、
 * 独自の記録 UI から使っても通知の所有状態を共有できる。
 * UI からの高速な切替でも sink の二重所有や FIFO drain 中の reset を起こさない。
 */

/** Toolkit の計測設定で使うエラー（code で原因を判別する） */
export interface InsoleToolkitError extends Error {
  code: string;
  [key: string]: unknown;
}

/** SENSOR_VALUES / STEP_ANALYSIS のどちらを取得するか */
export interface InsoleToolkitOutputs {
  sensorValues: boolean;
  stepAnalysis: boolean;
}

/** SENSOR_VALUES の取得経路 */
export type InsoleSensorDataMode = 'realtime' | 'fifo';

/** セッションの低レベル設定 */
export interface InsoleToolkitConfiguration {
  streamingMode: number;
  sensorDataMode: InsoleSensorDataMode;
  outputs: InsoleToolkitOutputs;
}

/** 設定の入力（省略したキーは現在値を引き継ぐ） */
export interface InsoleToolkitConfigurationInput {
  streamingMode?: number;
  sensorDataMode?: string;
  outputs?: Partial<InsoleToolkitOutputs>;
}

/** 実機検証済みの計測プロファイル */
export interface InsoleToolkitProfile extends InsoleToolkitConfiguration {
  readonly id: string;
  readonly label: string;
  readonly shortLabel: string;
  readonly transport: 'notify' | 'request-response';
  readonly sampleHz: number | null;
  readonly fields: Readonly<Record<'acc' | 'gyro' | 'press' | 'quat' | 'step', boolean>>;
  readonly recommendedFor: readonly string[];
  readonly cautions: readonly string[];
}

/** 名前付きプロファイル、または id / label を持てるカスタム構成 */
export type InsoleToolkitProfileInput =
  | string
  | (InsoleToolkitConfigurationInput & { id?: string; label?: string });

/** resolveInsoleToolkitProfile() の戻り値 */
export type ResolvedInsoleToolkitProfile =
  | InsoleToolkitProfile
  | (InsoleToolkitConfiguration & { id: string; label: string });

/** セッションが操作するデバイス（OrpheInsole / OrpheInsoleSimulator） */
export interface InsoleSessionDevice {
  id?: number;
  streaming_mode?: number | undefined;
  lastStatus?: { version?: string | null } | null;
  begin(type: string, options: Record<string, unknown>): Promise<unknown>;
  reset(): void;
  isConnected?(): boolean;
  setDataStreamingMode(mode: number): Promise<unknown>;
  startNotify(uuid: string): Promise<unknown>;
  stopNotify(uuid: string): Promise<unknown>;
  addSensorDataListener?(listener: (event: InsoleSessionSensorDataEvent) => void): () => unknown;
  getFirmwareVersion?(): Promise<string | null>;
  addAfterReconnectSuccessHook?(hook: () => unknown): () => void;
}

/** addSensorDataListener() から届くイベント（計測記録に使う部分） */
export interface InsoleSessionSensorDataEvent {
  packet?: { serial_number?: number; samples?: unknown[] } | null;
}

type Callback = ((...args: never[]) => void) | null | undefined;

/** FIFO 収録モジュール（OrpheInsoleFifo） */
export interface InsoleSessionFifo {
  start(): Promise<unknown>;
  stop(): Promise<unknown>;
  createCheckpoint?(): unknown;
  summarizeSince?(checkpoint: never): unknown;
  onSamples?: Callback;
  onProgress?: Callback;
  onAnomaly?: Callback;
  onDataLoss?: Callback;
  onStopped?: Callback;
  onError?: Callback;
}

/** Gait（STEP_ANALYSIS）モジュール（OrpheInsoleGait） */
export interface InsoleSessionGait {
  isRunning?: boolean;
  start(): Promise<unknown>;
  stop(): Promise<unknown>;
  refreshSubscription?(): Promise<unknown>;
  diagnostics?(): unknown;
  waitForPacket?(options: { afterCount: number; timeoutMs: number }): Promise<unknown>;
  onGait?: Callback;
  onMotion?: Callback;
  onTransport?: Callback;
  onDiagnostic?: Callback;
  onStepLoss?: Callback;
  onRaw?: Callback;
  onError?: Callback;
}

type ModuleConstructor<T> = new (insole: never, options: never) => T;

/** FIFO / Gait の実装クラス。null ならその機能は選択できない */
export interface InsoleSessionAdapters {
  FifoClass?: ModuleConstructor<InsoleSessionFifo> | null;
  GaitClass?: ModuleConstructor<InsoleSessionGait> | null;
}

type ModuleCallbacks = Record<string, unknown>;

/** セッションのオプション（残りのキーは begin() へ透過する） */
export interface InsoleToolkitSessionOptions extends Record<string, unknown> {
  profile?: InsoleToolkitProfileInput;
  streamingMode?: number;
  sensorDataMode?: InsoleSensorDataMode;
  outputs?: Partial<InsoleToolkitOutputs>;
  simulator?: boolean;
  fifo?: ModuleCallbacks | false;
  gait?: ModuleCallbacks | false;
  onError?: (error: unknown, snapshot: InsoleToolkitSessionSnapshot) => void;
  onStateChange?: (snapshot: InsoleToolkitSessionSnapshot) => void;
}

/** 計測区間のシリアル連続性 */
export interface InsoleMeasurementSerialSummary {
  first: number | null;
  last: number | null;
  expected: number;
  received: number;
  missing: number;
  missingRate: number;
}

type MeasurementSample = Record<string, unknown>;
type MeasurementRow = Record<string, unknown>;

interface MeasurementRaw {
  packets: number;
  samples: MeasurementSample[];
  serials: Set<number>;
  firstSerial: number | null;
  lastSerial: number | null;
  lastForwardSerial: number | null;
  maxSerialDistance: number;
  truncated: boolean;
}

interface FifoSummaryLike {
  available?: boolean;
  first: number | null;
  last: number | null;
  expected: number;
  received: number;
  missing: number;
  missingRate: number;
  [key: string]: unknown;
}

interface Measurement {
  id: number;
  deviceId: number;
  status: 'recording' | 'draining' | 'completed';
  reason: string | null;
  startedAt: number;
  endedAt: number | null;
  durationMs: number | null;
  profileId: string;
  profile: ResolvedInsoleToolkitProfile;
  previousConfiguration: InsoleToolkitConfiguration;
  previousProfileId: string;
  metadata: Record<string, unknown>;
  limits: { maxSamples: number; maxStepRows: number };
  raw: MeasurementRaw;
  step: {
    packets: number;
    typeCounts: Record<'motion' | 'overview' | 'stride' | 'pronation', number>;
    rows: MeasurementRow[];
    truncated: boolean;
  };
  fifoCheckpoint: unknown;
  fifoSummary: FifoSummaryLike | null;
  restoreProfile: boolean | undefined;
}

/** 計測中の状態（件数だけを持つ軽量スナップショット） */
export interface InsoleMeasurementSnapshot {
  id: number;
  deviceId: number;
  status: Measurement['status'];
  reason: string | null;
  startedAt: number;
  endedAt: number | null;
  durationMs: number | null;
  profileId: string;
  metadata: Record<string, unknown>;
  raw: { packets: number; samples: number; serial: InsoleMeasurementSerialSummary; truncated: boolean };
  step: { packets: number; typeCounts: Record<string, number>; rows: number; truncated: boolean };
  fifo: FifoSummaryLike | null;
}

/** stopMeasurement() の結果（記録したサンプルと歩容 row を含む） */
export interface InsoleMeasurementResult extends Omit<InsoleMeasurementSnapshot, 'raw' | 'step'> {
  profile: ResolvedInsoleToolkitProfile;
  raw: { packets: number; samples: MeasurementSample[]; serial: InsoleMeasurementSerialSummary; truncated: boolean };
  step: { packets: number; typeCounts: Record<string, number>; rows: MeasurementRow[]; truncated: boolean };
}

/** snapshot() の戻り値 */
export interface InsoleToolkitSessionSnapshot {
  connected: boolean;
  transitioning: boolean;
  profileId: string;
  profile: InsoleToolkitProfile | null;
  streamingMode: number;
  sensorDataMode: InsoleSensorDataMode;
  outputs: InsoleToolkitOutputs;
  sensorNotifyActive: boolean;
  fifoActive: boolean;
  gaitActive: boolean;
  measurementPhase: 'idle' | 'recording' | 'draining';
  measurement: InsoleMeasurementSnapshot | null;
  lastMeasurement: Record<string, unknown> | null;
  supportsFifo: boolean;
  supportsStepAnalysis: boolean;
  gaitDiagnostics: unknown;
  lastError: unknown;
}

interface GaitCounters {
  validPackets?: number;
  transportNotifications?: number;
  invalidPackets?: number;
}

/**
 * STEP_ANALYSIS 通知が実測で確認できていないファームウェアバージョンの一覧。
 * 該当 FW で Step Analysis を有効化しようとしたときに警告を出す（原因の断定ではなく切り分けの手がかり）。
 */
export const INSOLE_TOOLKIT_STEP_UNSUPPORTED_FW: readonly string[] = Object.freeze(['1.0.1']);

function freezeInsoleToolkitProfile(profile: InsoleToolkitProfile): InsoleToolkitProfile {
  return Object.freeze({
    ...profile,
    outputs: Object.freeze({ ...profile.outputs }),
    fields: Object.freeze({ ...profile.fields }),
    recommendedFor: Object.freeze([...(profile.recommendedFor || [])]),
    cautions: Object.freeze([...(profile.cautions || [])]),
  });
}

/**
 * 実機検証済みの計測プロファイル。
 * アプリは低レベル設定を順番に変更せず、applyProfile(id) で原子的に切り替える。
 */
export const INSOLE_TOOLKIT_PROFILES: Readonly<Record<string, InsoleToolkitProfile>> = Object.freeze({
  'realtime-orientation': freezeInsoleToolkitProfile({
    id: 'realtime-orientation',
    label: 'Realtime Orientation',
    shortLabel: 'Realtime orientation stream',
    streamingMode: 1,
    sensorDataMode: 'realtime',
    outputs: { sensorValues: true, stepAnalysis: false },
    transport: 'notify',
    sampleHz: 200,
    fields: { acc: true, gyro: true, press: false, quat: true, step: false },
    recommendedFor: ['orientation visualization', 'low-latency interaction'],
    cautions: ['press is not included', 'missed Realtime notifications cannot be retransmitted'],
  }),
  'realtime-pressure': freezeInsoleToolkitProfile({
    id: 'realtime-pressure',
    label: 'Realtime Pressure + IMU',
    shortLabel: 'Realtime pressure and IMU stream',
    streamingMode: 3,
    sensorDataMode: 'realtime',
    outputs: { sensorValues: true, stepAnalysis: false },
    transport: 'notify',
    sampleHz: 200,
    fields: { acc: true, gyro: true, press: true, quat: false, step: false },
    recommendedFor: ['contact and rhythm detection', 'high-rate pressure visualization'],
    cautions: ['quat is not included', 'missed Realtime notifications cannot be retransmitted'],
  }),
  'realtime-full': freezeInsoleToolkitProfile({
    id: 'realtime-full',
    label: 'Realtime Full Sensor',
    shortLabel: 'Realtime full-sensor stream',
    streamingMode: 4,
    sensorDataMode: 'realtime',
    outputs: { sensorValues: true, stepAnalysis: false },
    transport: 'notify',
    sampleHz: 100,
    fields: { acc: true, gyro: true, press: true, quat: true, step: false },
    recommendedFor: ['full-sensor visualization', 'concurrent pressure and orientation'],
    cautions: ['missed Realtime notifications cannot be retransmitted'],
  }),
  'realtime-full-step': freezeInsoleToolkitProfile({
    id: 'realtime-full-step',
    label: 'Realtime Full + Step Analysis',
    shortLabel: 'Concurrent Realtime and STEP_ANALYSIS',
    streamingMode: 4,
    sensorDataMode: 'realtime',
    outputs: { sensorValues: true, stepAnalysis: true },
    transport: 'notify',
    sampleHz: 100,
    fields: { acc: true, gyro: true, press: true, quat: true, step: true },
    recommendedFor: ['live Raw visualization with gait events', 'interactive applications'],
    cautions: ['two Notification streams increase BLE load', 'Realtime Raw continuity is not guaranteed'],
  }),
  'step-analysis': freezeInsoleToolkitProfile({
    id: 'step-analysis',
    label: 'Step Analysis',
    shortLabel: 'STEP_ANALYSIS Notification only',
    streamingMode: 4,
    sensorDataMode: 'realtime',
    outputs: { sensorValues: false, stepAnalysis: true },
    transport: 'notify',
    sampleHz: null,
    fields: { acc: false, gyro: false, press: false, quat: false, step: true },
    recommendedFor: ['firmware-derived step, stride, and pronation events', 'applications that do not require Raw Sensor Values'],
    cautions: ['values are derived by device firmware', 'SENSOR_VALUES Notification is disabled'],
  }),
  'fifo-recording': freezeInsoleToolkitProfile({
    id: 'fifo-recording',
    label: 'FIFO Buffered Recording',
    shortLabel: 'Buffered Raw acquisition with continuity checks',
    streamingMode: 4,
    sensorDataMode: 'fifo',
    outputs: { sensorValues: true, stepAnalysis: false },
    transport: 'request-response',
    sampleHz: 200,
    fields: { acc: true, gyro: true, press: true, quat: false, step: false },
    recommendedFor: ['Raw recording for offline analysis', 'acquisition with post-drain continuity validation'],
    cautions: ['Host delivery is bursty and delayed', 'quat and STEP_ANALYSIS are unavailable'],
  }),
});

export function insoleToolkitError(code: string, message: string): InsoleToolkitError {
  const error = new Error(message) as InsoleToolkitError;
  error.code = code;
  return error;
}

export function normalizeInsoleToolkitOutputs(outputs?: Partial<InsoleToolkitOutputs> | null): InsoleToolkitOutputs {
  const normalized = {
    sensorValues: !outputs || outputs.sensorValues !== false,
    stepAnalysis: !!(outputs && outputs.stepAnalysis),
  };
  if (!normalized.sensorValues && !normalized.stepAnalysis) {
    throw insoleToolkitError('NO_DATA_OUTPUT', 'InsoleToolkit: select at least one data output.');
  }
  return normalized;
}

export function normalizeInsoleSensorDataMode(mode?: unknown): InsoleSensorDataMode {
  return mode === 'fifo' ? 'fifo' : 'realtime';
}

export function normalizeInsoleToolkitConfiguration(
  config: InsoleToolkitConfigurationInput = {},
  current: InsoleToolkitConfigurationInput = {},
): InsoleToolkitConfiguration {
  const currentOutputs = current.outputs || { sensorValues: true, stepAnalysis: false };
  const outputs = normalizeInsoleToolkitOutputs(config.outputs
    ? { ...currentOutputs, ...config.outputs }
    : currentOutputs);
  const streamingMode = config.streamingMode === undefined
    ? Number(current.streamingMode || 4)
    : Number(config.streamingMode);
  if (![1, 3, 4].includes(streamingMode)) {
    throw insoleToolkitError(
      'INVALID_MODE',
      `InsoleToolkit: invalid streaming mode ${config.streamingMode}.`
    );
  }
  if (
    config.sensorDataMode !== undefined
    && config.sensorDataMode !== 'realtime'
    && config.sensorDataMode !== 'fifo'
  ) {
    throw insoleToolkitError(
      'INVALID_SENSOR_DATA_MODE',
      `InsoleToolkit: invalid sensor data mode ${config.sensorDataMode}.`
    );
  }
  const sensorDataMode = config.sensorDataMode === undefined
    ? normalizeInsoleSensorDataMode(current.sensorDataMode)
    : normalizeInsoleSensorDataMode(config.sensorDataMode);
  if (sensorDataMode === 'fifo' && !outputs.sensorValues) {
    throw insoleToolkitError(
      'FIFO_REQUIRES_SENSOR_VALUES',
      'InsoleToolkit: FIFO is a Raw Sensor Data mode. Enable Sensor Values or use Step Analysis with Realtime.'
    );
  }
  if (sensorDataMode === 'fifo' && outputs.sensorValues && outputs.stepAnalysis) {
    throw insoleToolkitError(
      'FIFO_STEP_INCOMPATIBLE',
      'InsoleToolkit: lossless FIFO Raw and Step Analysis cannot run simultaneously on the current firmware. Use sequential modes.'
    );
  }
  return { streamingMode, sensorDataMode, outputs };
}

export function resolveInsoleToolkitProfile(profile: InsoleToolkitProfileInput | null | undefined): ResolvedInsoleToolkitProfile {
  if (typeof profile === 'string') {
    const resolved = INSOLE_TOOLKIT_PROFILES[profile];
    if (!resolved) {
      throw insoleToolkitError('PROFILE_NOT_FOUND', `InsoleToolkit: unknown profile "${profile}".`);
    }
    return resolved;
  }
  if (!profile || typeof profile !== 'object') {
    throw insoleToolkitError('PROFILE_NOT_FOUND', 'InsoleToolkit: profile must be a profile id or configuration object.');
  }
  const config = normalizeInsoleToolkitConfiguration(profile, {
    streamingMode: 4,
    sensorDataMode: 'realtime',
    outputs: { sensorValues: true, stepAnalysis: false },
  });
  return {
    id: typeof profile.id === 'string' ? profile.id : 'custom',
    label: typeof profile.label === 'string' ? profile.label : 'Custom profile',
    ...config,
  };
}

function insoleToolkitProfileIdFor(config: InsoleToolkitConfiguration): string {
  for (const profile of Object.values(INSOLE_TOOLKIT_PROFILES)) {
    if (
      profile.streamingMode === config.streamingMode
      && profile.sensorDataMode === config.sensorDataMode
      && profile.outputs.sensorValues === config.outputs.sensorValues
      && profile.outputs.stepAnalysis === config.outputs.stepAnalysis
    ) return profile.id;
  }
  return 'custom';
}

function insoleToolkitModuleOptions(options: Record<string, unknown> | null | undefined, key: string): ModuleCallbacks {
  const value = options && options[key];
  return value && typeof value === 'object' ? value as ModuleCallbacks : {};
}

function withErrorFields(error: Error, fields: Record<string, unknown>): InsoleToolkitError {
  return Object.assign(error, fields) as InsoleToolkitError;
}

export class InsoleToolkitSession {
  readonly insole: InsoleSessionDevice;
  readonly options: InsoleToolkitSessionOptions;
  streamingMode: number;
  sensorDataMode: InsoleSensorDataMode;
  outputs: InsoleToolkitOutputs;
  profileId: string;
  connected = false;
  transitioning = false;
  sensorNotifyActive = false;
  fifoActive = false;
  gaitActive = false;
  measurementPhase: 'idle' | 'recording' | 'draining' = 'idle';
  activeMeasurement: Measurement | null = null;
  lastMeasurement: InsoleMeasurementResult | null = null;
  lastError: unknown = null;
  /** FIFO 収録モジュール（使えない場合は null） */
  readonly fifo: InsoleSessionFifo | null;
  /** Gait（STEP_ANALYSIS）モジュール（使えない場合は null） */
  readonly gait: InsoleSessionGait | null;

  private transition: Promise<unknown> = Promise.resolve();
  private removeReconnectHook: (() => void) | null = null;
  private measurementSequence = 0;
  private sensorDataUnsubscribe: (() => unknown) | null = null;
  private fifoCallbacks: ModuleCallbacks;
  private gaitCallbacks: ModuleCallbacks;
  private readonly verifyGaitNotifications: boolean;
  private readonly gaitVerifyTimeoutMs: number;
  private readonly gaitVerifyRetries: number;
  private warnedStepUnsupportedFirmware = false;
  private readonly stateListeners = new Set<(session: InsoleToolkitSession) => void>();

  constructor(insole: InsoleSessionDevice, options: InsoleToolkitSessionOptions = {}, adapters: InsoleSessionAdapters = {}) {
    this.insole = insole;
    this.options = options;
    const initialProfile = options.profile ? resolveInsoleToolkitProfile(options.profile) : null;
    const initialConfig = normalizeInsoleToolkitConfiguration(
      initialProfile || options,
      {
        streamingMode: 4,
        sensorDataMode: 'realtime',
        outputs: { sensorValues: true, stepAnalysis: false },
      }
    );
    this.streamingMode = initialConfig.streamingMode;
    this.sensorDataMode = initialConfig.sensorDataMode;
    this.outputs = initialConfig.outputs;
    this.profileId = initialProfile?.id || insoleToolkitProfileIdFor(initialConfig);

    const FifoClass = adapters.FifoClass as (new (insole: unknown, options: unknown) => InsoleSessionFifo) | null | undefined;
    const GaitClass = adapters.GaitClass as (new (insole: unknown, options: unknown) => InsoleSessionGait) | null | undefined;
    const fifoOptions = insoleToolkitModuleOptions(options, 'fifo');
    const gaitOptions = insoleToolkitModuleOptions(options, 'gait');
    this.fifoCallbacks = fifoOptions;
    this.gaitCallbacks = gaitOptions;
    this.verifyGaitNotifications = gaitOptions.verifyNotifications !== false;
    this.gaitVerifyTimeoutMs = Number.isFinite(Number(gaitOptions.verifyTimeoutMs))
      ? Math.max(200, Math.min(10000, Number(gaitOptions.verifyTimeoutMs)))
      : 1500;
    this.gaitVerifyRetries = Number.isFinite(Number(gaitOptions.verifyRetries))
      ? Math.max(0, Math.min(3, Math.floor(Number(gaitOptions.verifyRetries))))
      : 2;
    this.fifo = FifoClass && !options.simulator ? new FifoClass(insole, fifoOptions) : null;
    this.gait = GaitClass && !options.simulator ? new GaitClass(insole, gaitOptions) : null;
    this.wireModuleCallbacks();
  }

  get supportsFifo(): boolean { return !!this.fifo; }
  get supportsStepAnalysis(): boolean { return !!this.gait; }

  snapshot(): InsoleToolkitSessionSnapshot {
    return {
      connected: this.connected,
      transitioning: this.transitioning,
      profileId: this.profileId,
      profile: INSOLE_TOOLKIT_PROFILES[this.profileId] || null,
      streamingMode: this.streamingMode,
      sensorDataMode: this.sensorDataMode,
      outputs: { ...this.outputs },
      sensorNotifyActive: this.sensorNotifyActive,
      fifoActive: this.fifoActive,
      gaitActive: this.gaitActive,
      measurementPhase: this.measurementPhase,
      measurement: this.activeMeasurement ? this.measurementSnapshot(this.activeMeasurement) : null,
      lastMeasurement: this.lastMeasurement ? this.measurementResultSnapshot(this.lastMeasurement) : null,
      supportsFifo: this.supportsFifo,
      supportsStepAnalysis: this.supportsStepAnalysis,
      gaitDiagnostics: this.gaitDiagnostics(),
      lastError: this.lastError,
    };
  }

  /**
   * 状態が変わるたびに呼ばれるリスナーを登録し、解除関数を返す。
   * options.onStateChange と違い、複数登録できる（Toolkit の UI 同期などに使う）。
   */
  addStateListener(listener: (session: InsoleToolkitSession) => void): () => void {
    this.stateListeners.add(listener);
    return () => { this.stateListeners.delete(listener); };
  }

  /** キューに積まれた設定変更・接続操作がすべて終わるまで待つ（失敗しても reject しない） */
  async whenIdle(): Promise<void> {
    await this.transition;
  }

  setFifoCallbacks(callbacks: ModuleCallbacks = {}): void {
    this.fifoCallbacks = callbacks;
  }

  setGaitCallbacks(callbacks: ModuleCallbacks = {}): void {
    this.gaitCallbacks = callbacks;
  }

  connect(beginOptions: Record<string, unknown> = {}): Promise<unknown> {
    return this.enqueue(async () => {
      this.validateCapabilities(this.configuration());
      if (this.connected && this.insole.isConnected && this.insole.isConnected()) {
        await this.applyDesiredState();
        return 'already connected';
      }
      const options: Record<string, unknown> = Object.assign({}, this.options, beginOptions, {
        streamingMode: this.streamingMode,
      });
      delete options.outputs;
      delete options.sensorDataMode;
      delete options.fifo;
      delete options.gait;
      delete options.onStateChange;

      const result = await this.insole.begin('SENSOR_VALUES', options);
      if (!result) return result;
      this.connected = true;
      this.sensorNotifyActive = true;
      try {
        await this.applyDesiredState();
        this.installReconnectHook();
        return result;
      } catch (error) {
        await this.stopFifo();
        await this.stopGait();
        this.uninstallReconnectHook();
        this.insole.reset();
        this.connected = false;
        this.sensorNotifyActive = false;
        throw error;
      }
    });
  }

  disconnect(): Promise<void> {
    return this.enqueue(async () => {
      if (this.activeMeasurement) {
        await this.finishMeasurement({ reason: 'disconnect', skipRestore: true });
      }
      await this.stopFifo();
      await this.stopGait();
      this.removeSensorDataMeasurementListener();
      this.uninstallReconnectHook();
      if (this.insole && typeof this.insole.reset === 'function') this.insole.reset();
      this.connected = false;
      this.sensorNotifyActive = false;
      this.fifoActive = false;
      this.gaitActive = false;
    });
  }

  setOutputs(outputs: Partial<InsoleToolkitOutputs>): Promise<void> {
    try {
      const next = normalizeInsoleToolkitOutputs(outputs);
      return this.configure({ outputs: next });
    } catch (error) {
      return this.enqueue(() => { throw error; });
    }
  }

  setSensorDataMode(mode: unknown): Promise<void> {
    return this.configure({ sensorDataMode: normalizeInsoleSensorDataMode(mode) });
  }

  setStreamingMode(mode: number): Promise<void> {
    return this.configure({ streamingMode: mode });
  }

  /**
   * 複数の低レベル設定を1回の状態遷移として適用する。
   * 個別 setter もこの API へ集約する。
   */
  configure(config: InsoleToolkitConfigurationInput = {}): Promise<void> {
    let next: InsoleToolkitConfiguration;
    try {
      next = normalizeInsoleToolkitConfiguration(config, this.configuration());
    } catch (error) {
      return this.enqueue(() => { throw error; });
    }
    return this.enqueue(() => this.applyConfiguration(next, {
      profileId: insoleToolkitProfileIdFor(next),
    }));
  }

  /**
   * 実機検証済みの名前付きプロファイル、またはカスタム構成を原子的に適用する。
   */
  applyProfile(profile: InsoleToolkitProfileInput): Promise<void> {
    let resolved: ResolvedInsoleToolkitProfile;
    try {
      resolved = resolveInsoleToolkitProfile(profile);
    } catch (error) {
      return this.enqueue(() => { throw error; });
    }
    const next = normalizeInsoleToolkitConfiguration(resolved, this.configuration());
    return this.enqueue(() => this.applyConfiguration(next, { profileId: resolved.id }));
  }

  /**
   * 選択したプロファイルの正式計測区間を開始する。
   * Realtime はデコード済み sample、FIFO は checkpoint 以降、Step は完成 row を記録する。
   */
  startMeasurement(options: {
    profile?: InsoleToolkitProfileInput;
    metadata?: Record<string, unknown>;
    maxSamples?: number;
    maxStepRows?: number;
    restoreProfile?: boolean;
  } = {}): Promise<InsoleMeasurementSnapshot> {
    return this.enqueue(async () => {
      if (!this.connected) {
        throw insoleToolkitError('NOT_CONNECTED', 'InsoleToolkit: connect before starting a measurement.');
      }
      if (this.activeMeasurement) {
        throw insoleToolkitError('MEASUREMENT_ACTIVE', 'InsoleToolkit: a measurement is already active.');
      }

      const previousConfiguration = this.configuration();
      const previousProfileId = this.profileId;
      if (options.profile !== undefined) {
        const resolved = resolveInsoleToolkitProfile(options.profile);
        const next = normalizeInsoleToolkitConfiguration(resolved, previousConfiguration);
        await this.applyConfiguration(next, { profileId: resolved.id, allowDuringMeasurement: true });
      }

      const measurement: Measurement = {
        id: ++this.measurementSequence,
        deviceId: this.insole?.id || 0,
        status: 'recording',
        reason: null,
        startedAt: Date.now(),
        endedAt: null,
        durationMs: null,
        profileId: this.profileId,
        profile: INSOLE_TOOLKIT_PROFILES[this.profileId] || {
          id: this.profileId,
          label: 'Custom profile',
          ...this.configuration(),
        },
        previousConfiguration,
        previousProfileId,
        metadata: options.metadata && typeof options.metadata === 'object'
          ? { ...options.metadata }
          : {},
        limits: {
          maxSamples: Number.isFinite(Number(options.maxSamples))
            ? Math.max(0, Number(options.maxSamples))
            : 120000,
          maxStepRows: Number.isFinite(Number(options.maxStepRows))
            ? Math.max(0, Number(options.maxStepRows))
            : 10000,
        },
        raw: {
          packets: 0,
          samples: [],
          serials: new Set(),
          firstSerial: null,
          lastSerial: null,
          lastForwardSerial: null,
          maxSerialDistance: -1,
          truncated: false,
        },
        step: {
          packets: 0,
          typeCounts: { motion: 0, overview: 0, stride: 0, pronation: 0 },
          rows: [],
          truncated: false,
        },
        fifoCheckpoint: this.sensorDataMode === 'fifo' && this.fifo?.createCheckpoint
          ? this.fifo.createCheckpoint()
          : null,
        fifoSummary: null,
        restoreProfile: options.restoreProfile,
      };
      this.activeMeasurement = measurement;
      this.measurementPhase = 'recording';
      this.installSensorDataMeasurementListener();
      this.emitState();
      return this.measurementSnapshot(measurement);
    });
  }

  /**
   * 正式計測を終了する。FIFO は drain 完了を待ってから結果を返す。
   * 多重 click でも直近結果を返すため idempotent。
   */
  stopMeasurement(options: { reason?: string; restoreProfile?: boolean } = {}): Promise<InsoleMeasurementResult | null> {
    return this.enqueue(() => this.finishMeasurement({
      reason: options.reason || 'manual',
      restoreProfile: options.restoreProfile,
    }));
  }

  reapplyAfterReconnect(): Promise<void> {
    this.connected = true;
    this.sensorNotifyActive = true;
    // FIFO のループは切断時に終了するため、再接続後は必ず開始し直す。
    // Gait.start() は Gait 自身の再接続フックと同じ購読 Promise を共有する。
    // ここでも await し、Step-only 時に購読完了前の SENSOR_VALUES 停止を防ぐ。
    this.fifoActive = false;
    this.gaitActive = false;
    return this.enqueue(() => this.applyDesiredState());
  }

  markDisconnected(): void {
    this.connected = false;
    this.sensorNotifyActive = false;
    this.fifoActive = false;
    if (this.gait && !this.gait.isRunning) this.gaitActive = false;
    this.emitState();
  }

  private configuration(): InsoleToolkitConfiguration {
    return {
      streamingMode: this.streamingMode,
      sensorDataMode: this.sensorDataMode,
      outputs: { ...this.outputs },
    };
  }

  private async applyConfiguration(
    next: InsoleToolkitConfiguration,
    options: { profileId?: string; allowDuringMeasurement?: boolean; rollbackOnFailure?: boolean } = {},
  ): Promise<void> {
    if (this.activeMeasurement && !options.allowDuringMeasurement) {
      throw insoleToolkitError(
        'MEASUREMENT_ACTIVE',
        'InsoleToolkit: stop the active measurement before changing profiles.'
      );
    }
    this.validateCapabilities(next);
    const previous = this.configuration();
    const previousProfileId = this.profileId;
    this.streamingMode = next.streamingMode;
    this.sensorDataMode = next.sensorDataMode;
    this.outputs = { ...next.outputs };
    this.profileId = options.profileId || insoleToolkitProfileIdFor(next);
    this.syncOptions();
    try {
      if (this.connected) await this.applyDesiredState();
    } catch (error) {
      if (options.rollbackOnFailure === false) throw error;
      this.streamingMode = previous.streamingMode;
      this.sensorDataMode = previous.sensorDataMode;
      this.outputs = previous.outputs;
      this.profileId = previousProfileId;
      this.syncOptions();
      if (this.connected) {
        try { await this.applyDesiredState(); } catch (rollbackError) {
          this.reportError(rollbackError);
        }
      }
      throw error;
    }
  }

  private validateCapabilities(config: InsoleToolkitConfiguration): void {
    if (config.sensorDataMode === 'fifo' && config.outputs.sensorValues && !this.supportsFifo) {
      throw insoleToolkitError('FIFO_UNAVAILABLE', 'InsoleToolkit: FIFO is not available for this device.');
    }
    if (config.outputs.stepAnalysis && !this.supportsStepAnalysis) {
      throw insoleToolkitError('GAIT_UNAVAILABLE', 'InsoleToolkit: Step Analysis is not available for this device.');
    }
  }

  private enqueue<T>(operation: () => T | Promise<T>): Promise<T> {
    const run = async (): Promise<T> => {
      this.transitioning = true;
      this.lastError = null;
      this.emitState();
      try {
        return await operation();
      } catch (error) {
        this.lastError = error;
        this.reportError(error);
        throw error;
      } finally {
        this.transitioning = false;
        this.emitState();
      }
    };
    const next = this.transition.then(run, run);
    this.transition = next.catch(() => {});
    return next;
  }

  private async applyDesiredState(): Promise<void> {
    if (!this.connected) return;
    const desired = this.configuration();
    this.validateCapabilities(desired);

    // FIFO へ入る前に Step 購読を停止する。現行 FW では read mode が排他であり、
    // FIFO 開始後に Step を止める順序だと停止操作が FIFO 応答と競合しうる。
    if (this.sensorDataMode === 'fifo') {
      await this.stopGait();
      await this.ensureSensorNotify();
      await this.startFifo();
      return;
    }

    // FIFO から Realtime / Step へ出る場合は、最初に drain と read mode 復帰を完了する。
    const fifoStopped = await this.stopFifo();
    await this.ensureSensorNotify();
    if (this.insole.streaming_mode !== this.streamingMode) {
      await this.insole.setDataStreamingMode(this.streamingMode);
    }
    if (this.outputs.stepAnalysis) {
      // FIFO teardown の read mode 復帰後も同じ理由で通知を再確立する。
      if (fifoStopped && this.gaitActive) await this.refreshGait();
      else await this.startGait();
    } else {
      await this.stopGait();
    }
    // Step-only でも FW を active にするため、Step 購読が成立してから Raw notify を止める。
    if (!this.outputs.sensorValues) {
      await this.stopSensorNotify();
    }
  }

  private async ensureSensorNotify(): Promise<void> {
    if (this.sensorNotifyActive) return;
    await this.insole.setDataStreamingMode(this.streamingMode);
    await this.insole.startNotify('SENSOR_VALUES');
    this.sensorNotifyActive = true;
  }

  private async stopSensorNotify(): Promise<void> {
    if (!this.sensorNotifyActive) return;
    await this.insole.stopNotify('SENSOR_VALUES');
    this.sensorNotifyActive = false;
  }

  private async startFifo(): Promise<boolean> {
    if (this.fifoActive) return false;
    if (!this.fifo) {
      throw insoleToolkitError('FIFO_UNAVAILABLE', 'InsoleToolkit: FIFO is not available for this device.');
    }
    const started = await this.fifo.start();
    if (!started) {
      throw insoleToolkitError('FIFO_START_FAILED', 'InsoleToolkit: failed to start FIFO acquisition.');
    }
    this.fifoActive = true;
    return true;
  }

  private async stopFifo(): Promise<boolean> {
    if (!this.fifo || !this.fifoActive) return false;
    await this.fifo.stop();
    this.fifoActive = false;
    return true;
  }

  private async startGait(): Promise<void> {
    if (!this.gait) {
      throw insoleToolkitError('GAIT_UNAVAILABLE', 'InsoleToolkit: Step Analysis is not available for this device.');
    }
    await this.warnIfStepAnalysisUnconfirmedFirmware();
    if (this.gaitActive) {
      const beforeDiagnostics = this.gaitDiagnostics();
      try {
        await this.verifyGaitLiveness(beforeDiagnostics, 'active');
      } catch (error) {
        try { await this.gait.stop(); } catch { /* noop */ }
        this.gaitActive = false;
        throw error;
      }
      return;
    }
    const beforeDiagnostics = this.gaitDiagnostics();
    const started = await this.gait.start();
    if (!started) {
      throw insoleToolkitError('GAIT_START_FAILED', 'InsoleToolkit: failed to start Step Analysis.');
    }
    this.gaitActive = true;
    try {
      await this.verifyGaitLiveness(beforeDiagnostics, 'start');
    } catch (error) {
      try { await this.gait.stop(); } catch { /* noop */ }
      this.gaitActive = false;
      throw error;
    }
  }

  private async refreshGait(): Promise<void> {
    if (!this.gait || !this.gaitActive) return this.startGait();
    if (typeof this.gait.refreshSubscription !== 'function') return;
    const beforeDiagnostics = this.gaitDiagnostics();
    const refreshed = await this.gait.refreshSubscription();
    this.gaitActive = !!refreshed;
    if (!refreshed) {
      throw insoleToolkitError('GAIT_REFRESH_FAILED', 'InsoleToolkit: failed to refresh Step Analysis after FIFO mode change.');
    }
    try {
      await this.verifyGaitLiveness(beforeDiagnostics, 'restore');
    } catch (error) {
      try { await this.gait.stop(); } catch { /* noop */ }
      this.gaitActive = false;
      throw error;
    }
  }

  private async stopGait(): Promise<void> {
    if (!this.gait || !this.gaitActive) return;
    await this.gait.stop();
    this.gaitActive = false;
  }

  private gaitDiagnostics(): unknown {
    if (!this.gait || typeof this.gait.diagnostics !== 'function') return null;
    try { return this.gait.diagnostics(); } catch { return null; }
  }

  private emitGaitDiagnostic(type: string, detail: Record<string, unknown> = {}): void {
    this.callModuleCallback(this.gaitCallbacks, 'onDiagnostic', [
      this.insole?.id || 0,
      {
        type,
        ...detail,
        diagnostics: this.gaitDiagnostics(),
      },
    ]);
  }

  /**
   * FW バージョンを解決する（取得できない場合は null。例外は投げない）。
   * getFirmwareVersion() → advertisement 由来の lastStatus.version の順。
   */
  private async resolveFirmwareVersion(): Promise<string | null> {
    try {
      if (this.insole && typeof this.insole.getFirmwareVersion === 'function') {
        return await this.insole.getFirmwareVersion();
      }
      if (this.insole && this.insole.lastStatus && this.insole.lastStatus.version) {
        return this.insole.lastStatus.version;
      }
    } catch { /* バージョン不明として扱う */ }
    return null;
  }

  /**
   * STEP_ANALYSIS 通知が実測で確認できていない既知 FW なら警告を出す（1セッション1回）。
   * ブロックはせず、console.warn と onDiagnostic('fw-step-analysis-unconfirmed') で知らせる。
   */
  private async warnIfStepAnalysisUnconfirmedFirmware(): Promise<void> {
    if (this.warnedStepUnsupportedFirmware) return;
    const firmwareVersion = await this.resolveFirmwareVersion();
    if (!firmwareVersion || !INSOLE_TOOLKIT_STEP_UNSUPPORTED_FW.includes(firmwareVersion)) return;
    this.warnedStepUnsupportedFirmware = true;
    console.warn(
      `InsoleToolkit: firmware ${firmwareVersion} has no confirmed STEP_ANALYSIS output. `
      + 'Step Analysis may stay silent (GAIT_NO_NOTIFICATIONS). Update the device firmware if available.'
    );
    this.emitGaitDiagnostic('fw-step-analysis-unconfirmed', { firmwareVersion });
  }

  /**
   * startNotifications() の resolve だけで成功扱いにせず、実際の有効 packet 到着を確認する。
   * 無通知時は streaming mode を再適用して STEP_ANALYSIS を再購読する。
   */
  private async verifyGaitLiveness(beforeDiagnostics: unknown, context: string): Promise<boolean> {
    if (
      !this.verifyGaitNotifications
      || !this.gait
      || typeof this.gait.waitForPacket !== 'function'
    ) return true;

    const before = beforeDiagnostics as GaitCounters | null;
    const afterValidPackets = Number(before?.validPackets || 0);
    const afterTransportNotifications = Number(before?.transportNotifications || 0);
    const afterInvalidPackets = Number(before?.invalidPackets || 0);
    for (let attempt = 0; attempt <= this.gaitVerifyRetries; attempt++) {
      const received = await this.gait.waitForPacket({
        afterCount: afterValidPackets,
        timeoutMs: this.gaitVerifyTimeoutMs,
      });
      if (received) {
        this.emitGaitDiagnostic('liveness-confirmed', { context, attempt });
        return true;
      }

      const diagnostics = this.gaitDiagnostics() as GaitCounters | null;
      this.emitGaitDiagnostic('liveness-timeout', {
        context,
        attempt,
        timeoutMs: this.gaitVerifyTimeoutMs,
      });
      if (attempt >= this.gaitVerifyRetries) {
        const transportDelta = Math.max(
          0,
          Number(diagnostics?.transportNotifications || 0) - afterTransportNotifications
        );
        const invalidDelta = Math.max(
          0,
          Number(diagnostics?.invalidPackets || 0) - afterInvalidPackets
        );
        const hasTransport = transportDelta > 0;
        const firmwareVersion = await this.resolveFirmwareVersion();
        let message: string;
        if (hasTransport) {
          message = 'InsoleToolkit: STEP_ANALYSIS notifications arrived but no valid packets were decoded.';
        } else {
          // transport 0 件は FW 側が publish していない可能性が高い
          message = 'InsoleToolkit: STEP_ANALYSIS subscription started but no notifications arrived. '
            + 'The device firmware may not support Step Analysis output'
            + (firmwareVersion ? ` (FW ${firmwareVersion})` : ' (firmware version unknown)')
            + '.';
        }
        throw withErrorFields(new Error(message), {
          code: hasTransport ? 'GAIT_INVALID_PACKETS' : 'GAIT_NO_NOTIFICATIONS',
          diagnostics,
          transportDelta,
          invalidDelta,
          firmwareVersion,
        });
      }

      this.emitGaitDiagnostic('liveness-retry', { context, attempt: attempt + 1 });
      if (this.insole && typeof this.insole.setDataStreamingMode === 'function') {
        await this.insole.setDataStreamingMode(this.streamingMode);
      }
      if (typeof this.gait.refreshSubscription !== 'function') continue;
      const refreshed = await this.gait.refreshSubscription();
      this.gaitActive = !!refreshed;
      if (!refreshed) {
        throw withErrorFields(new Error('InsoleToolkit: failed to retry STEP_ANALYSIS notification subscription.'), {
          code: 'GAIT_REFRESH_FAILED',
          diagnostics: this.gaitDiagnostics(),
        });
      }
    }
    return false;
  }

  private installSensorDataMeasurementListener(): void {
    this.removeSensorDataMeasurementListener();
    if (!this.insole || typeof this.insole.addSensorDataListener !== 'function') return;
    this.sensorDataUnsubscribe = this.insole.addSensorDataListener((event) => {
      this.captureRealtimePacket(event);
    });
  }

  private removeSensorDataMeasurementListener(): void {
    if (typeof this.sensorDataUnsubscribe === 'function') {
      try { this.sensorDataUnsubscribe(); } catch { /* noop */ }
    }
    this.sensorDataUnsubscribe = null;
  }

  private captureRealtimePacket(event: InsoleSessionSensorDataEvent | null | undefined): void {
    const measurement = this.activeMeasurement;
    if (!measurement || measurement.status !== 'recording' || this.sensorDataMode !== 'realtime') return;
    const packet = event && event.packet;
    if (!packet || !Array.isArray(packet.samples)) return;
    const raw = measurement.raw;
    raw.packets += 1;
    this.recordMeasurementSerial(raw, packet.serial_number);
    this.appendMeasurementSamples(raw, packet.samples as MeasurementSample[]);
  }

  private captureFifoSamples(samples: unknown): void {
    const measurement = this.activeMeasurement;
    if (
      !measurement
      || !['recording', 'draining'].includes(measurement.status)
      || measurement.profile.sensorDataMode !== 'fifo'
    ) return;
    if (!Array.isArray(samples)) return;
    const raw = measurement.raw;
    for (const sample of samples as Array<MeasurementSample | null>) {
      const serial = sample && Number.isInteger(sample.serial_number) ? sample.serial_number as number : null;
      if (serial !== null) this.recordMeasurementSerial(raw, serial);
    }
    raw.packets = raw.serials.size;
    this.appendMeasurementSamples(raw, samples as MeasurementSample[]);
  }

  private recordMeasurementSerial(raw: MeasurementRaw, serial: unknown): void {
    if (!Number.isInteger(serial)) return;
    const normalized = (serial as number) & 0xffff;
    raw.serials.add(normalized);
    if (raw.firstSerial === null || raw.lastForwardSerial === null) {
      raw.firstSerial = normalized;
      raw.lastSerial = normalized;
      raw.lastForwardSerial = normalized;
      raw.maxSerialDistance = 0;
      return;
    }
    const forward = (normalized - raw.lastForwardSerial + 65536) % 65536;
    if (forward === 0) return;
    if (forward >= 32768) {
      const beforeFirst = (raw.firstSerial - normalized + 65536) % 65536;
      if (beforeFirst > 0 && beforeFirst < 32768) {
        raw.firstSerial = normalized;
        raw.maxSerialDistance += beforeFirst;
      }
      return;
    }
    raw.lastForwardSerial = normalized;
    raw.lastSerial = normalized;
    raw.maxSerialDistance = Math.max(
      raw.maxSerialDistance,
      (normalized - raw.firstSerial + 65536) % 65536
    );
  }

  private appendMeasurementSamples(raw: MeasurementRaw, samples: MeasurementSample[]): void {
    const measurement = this.activeMeasurement;
    if (!measurement) return;
    const remaining = Math.max(0, measurement.limits.maxSamples - raw.samples.length);
    if (remaining > 0) {
      raw.samples.push(...samples.slice(0, remaining).map((sample) => this.cloneMeasurementSample(sample)));
    }
    if (samples.length > remaining) raw.truncated = true;
  }

  private cloneMeasurementSample(sample: MeasurementSample): MeasurementSample {
    if (!sample || typeof sample !== 'object') return sample;
    const copy: MeasurementSample = { ...sample };
    for (const key of ['quat', 'gyro', 'acc', 'converted_gyro', 'converted_acc', 'press']) {
      const value = sample[key] as Record<string, unknown> | null | undefined;
      if (value && typeof value === 'object') {
        const cloned: Record<string, unknown> = { ...value };
        if (Array.isArray(value.values)) cloned.values = [...value.values];
        copy[key] = cloned;
      }
    }
    return copy;
  }

  private captureStepPacket(packet: unknown): void {
    const measurement = this.activeMeasurement;
    if (!measurement || measurement.status !== 'recording' || !this.outputs.stepAnalysis) return;
    measurement.step.packets += 1;
    const type = (packet as { type?: unknown } | null | undefined)?.type;
    if (
      typeof type === 'string'
      && Object.prototype.hasOwnProperty.call(measurement.step.typeCounts, type)
    ) {
      measurement.step.typeCounts[type as keyof Measurement['step']['typeCounts']] += 1;
    }
  }

  private captureStepRow(row: unknown): void {
    const measurement = this.activeMeasurement;
    if (!measurement || measurement.status !== 'recording' || !this.outputs.stepAnalysis) return;
    if (measurement.step.rows.length < measurement.limits.maxStepRows) {
      measurement.step.rows.push({ ...(row as MeasurementRow) });
    } else {
      measurement.step.truncated = true;
    }
  }

  private async finishMeasurement(options: { reason?: string; restoreProfile?: boolean | undefined; skipRestore?: boolean } = {}): Promise<InsoleMeasurementResult | null> {
    const measurement = this.activeMeasurement;
    if (!measurement) return this.lastMeasurement;

    measurement.endedAt = Date.now();
    measurement.durationMs = Math.max(0, measurement.endedAt - measurement.startedAt);
    measurement.reason = options.reason || 'manual';
    this.removeSensorDataMeasurementListener();

    const wasFifo = measurement.profile.sensorDataMode === 'fifo';
    if (wasFifo) {
      measurement.status = 'draining';
      this.measurementPhase = 'draining';
      this.emitState();
      await this.stopFifo();
      if (measurement.fifoCheckpoint && this.fifo?.summarizeSince) {
        measurement.fifoSummary = this.fifo.summarizeSince(measurement.fifoCheckpoint as never) as FifoSummaryLike;
      }
    }

    measurement.status = 'completed';
    const result = this.finalizeMeasurementResult(measurement);
    this.lastMeasurement = result;

    let restoreError: unknown = null;
    try {
      const restoreProfile = options.restoreProfile ?? measurement.restoreProfile;
      if (!options.skipRestore && wasFifo) {
        const previousWasRealtime = measurement.previousConfiguration.sensorDataMode === 'realtime';
        const target = restoreProfile !== false && previousWasRealtime
          ? measurement.previousConfiguration
          : INSOLE_TOOLKIT_PROFILES['realtime-full']!;
        const targetProfileId = restoreProfile !== false && previousWasRealtime
          ? measurement.previousProfileId
          : 'realtime-full';
        await this.applyConfiguration(
          normalizeInsoleToolkitConfiguration(target, this.configuration()),
          {
            profileId: targetProfileId,
            allowDuringMeasurement: true,
            rollbackOnFailure: false,
          }
        );
      } else if (!options.skipRestore && restoreProfile === true) {
        await this.applyConfiguration(measurement.previousConfiguration, {
          profileId: measurement.previousProfileId,
          allowDuringMeasurement: true,
          rollbackOnFailure: false,
        });
      }
    } catch (error) {
      restoreError = error;
      if (error && typeof error === 'object') {
        Object.defineProperty(error, 'measurement', {
          value: result,
          enumerable: false,
          configurable: true,
        });
      }
      // Step 再購読が成立しない場合に、失敗した復元元（FIFO）へ戻して
      // バックグラウンド収録を再開しない。Raw Realtime を安全な退避先とする。
      try {
        await this.applyConfiguration(
          INSOLE_TOOLKIT_PROFILES['realtime-full']!,
          {
            profileId: 'realtime-full',
            allowDuringMeasurement: true,
            rollbackOnFailure: false,
          }
        );
      } catch (fallbackError) {
        if (error && typeof error === 'object') (error as Record<string, unknown>).fallbackError = fallbackError;
        this.reportError(fallbackError);
        try { await this.stopFifo(); } catch (stopError) { this.reportError(stopError); }
        try { await this.stopGait(); } catch (stopError) { this.reportError(stopError); }
      }
    } finally {
      this.activeMeasurement = null;
      this.measurementPhase = 'idle';
      this.emitState();
    }
    if (restoreError) throw restoreError;
    return result;
  }

  private measurementSnapshot(measurement: Measurement): InsoleMeasurementSnapshot {
    const rawSerial = this.summarizeMeasurementSerial(measurement.raw);
    return {
      id: measurement.id,
      deviceId: measurement.deviceId,
      status: measurement.status,
      reason: measurement.reason,
      startedAt: measurement.startedAt,
      endedAt: measurement.endedAt,
      durationMs: measurement.durationMs,
      profileId: measurement.profileId,
      metadata: { ...measurement.metadata },
      raw: {
        packets: measurement.raw.packets,
        samples: measurement.raw.samples.length,
        serial: rawSerial,
        truncated: measurement.raw.truncated,
      },
      step: {
        packets: measurement.step.packets,
        typeCounts: { ...measurement.step.typeCounts },
        rows: measurement.step.rows.length,
        truncated: measurement.step.truncated,
      },
      fifo: measurement.fifoSummary ? { ...measurement.fifoSummary } : null,
    };
  }

  private measurementResultSnapshot(result: InsoleMeasurementResult): Record<string, unknown> {
    return {
      ...result,
      raw: {
        ...result.raw,
        samples: Array.isArray(result.raw?.samples) ? result.raw.samples.length : Number(result.raw?.samples || 0),
      },
      step: {
        ...result.step,
        rows: Array.isArray(result.step?.rows) ? result.step.rows.length : Number(result.step?.rows || 0),
      },
    };
  }

  private summarizeMeasurementSerial(raw: MeasurementRaw): InsoleMeasurementSerialSummary {
    if (
      raw.firstSerial === null
      || raw.lastSerial === null
      || raw.maxSerialDistance < 0
    ) {
      return { first: null, last: null, expected: 0, received: 0, missing: 0, missingRate: 0 };
    }
    const expected = raw.maxSerialDistance + 1;
    let received = 0;
    for (const serial of raw.serials) {
      const distance = (serial - raw.firstSerial + 65536) % 65536;
      if (distance <= raw.maxSerialDistance) received += 1;
    }
    const missing = Math.max(0, expected - received);
    return {
      first: raw.firstSerial,
      last: raw.lastSerial,
      expected,
      received,
      missing,
      missingRate: expected > 0 ? missing / expected : 0,
    };
  }

  private finalizeMeasurementResult(measurement: Measurement): InsoleMeasurementResult {
    const snapshot = this.measurementSnapshot(measurement);
    const fifoSerial = measurement.fifoSummary?.available
      ? {
        first: measurement.fifoSummary.first,
        last: measurement.fifoSummary.last,
        expected: measurement.fifoSummary.expected,
        received: measurement.fifoSummary.received,
        missing: measurement.fifoSummary.missing,
        missingRate: measurement.fifoSummary.missingRate,
      }
      : null;
    return {
      ...snapshot,
      profile: measurement.profile,
      raw: {
        ...snapshot.raw,
        serial: fifoSerial || snapshot.raw.serial,
        samples: measurement.raw.samples.map((sample) => this.cloneMeasurementSample(sample)),
      },
      step: {
        ...snapshot.step,
        rows: measurement.step.rows.map((row) => ({ ...row })),
      },
    };
  }

  private installReconnectHook(): void {
    if (typeof this.insole?.addAfterReconnectSuccessHook !== 'function' || this.removeReconnectHook) return;
    // Gait.start() が先に自身の再購読フックを登録している。Toolkit はその後段で
    // 選択状態（特に Step-only 時の SENSOR_VALUES 停止）を再適用する。
    this.removeReconnectHook = this.insole.addAfterReconnectSuccessHook(() => {
      this.reapplyAfterReconnect().catch(() => {});
    });
  }

  private uninstallReconnectHook(): void {
    if (this.removeReconnectHook) this.removeReconnectHook();
    this.removeReconnectHook = null;
  }

  private wireModuleCallbacks(): void {
    if (this.fifo) {
      this.fifo.onSamples = (...args: unknown[]) => {
        this.captureFifoSamples(args[1]);
        this.callModuleCallback(this.fifoCallbacks, 'onSamples', args);
      };
      this.fifo.onProgress = (...args: unknown[]) => this.callModuleCallback(this.fifoCallbacks, 'onProgress', args);
      this.fifo.onAnomaly = (...args: unknown[]) => this.callModuleCallback(this.fifoCallbacks, 'onAnomaly', args);
      this.fifo.onDataLoss = (...args: unknown[]) => this.callModuleCallback(this.fifoCallbacks, 'onDataLoss', args);
      this.fifo.onStopped = (info: unknown) => {
        this.fifoActive = false;
        this.emitState();
        this.callModuleCallback(this.fifoCallbacks, 'onStopped', [info]);
      };
      this.fifo.onError = (error: unknown) => {
        this.callModuleCallback(this.fifoCallbacks, 'onError', [error]);
        this.reportError(error);
      };
    }
    if (this.gait) {
      this.gait.onGait = (...args: unknown[]) => {
        this.captureStepRow(args[1]);
        this.callModuleCallback(this.gaitCallbacks, 'onGait', args);
      };
      this.gait.onMotion = (...args: unknown[]) => this.callModuleCallback(this.gaitCallbacks, 'onMotion', args);
      this.gait.onTransport = (...args: unknown[]) => this.callModuleCallback(this.gaitCallbacks, 'onTransport', args);
      this.gait.onDiagnostic = (...args: unknown[]) => this.callModuleCallback(this.gaitCallbacks, 'onDiagnostic', args);
      this.gait.onStepLoss = (...args: unknown[]) => this.callModuleCallback(this.gaitCallbacks, 'onStepLoss', args);
      this.gait.onRaw = (...args: unknown[]) => {
        this.captureStepPacket(args[1]);
        this.callModuleCallback(this.gaitCallbacks, 'onRaw', args);
      };
      this.gait.onError = (error: unknown) => {
        this.callModuleCallback(this.gaitCallbacks, 'onError', [error]);
        this.reportError(error);
      };
    }
  }

  private callModuleCallback(callbacks: ModuleCallbacks | null | undefined, name: string, args: unknown[]): void {
    const callback = callbacks && callbacks[name];
    if (typeof callback !== 'function') return;
    try { (callback as (...a: unknown[]) => void)(...args); } catch (error) { this.reportError(error); }
  }

  private syncOptions(): void {
    this.options.streamingMode = this.streamingMode;
    this.options.sensorDataMode = this.sensorDataMode;
    this.options.outputs = { ...this.outputs };
  }

  private reportError(error: unknown): void {
    const callback = this.options && this.options.onError;
    if (typeof callback === 'function') {
      try { callback(error, this.snapshot()); return; } catch { /* fallthrough */ }
    }
    if (error) console.error('InsoleToolkitSession:', error);
  }

  private emitState(): void {
    this.syncOptions();
    const callback = this.options && this.options.onStateChange;
    if (typeof callback === 'function') {
      try { callback(this.snapshot()); } catch (error) { this.reportError(error); }
    }
    for (const listener of [...this.stateListeners]) {
      try { listener(this); } catch (error) { this.reportError(error); }
    }
  }
}

function insoleToolkitCsvEscape(value: unknown): string {
  if (value === undefined || value === null) return '';
  const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/**
 * startMeasurement() / stopMeasurement() の結果を、その計測区間だけの CSV へ変換する。
 * kind='raw' は Realtime / FIFO で共通列、kind='step' は Step Analysis row を出力する。
 */
export function insoleToolkitMeasurementToCSV(
  result: { deviceId?: number; profileId?: string; raw?: { samples?: unknown }; step?: { rows?: unknown } } | null | undefined,
  kind = 'raw',
): string {
  if (!result || typeof result !== 'object') {
    throw insoleToolkitError('INVALID_MEASUREMENT', 'InsoleToolkit: a measurement result is required.');
  }
  if (kind !== 'raw' && kind !== 'step') {
    throw insoleToolkitError(
      'INVALID_CSV_KIND',
      `InsoleToolkit: CSV kind must be "raw" or "step", received "${kind}".`
    );
  }
  const rows = kind === 'step' ? result.step?.rows : result.raw?.samples;
  if (!Array.isArray(rows)) {
    throw insoleToolkitError(
      'INVALID_MEASUREMENT',
      `InsoleToolkit: measurement does not contain ${kind === 'step' ? 'Step' : 'Raw'} rows.`
    );
  }
  if (rows.length === 0) return '';
  if (kind === 'raw') {
    const columns = [
      'device_id', 'profile_id', 'timestamp', 'serial_number', 'packet_number',
      'quat_w', 'quat_x', 'quat_y', 'quat_z',
      'gyro_x', 'gyro_y', 'gyro_z',
      'acc_x', 'acc_y', 'acc_z',
      'converted_gyro_x', 'converted_gyro_y', 'converted_gyro_z',
      'converted_acc_x', 'converted_acc_y', 'converted_acc_z',
      'press_0', 'press_1', 'press_2', 'press_3', 'press_4', 'press_5',
    ];
    const valueFor = (row: Record<string, unknown>, column: string): unknown => {
      if (column === 'device_id') return result.deviceId;
      if (column === 'profile_id') return result.profileId;
      if (column === 'timestamp') return row.timestamp ?? row.t;
      if (column === 'serial_number' || column === 'packet_number') return row[column];
      const vector = /^(quat|gyro|acc|converted_gyro|converted_acc)_([wxyz])$/.exec(column);
      if (vector) return (row[vector[1]!] as Record<string, unknown> | undefined)?.[vector[2]!];
      const pressure = /^press_(\d)$/.exec(column);
      if (pressure) return (row.press as { values?: unknown[] } | undefined)?.values?.[Number(pressure[1])];
      return '';
    };
    return [
      columns.join(','),
      ...rows.map((row) => columns.map((column) => (
        insoleToolkitCsvEscape(valueFor((row || {}) as Record<string, unknown>, column))
      )).join(',')),
    ].join('\n');
  }
  const preferred = ['step_number', 'gait_type', 'stride_direction', 'distance_m',
    'stance_phase_s', 'swing_phase_s', 'duration_s', 'cadence_hz',
    'speed_mps', 'foot_angle_deg', 'stride_x_m', 'stride_y_m',
    'stride_z_m', 'stride_norm_m', 'landing_force', 'strike_angle_deg',
    'foot_strike', 'pronation_deg', 'pronation_type', 'pronation_z_deg',
    'calorie'];
  const discovered = new Set<string>();
  for (const row of rows) {
    if (row && typeof row === 'object') {
      for (const key of Object.keys(row)) discovered.add(key);
    }
  }
  const columns = [
    'device_id',
    'profile_id',
    ...preferred.filter((key) => discovered.has(key)),
    ...Array.from(discovered).filter((key) => !preferred.includes(key)).sort(),
  ];
  return [
    columns.join(','),
    ...rows.map((row) => columns.map((key) => {
      if (key === 'device_id') return insoleToolkitCsvEscape(result.deviceId);
      if (key === 'profile_id') return insoleToolkitCsvEscape(result.profileId);
      return insoleToolkitCsvEscape((row as Record<string, unknown> | null)?.[key]);
    }).join(',')),
  ].join('\n');
}
