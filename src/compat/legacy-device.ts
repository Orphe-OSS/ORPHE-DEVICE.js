/**
 * `ble.gotAcc = function…` 代入スタイルの API を OrpheDevice の上に載せる共通土台。
 *
 * - got* / on* は target（このインスタンス）のメソッドとして持ち、ユーザが上書きする
 * - センサーの最新値（quat / acc / gyro …）はプロパティとして保持する
 * - scan / connectGATT / read / write / startNotify / stopNotify は transport へ委譲する
 * - begin() の失敗は例外として伝える（onError にも報告する）
 */
import type { BeginOptions, DeviceProfile, SensorFieldMap } from '../device/profile.ts';
import type { OperationOptions, ReconnectConfig } from '../ble/types.ts';
import type { BleDevice } from '../ble/web-bluetooth.ts';
import type { RememberedDeviceInfo } from '../ble/device-memory.ts';
import type { OrpheDeviceOptions } from '../device/orphe-device.ts';
import type { FirmwareInfo } from '../protocol/fw-info.ts';
import { OrpheDevice } from '../device/orphe-device.ts';
import { attachLegacyCallbacks } from '../device/legacy.ts';
import { readDateTime, syncDeviceTime, writeDateTime } from '../device/time-sync.ts';
import type { DeviceDateTime, SyncTimeResult } from '../device/time-sync.ts';
import { TransportError } from '../ble/errors.ts';

/** begin() のオプション（旧 API の平坦なキー名） */
export interface LegacyBeginOptions {
  /** 切断時の自動再接続を有効化 */
  autoReconnect?: boolean;
  /** 再接続試行の間隔 [ms]。既定 3000 */
  reconnectIntervalMs?: number;
  /** 再接続の最大試行回数。既定 120 */
  reconnectMaxAttempts?: number;
  /** 記憶デバイスを無視して必ず chooser を出す */
  forceDeviceSelection?: boolean;
  /** gatt.connect() のタイムアウト [ms] */
  connectTimeoutMs?: number;
  /** プロファイル固有オプション */
  [key: string]: unknown;
}

/** 自動再接続イベントのペイロード */
export interface LegacyReconnectAttemptInfo { attempt: number; maxAttempts: number; intervalMs: number }
export interface LegacyReconnectSuccessInfo { attempt: number; maxAttempts: number; elapsedMs: number; result: unknown }
export interface LegacyReconnectFailedInfo { maxAttempts: number; elapsedMs: number; error: unknown }

/** テスト・非ブラウザ環境向けの注入点 */
export type LegacyDeviceInjections = Pick<OrpheDeviceOptions, 'bluetooth' | 'storage' | 'wait' | 'clock'>;

const DEFAULT_TIME_SYNC_SAMPLES = 3;

/** クラスごとの生成済みインスタンス（別スロットへの同一デバイス割当を防ぐ） */
const registries = new Map<Function, Set<LegacyDevice<object>>>();

export abstract class LegacyDevice<TFields extends object = SensorFieldMap> {
  /** スロット番号（0 or 1） */
  readonly id: number;
  /** 内包する OrpheDevice。新 API と併用したい場合はこれを使う */
  readonly device: OrpheDevice<TFields>;
  /** デバッグログ（console.info）を有効にする */
  debug = false;
  /** 直近の begin() に渡された notification type */
  notification_type: string;
  /** 直近の時刻同期で推定した片道遅延 [ms] */
  half_round_trip_time = 0;
  /** 直近の getDateTime() の結果 */
  date_time: DeviceDateTime | null = null;

  /** 別スロットのインスタンスが使っているデバイスを選んだとき、接続を拒否する。既定 true */
  rejectDuplicateDevices = true;

  private readonly hooks: Array<() => unknown> = [];
  private detachLegacy: (() => void) | null = null;

  protected constructor(profile: DeviceProfile<TFields>, id: number, injections: LegacyDeviceInjections = {}) {
    this.id = id;
    this.notification_type = profile.defaultNotificationType;
    let registry = registries.get(this.constructor);
    if (!registry) {
      registry = new Set();
      registries.set(this.constructor, registry);
    }
    registry.add(this as LegacyDevice<object>);
    this.device = new OrpheDevice<TFields>({
      profile,
      id,
      ...injections,
      deviceGuard: (device) => this.deviceAssignmentError(device),
      events: {
        onScan: (name) => this.onScan(name),
        onConnect: (uuid) => {
          this.onConnectGATT(uuid);
          this.onConnect(uuid);
        },
        onDisconnect: (event) => this.onDisconnect(event),
        onError: (error) => this.onError(error),
        onWrite: (uuid) => this.onWrite(uuid),
        onStartNotify: (uuid) => this.onStartNotify(uuid),
        onStopNotify: (uuid) => this.onStopNotify(uuid),
        onReconnectAttempt: (info) => this.onReconnectAttempt(info),
        onReconnectSuccess: (info) => this.onReconnectSuccess(info),
        onReconnectFailed: (info) => this.onReconnectFailed(info),
      },
      log: (message, detail) => this._log(message, detail),
    });
    this.device.transport.addAfterReconnectSuccessHook(() => this.runAfterReconnectSuccessHooks());
  }

  /** サブクラスのコンストラクタ末尾で呼ぶ（got* の既定実装を this に持ってから接続する） */
  protected attachCallbacks(): void {
    this.detachLegacy?.();
    this.detachLegacy = attachLegacyCallbacks(this.device, this as unknown as Record<string, unknown>);
    this.device.on('*', (sample) => this.updateState(sample as Partial<TFields>));
  }

  /** サンプルの各フィールドを最新値プロパティへ写す（サブクラスで対象を決める） */
  protected abstract updateState(sample: Partial<TFields>): void;

  /** エラーメッセージに使うデバイス名（'ORPHE INSOLE' など） */
  protected abstract readonly deviceLabel: string;

  /** 同じ Bluetooth デバイスを別スロットのインスタンスが使っていればそれを返す */
  findBluetoothDeviceInUse(device: { id?: string } | null): LegacyDevice<object> | null {
    if (!device) return null;
    for (const instance of registries.get(this.constructor) ?? []) {
      if (instance === this || instance.id === this.id) continue;
      const assigned = instance.bluetoothDevice;
      if (!assigned) continue;
      if (assigned === device || (assigned.id && device.id && assigned.id === device.id)) return instance;
    }
    return null;
  }

  private deviceAssignmentError(device: BleDevice): string | null {
    if (!this.rejectDuplicateDevices) return null;
    const inUseBy = this.findBluetoothDeviceInUse(device);
    if (!inUseBy) return null;
    return `Bluetooth device "${device.name || device.id || 'unknown'}" is already assigned to ${this.deviceLabel} ${String(inUseBy.id + 1).padStart(2, '0')}. Select a different device.`;
  }

  // ─── transport 委譲 ────────────────────────────────────────────

  /** BLE トランスポート */
  get transport() {
    return this.device.transport;
  }

  /** 現在割り当てられている Bluetooth デバイス。未選択なら null */
  get bluetoothDevice(): BleDevice | null {
    return this.device.transport.device;
  }

  /** 接続中の FW 情報（begin() で読む。読めない個体では null） */
  get firmware(): FirmwareInfo | null {
    return this.device.firmware;
  }

  /** 接続状態（'disconnected' / 'connecting' / 'connected' / 'reconnecting'） */
  get connectionState() {
    return this.device.connectionState;
  }

  isConnected(): boolean {
    return this.device.isConnected();
  }

  scan(uuid: string, options: OperationOptions = {}): Promise<void> {
    return this.device.transport.scan(uuid, options);
  }

  /** chooser を開いてデバイスを選び直す（記憶は使わない） */
  requestDevice(uuid = 'DEVICE_INFORMATION'): Promise<void> {
    return this.device.transport.scan(uuid, { forceDeviceSelection: true });
  }

  connectGATT(uuid: string, options: OperationOptions = {}): Promise<void> {
    return this.device.transport.connectGATT(uuid, options);
  }

  read(uuid: string, options: OperationOptions = {}): Promise<DataView> {
    return this.device.transport.read(uuid, options);
  }

  write(uuid: string, data: ArrayLike<number> | ArrayBufferView | ArrayBuffer, options: OperationOptions = {}): Promise<void> {
    return this.device.transport.write(uuid, data as ArrayLike<number>, options);
  }

  startNotify(uuid: string, options: OperationOptions = {}): Promise<void> {
    return this.device.transport.startNotify(uuid, options);
  }

  /** notify を停止する。失敗は onError に報告し、reject はしない */
  stopNotify(uuid: string, options: OperationOptions = {}): Promise<void> {
    return this.device.transport.stopNotify(uuid, options).catch(() => undefined);
  }

  /** 記憶を破棄して必ず chooser を開く。接続済みデバイスから別デバイスへ切り替えるときに使う */
  selectBluetoothDevice(_uuid = 'DEVICE_INFORMATION'): Promise<void> {
    return this.device.transport.selectDevice();
  }

  /** 前回接続に成功して記憶しているデバイス（無ければ null） */
  getLastBluetoothDeviceInfo(): RememberedDeviceInfo | null {
    return this.device.transport.rememberedDevice();
  }

  /** 記憶デバイスを忘れる。次回 begin() は必ず chooser を出す */
  forgetLastBluetoothDevice(): void {
    this.device.transport.forgetRememberedDevice();
  }

  /** GATT を切断する（クリアはしない）。手動切断は reset() を使う */
  disconnect(): void {
    this.device.transport.disconnect();
  }

  /** 切断せずにデバイス割り当てだけ解除する */
  clear(): void {
    this.device.transport.clear();
    this.onClear();
  }

  /** 切断 + クリア + 自動再接続解除 */
  reset(): void {
    this.device.reset();
    this.onReset();
  }

  /** reset() と同じ */
  stop(): void {
    this.reset();
  }

  /**
   * 自動再接続の成功後に呼ぶ内部フックを登録し、解除関数を返す。
   * begin() が再購読する経路以外の characteristic を再購読するために使う。
   */
  addAfterReconnectSuccessHook(hook: () => unknown): () => void {
    this.hooks.push(hook);
    return () => {
      const index = this.hooks.indexOf(hook);
      if (index >= 0) this.hooks.splice(index, 1);
    };
  }

  private runAfterReconnectSuccessHooks(): void {
    for (const hook of [...this.hooks]) {
      try {
        const result = hook();
        if (result && typeof (result as Promise<unknown>).catch === 'function') {
          (result as Promise<unknown>).catch((error) => this.onError(error));
        }
      } catch (error) {
        this.onError(error);
      }
    }
  }

  // ─── begin ────────────────────────────────────────────────────

  /** 旧 API の平坦な再接続オプションを OrpheDevice の形に直す */
  protected toBeginOptions(options: LegacyBeginOptions): BeginOptions {
    const { reconnectIntervalMs, reconnectMaxAttempts, ...rest } = options;
    const reconnect: ReconnectConfig = {};
    if (Number.isFinite(Number(reconnectIntervalMs)) && Number(reconnectIntervalMs) >= 0) {
      reconnect.intervalMs = Number(reconnectIntervalMs);
    }
    if (Number.isFinite(Number(reconnectMaxAttempts)) && Number(reconnectMaxAttempts) > 0) {
      reconnect.maxAttempts = Number(reconnectMaxAttempts);
    }
    return { ...rest, reconnect };
  }

  /** 接続シーケンスを実行する。失敗は onError に報告したうえで throw する */
  protected async runBegin(type: string, options: LegacyBeginOptions): Promise<string> {
    this.notification_type = type;
    return (await this.device.begin(type, this.toBeginOptions(options))) as string;
  }

  // ─── 時刻 ────────────────────────────────────────────────────

  /** デバイスの時刻を読む（往復時間つき） */
  async getDateTime(): Promise<DeviceDateTime> {
    this.date_time = await readDateTime(this.device.transport);
    return this.date_time;
  }

  /** Date をデバイスへ書き込む */
  setDateTime(date: Date): Promise<void> {
    return writeDateTime(this.device.transport, date);
  }

  /** デバイスの時計を PC 時刻 + 平均往復時間/2 に同期する */
  async syncCoreTime(n = DEFAULT_TIME_SYNC_SAMPLES): Promise<SyncTimeResult> {
    const result = await syncDeviceTime(this.device.transport, { samples: n });
    this.half_round_trip_time = result.half_round_trip_time;
    return result;
  }

  // ─── 内部 ────────────────────────────────────────────────────

  /** 内部動作の詳細ログ（debug 時だけ console.info に出す） */
  protected _log(message: string, detail?: unknown): void {
    if (this.debug) console.info(`[${this.constructor.name}]`, message, detail ?? '');
  }

  /** 既定のライフサイクルコールバックの進行ログ（debug 時だけ console.log に出す） */
  private progress(name: string, detail?: unknown): void {
    if (!this.debug) return;
    if (detail === undefined) console.log(name);
    else console.log(name, detail);
  }

  protected notSupported(name: string): TransportError {
    return new TransportError('UNSUPPORTED_MODE', `${name} is not supported on this device.`);
  }

  // ─── ユーザが上書きするコールバック（既定は何もしない） ─────────

  /** gotData を上書きすると生 DataView が届き、他の got* は止まる */
  gotData(_data: DataView, _uuid?: string): void { }
  gotBLEFrequency(_frequency: number): void { }
  lostData(_serial_number: number, _serial_number_prev: number): void { }

  onScan(_deviceName: string | undefined): void { this.progress('onScan'); }
  onConnectGATT(_uuid: string): void { this.progress('onConnectGATT'); }
  onConnect(_uuid: string): void { this.progress('onConnect'); }
  onWrite(_uuid: string): void { this.progress('onWrite'); }
  onStartNotify(uuid: string): void { this.progress('onStartNotify', uuid); }
  onStopNotify(uuid: string): void { this.progress('onStopNotify', uuid); }
  onDisconnect(_event?: unknown): void { this.progress('onDisconnect'); }
  onReconnectAttempt(_info: LegacyReconnectAttemptInfo): void { }
  onReconnectSuccess(_info: LegacyReconnectSuccessInfo): void { }
  onReconnectFailed(_info: LegacyReconnectFailedInfo): void { }
  onClear(): void { this.progress('onClear'); }
  onReset(): void { this.progress('onReset'); }
  onError(error: unknown): void { console.error('onError: ', error); }
}
