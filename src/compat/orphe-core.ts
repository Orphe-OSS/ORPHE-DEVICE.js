/**
 * Orphe — `new Orphe(0)` + `gotGait = function…` スタイルの CORE API。
 * 通信・パース・接続シーケンスは OrpheDevice + coreProfile が担い、ここは
 * 旧来の呼び出し形と CORE 固有コマンド（LED / 取付位置 / 姿勢リセット）を受ける薄い層。
 * BleSharedBridge によるタブ間共有もここで束ねる。
 */
import type { LegacyBeginOptions, LegacyDeviceInjections } from './legacy-device.ts';
import { LegacyDevice } from './legacy-device.ts';
import type {
  CoreDeviceInformation,
  CoreGaitPayload,
  CorePronationPayload,
  CoreProfileOptions,
  CoreQuat,
  CoreScalar,
  CoreSensorFields,
  CoreStridePayload,
  CoreVec3,
} from '../profiles/core.ts';
import { CoreProfile, coreProfile, decodeCoreDeviceInformation, encodeCoreDeviceInformation } from '../profiles/core.ts';
import { ORPHE_UUID } from '../protocol/uuids.ts';
import type { EulerAngles, Quat, Vec3 } from '../protocol/geometry.ts';
import { BleSharedBridge } from '../bridge.ts';
import type { BridgeCallbacks, BridgeEnvironment, BridgeTimingOptions } from '../bridge.ts';

/** begin() のオプション */
export interface CoreBeginOptions extends LegacyBeginOptions {
  /** 加速度・角速度のレンジ（物理値。acc: 2/4/8/16、gyro: 250/500/1000/2000） */
  range?: { acc?: number; gyro?: number };
  /** 同じスロットの BLE 接続を別タブと共有する（BleSharedBridge）。既定 false */
  useSharedBridge?: boolean;
}

/** 旧 API の device_information（`data` は `raw` の別名） */
export interface LegacyCoreDeviceInformation extends CoreDeviceInformation {
  data: DataView;
}

/** Orphe のコンストラクタへ渡せる注入点 */
export interface OrpheInjections extends LegacyDeviceInjections {
  /** coreProfile() のオプション（namePrefix / settleMs など）。namePrefix の既定は 'CR-' */
  profile?: CoreProfileOptions;
  /** タブ間共有の環境（テストではモックを注入する） */
  bridgeEnvironment?: BridgeEnvironment;
  /** タブ間共有のタイミング設定 */
  bridgeTiming?: BridgeTimingOptions;
}

/** Secondary タブへ配送するフィールド（Primary が parse したサンプルのキー） */
const BRIDGED_FIELDS: ReadonlyArray<keyof CoreSensorFields> = [
  'acc', 'gyro', 'quat', 'euler', 'converted_acc', 'converted_gyro', 'delta',
  'gait', 'type', 'direction', 'distance', 'calorie', 'standing_phase_duration', 'swing_phase_duration',
  'stride', 'foot_angle', 'pronation', 'landing_impact', 'steps_number', 'ble_frequency',
];

const EMPTY_GAIT = (): CoreGaitPayload => ({
  type: 0, direction: 0, calorie: 0, distance: 0, steps: 0, standing_phase_duration: 0, swing_phase_duration: 0,
});

export class Orphe extends LegacyDevice<CoreSensorFields> {
  readonly ORPHE_INFORMATION = ORPHE_UUID.INFORMATION_SERVICE;
  readonly ORPHE_DEVICE_INFORMATION = ORPHE_UUID.DEVICE_INFORMATION;
  readonly ORPHE_DATE_TIME = ORPHE_UUID.DATE_TIME;
  readonly ORPHE_OTHER_SERVICE = ORPHE_UUID.OTHER_SERVICE;
  readonly ORPHE_SENSOR_VALUES = ORPHE_UUID.SENSOR_VALUES;
  readonly ORPHE_STEP_ANALYSIS = ORPHE_UUID.STEP_ANALYSIS;

  /** 内包する CoreProfile（device_information の持ち主） */
  readonly profile: CoreProfile;
  protected readonly deviceLabel = 'ORPHE CORE';

  gait: CoreGaitPayload = EMPTY_GAIT();
  stride: CoreStridePayload | { foot_angle: number; x: number; y: number; z: number; steps: number } =
    { foot_angle: 0, x: 0, y: 0, z: 0, steps: 0 };
  pronation: CorePronationPayload | { landing_impact: number; x: number; y: number; z: number; steps: number } =
    { landing_impact: 0, x: 0, y: 0, z: 0, steps: 0 };
  steps_number = 0;
  quat: Quat | CoreQuat = { w: 0, x: 0, y: 0, z: 0 };
  delta: Vec3 = { x: 0, y: 0, z: 0 };
  euler: EulerAngles = { pitch: 0, roll: 0, yaw: 0 };
  gyro: Vec3 | CoreVec3 = { x: 0, y: 0, z: 0 };
  acc: Vec3 | CoreVec3 = { x: 0, y: 0, z: 0 };
  converted_gyro: Vec3 | CoreVec3 = { x: 0, y: 0, z: 0 };
  converted_acc: Vec3 | CoreVec3 = { x: 0, y: 0, z: 0 };
  /** 直近に受信した serial 番号 */
  serial_number = 0;

  private readonly bridgeEnvironment: BridgeEnvironment | null;
  private readonly bridgeTiming: BridgeTimingOptions;
  private bridge: BleSharedBridge | null = null;
  private bridgeSecondary = false;
  private detachBridgeBroadcast: (() => void) | null = null;
  private detachBridgeDisconnect: (() => void) | null = null;

  constructor(id = 0, injections: OrpheInjections = {}) {
    // サービス UUID のフィルタに一致しない環境でも、名前で CORE を拾えるようにする
    const profile = coreProfile({ namePrefix: 'CR-', ...injections.profile });
    const { profile: _profile, bridgeEnvironment, bridgeTiming, ...deviceInjections } = injections;
    super(profile, id, deviceInjections);
    this.profile = profile;
    this.bridgeEnvironment = bridgeEnvironment ?? null;
    this.bridgeTiming = bridgeTiming ?? {};
    this.attachCallbacks();
  }

  // ─── 状態 ────────────────────────────────────────────────────

  /** begin() で取得したデバイス情報。未取得なら '' */
  get device_information(): LegacyCoreDeviceInformation | '' {
    const info = this.profile.device_information;
    return info ? { ...info, data: info.raw } : '';
  }

  /** 別タブの BLE 接続を共有する Secondary として動作中なら true */
  get isBridgeSecondary(): boolean {
    return this.bridgeSecondary;
  }

  protected updateState(sample: Partial<CoreSensorFields>): void {
    if (sample.quat) this.quat = sample.quat;
    if (sample.gyro) this.gyro = sample.gyro;
    if (sample.acc) this.acc = sample.acc;
    if (sample.converted_gyro) this.converted_gyro = sample.converted_gyro;
    if (sample.converted_acc) this.converted_acc = sample.converted_acc;
    if (sample.euler) this.euler = sample.euler;
    if (sample.delta) this.delta = sample.delta;
    if (sample.gait) this.gait = sample.gait;
    if (sample.stride) this.stride = { ...sample.stride, foot_angle: sample.foot_angle?.value ?? 0, steps: sample.stride.steps_number };
    if (sample.pronation) {
      this.pronation = { ...sample.pronation, landing_impact: sample.landing_impact?.value ?? 0, steps: sample.steps_number?.value ?? this.steps_number };
    }
    if (sample.steps_number) this.steps_number = sample.steps_number.value;
    if (typeof sample.serial_number === 'number') this.serial_number = sample.serial_number;
  }

  // ─── 初期化・接続 ─────────────────────────────────────────────

  /** 互換のために残す初期化。characteristic は profile が持つので何もしない */
  setup(_names: string[] = [], _options: Record<string, unknown> = {}): void { }

  /** 論理名 → UUID を上書き登録する */
  setUUID(name: string, serviceUUID: string, characteristicUUID: string): void {
    this.transport.registerCharacteristic(name, { serviceUUID, characteristicUUID });
  }

  /**
   * 接続してデータ取得を開始する。
   * useSharedBridge: true のとき、別タブが同じスロットの BLE 接続を持っていれば、そのタブから配信を受ける Secondary になる。
   * 失敗は onError に報告したうえで reject する。
   */
  async begin(str_type = 'STEP_ANALYSIS', options: CoreBeginOptions = {}): Promise<string> {
    const { useSharedBridge, ...rest } = options;
    this.releaseBridge();

    if (useSharedBridge === true) {
      const bridge = this.createBridge();
      if (bridge?.isRemotePrimaryAvailable()) {
        return this.beginAsSecondary(bridge, str_type);
      }
      bridge?.release();
    }

    const result = await this.runBegin(str_type, rest);

    if (useSharedBridge === true) {
      const bridge = this.createBridge();
      if (bridge) {
        this.bridge = bridge;
        this.bridgeSecondary = false;
        bridge.claimPrimary();
        this.detachBridgeBroadcast = this.device.on('*', (sample) => {
          const batch: Record<string, unknown> = {};
          for (const field of BRIDGED_FIELDS) {
            const value = (sample as Record<string, unknown>)[field];
            if (value !== undefined) batch[field] = value;
          }
          if (Object.keys(batch).length > 0) bridge.broadcastBatch(batch);
        });
        this.detachBridgeDisconnect = this.transport.addDisconnectHook(() => {
          if (this.bridge === bridge && bridge.isPrimary) {
            bridge.broadcastDisconnect();
            this.detachBridge();
          }
        });
      }
    }
    return result;
  }

  private createBridge(): BleSharedBridge | null {
    if (this.bridgeEnvironment) return new BleSharedBridge(this.id, this.bridgeEnvironment, this.bridgeTiming);
    const g = globalThis as { window?: unknown; localStorage?: unknown };
    if (typeof g.window === 'undefined' || typeof g.localStorage === 'undefined') return null;
    return new BleSharedBridge(this.id, undefined, this.bridgeTiming);
  }

  private beginAsSecondary(bridge: BleSharedBridge, str_type: string): Promise<string> {
    this.bridge = bridge;
    this.bridgeSecondary = true;
    this.notification_type = str_type;
    const callbacks: BridgeCallbacks = {};
    for (const field of BRIDGED_FIELDS) {
      callbacks[field] = (data: unknown) => {
        this.device.emitter.emit('BRIDGE', [{ [field]: data } as Partial<CoreSensorFields>]);
      };
    }
    callbacks.onPrimaryLost = () => { void this.handlePrimaryLost(str_type); };
    bridge.subscribeAsSecondary(callbacks);
    this.onConnect('BRIDGE_SECONDARY');
    return Promise.resolve('done begin(); BRIDGE SECONDARY');
  }

  /**
   * Primary タブを失ったときの復帰。ランダム遅延の後、他タブが Primary になっていれば
   * Secondary に戻り、いなければ記憶デバイスで自分が接続する。
   */
  private async handlePrimaryLost(str_type: string): Promise<void> {
    if (!this.bridgeSecondary) return;
    const bridge = this.bridge;
    this.detachBridge();
    this.onDisconnect();

    const delay = Math.random() * (bridge?.electionMaxDelayMs ?? 0);
    await new Promise(resolve => setTimeout(resolve, delay));

    const probe = this.createBridge();
    if (probe?.isRemotePrimaryAvailable()) {
      await this.beginAsSecondary(probe, str_type);
      return;
    }
    probe?.release();
    try {
      await this.begin(str_type, { useSharedBridge: true });
    } catch (error) {
      this.onError(new Error(`Primary tab closed. Please reconnect manually. (${error instanceof Error ? error.message : String(error)})`));
    }
  }

  private detachBridge(): void {
    this.detachBridgeBroadcast?.();
    this.detachBridgeBroadcast = null;
    this.detachBridgeDisconnect?.();
    this.detachBridgeDisconnect = null;
    this.bridge = null;
    this.bridgeSecondary = false;
  }

  private releaseBridge(): void {
    const bridge = this.bridge;
    if (bridge) {
      if (bridge.isPrimary) bridge.broadcastDisconnect();
      else bridge.release();
    }
    this.detachBridge();
  }

  override selectBluetoothDevice(uuid = 'DEVICE_INFORMATION'): Promise<void> {
    this.releaseBridge();
    return super.selectBluetoothDevice(uuid);
  }

  override reset(): void {
    const wasSecondary = this.bridgeSecondary;
    this.releaseBridge();
    if (wasSecondary) {
      this.device.transport.disableAutoReconnect();
      this.onReset();
      return;
    }
    super.reset();
  }

  // ─── デバイス設定・コマンド ───────────────────────────────────

  /** デバイス情報を読んで device_information を更新する */
  async getDeviceInformation(): Promise<LegacyCoreDeviceInformation> {
    const data = await this.read('DEVICE_INFORMATION');
    this.profile.device_information = decodeCoreDeviceInformation(data);
    return this.device_information as LegacyCoreDeviceInformation;
  }

  /** device_information 形式のオブジェクトを書き込んでデバイス設定を変える */
  setDeviceInformation(obj: Omit<CoreDeviceInformation, 'raw' | 'battery' | 'rec_mode'>): Promise<void> {
    return this.write('DEVICE_INFORMATION', encodeCoreDeviceInformation(obj));
  }

  /** LED の点灯パターンを設定する（on_off: 0/1、pattern: 0..4） */
  setLED(on_off: number, pattern: number): Promise<void> {
    return this.write('DEVICE_INFORMATION', [0x02, on_off, pattern]);
  }

  /** LED の明るさを設定する（0..255、0 で消灯）。デバイス情報は取得済みであること */
  async setLEDBrightness(value: number): Promise<void> {
    const info = this.profile.device_information ?? decodeCoreDeviceInformation(await this.read('DEVICE_INFORMATION'));
    info.led_brightness = value;
    this.profile.device_information = info;
    await this.setDeviceInformation(info);
  }

  /** 取付位置を設定する（0: left-instep, 1: right-instep, 2: left-plantar, 3: right-plantar） */
  async setMountPosition(position: number): Promise<void> {
    if (!Number.isInteger(position) || position < 0 || position > 3) {
      throw new Error('Invalid position');
    }
    const info = await this.getDeviceInformation();
    info.lr = position;
    this.profile.device_information = info;
    await this.setDeviceInformation(info);
  }

  /** 姿勢（クォータニオン計算）をリセットする */
  resetMotionSensorAttitude(): Promise<void> {
    return this.write('DEVICE_INFORMATION', [0x03]);
  }

  /** 解析ログ（歩数など）をリセットする */
  resetAnalysisLogs(): Promise<void> {
    this.profile.resetAnalysisState();
    this.gait = EMPTY_GAIT();
    this.stride = { foot_angle: 0, x: 0, y: 0, z: 0, steps: 0 };
    this.pronation = { landing_impact: 0, x: 0, y: 0, z: 0, steps: 0 };
    this.steps_number = 0;
    return this.write('DEVICE_INFORMATION', [0x04]);
  }

  // ─── ユーザが上書きするコールバック ────────────────────────────

  gotQuat(_quat: Quat): void { }
  gotGyro(_gyro: Vec3): void { }
  gotAcc(_acc: Vec3): void { }
  gotConvertedGyro(_gyro: Vec3): void { }
  gotConvertedAcc(_acc: Vec3): void { }
  gotDelta(_delta: Vec3): void { }
  gotEuler(_euler: EulerAngles): void { }
  gotGait(_gait: CoreGaitPayload): void { }
  gotType(_type: CoreScalar): void { }
  gotDirection(_direction: CoreScalar): void { }
  gotCalorie(_calorie: CoreScalar): void { }
  gotDistance(_distance: CoreScalar): void { }
  gotStandingPhaseDuration(_duration: CoreScalar): void { }
  gotSwingPhaseDuration(_duration: CoreScalar): void { }
  gotStride(_stride: CoreStridePayload): void { }
  gotFootAngle(_foot_angle: CoreScalar): void { }
  gotPronation(_pronation: CorePronationPayload): void { }
  gotLandingImpact(_landing_impact: CoreScalar): void { }
  gotStepsNumber(_steps_number: CoreScalar): void { }
}
