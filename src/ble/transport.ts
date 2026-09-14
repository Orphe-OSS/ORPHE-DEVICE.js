/**
 * OrpheBleTransport — ORPHE デバイス共通の BLE トランスポート層。
 *
 * characteristic の UUID 別キャッシュ、notify 世代トークン、遅延バインド
 * 切断ハンドラ、connect タイムアウト、グローバル GATT 操作キューを持つ。
 *
 * デバイス固有の処理（chooser フィルタ、begin() シーケンス、パケットパース、
 * got* ディスパッチ）は持たない。TransportConfig / TransportEvents 経由で
 * デバイスSDK層が注入する。
 */
import type { BleBluetooth, BleBufferSource, BleCharacteristic, BleDevice, StorageLike } from './web-bluetooth.ts';
import type { ConnectionState, OperationOptions, ReconnectConfig, TransportConfig, TransportEvents } from './types.ts';
import type { CharacteristicId } from '../protocol/uuids.ts';
import { TransportError } from './errors.ts';
import { DeviceMemory } from './device-memory.ts';
import type { RememberedDeviceInfo } from './device-memory.ts';
import { GattOperationQueue } from './gatt-queue.ts';

const DEFAULT_RECONNECT_INTERVAL_MS = 3000;
const DEFAULT_RECONNECT_MAX_ATTEMPTS = 120;

type LifecycleEventName =
  | 'onScan'
  | 'onConnect'
  | 'onDisconnect'
  | 'onWrite'
  | 'onStartNotify'
  | 'onStopNotify'
  | 'onReconnectAttempt'
  | 'onReconnectSuccess'
  | 'onReconnectFailed';

/**
 * Web Bluetooth を包む BLE トランスポート。
 *
 * デバイス選択（chooser / 記憶デバイス復元）、GATT 接続、read / write /
 * notify の直列実行、自動再接続をここに集約する。パケットの意味づけは
 * 一切持たず、デバイス固有の処理は {@link DeviceProfile} 側の責務。
 */
export class OrpheBleTransport {
  private readonly config: TransportConfig;
  private readonly events: TransportEvents;
  private readonly bluetooth: BleBluetooth | null;
  private readonly memory: DeviceMemory;
  private readonly queue = new GattOperationQueue();
  private readonly registry: Record<string, CharacteristicId> = {};

  private currentDevice: BleDevice | null = null;
  private usingRememberedDevice = false;
  private characteristics: Record<string, BleCharacteristic> = {};
  private connecting = false;

  // notify 世代管理
  private notifyTokens: Record<string, number> = {};
  private notifyHandlers: Record<string, (event: { target?: { value?: DataView } }) => void> = {};
  private notifyCharacteristics: Record<string, BleCharacteristic> = {};

  // 自動再接続
  private reconnectEnabled = false;
  private reconnectInProgress = false;
  private reconnectArmed = false;
  private reconnectOptions: ReconnectConfig = {};
  private suppressErrors = false;
  private afterReconnectSuccessHooks: Array<() => unknown> = [];
  private disconnectHooks: Array<(event: unknown) => void> = [];

  /** 遅延バインド切断ハンドラ。デバイスごとに1回だけ登録する */
  private readonly disconnectHandler = (event: unknown) => {
    this.invalidateNotifyOperations();
    // モジュールフック（FIFO / Gait 等）を先に呼び、購読状態の無効化を
    // ユーザコールバックより先に済ませる
    for (const hook of [...this.disconnectHooks]) {
      try {
        hook(event);
      } catch (error) {
        this.safeReportError(error);
      }
    }
    this.fireEvent('onDisconnect', event);
    this.maybeStartReconnect();
  };

  constructor(config: TransportConfig) {
    this.config = config;
    this.events = config.events ?? {};
    this.bluetooth = config.bluetooth
      ?? (typeof navigator !== 'undefined' ? (navigator as { bluetooth?: BleBluetooth }).bluetooth ?? null : null);
    const storage: StorageLike = config.storage
      ?? (typeof localStorage !== 'undefined' ? localStorage : new InMemoryFallbackStorage());
    this.memory = new DeviceMemory(config.storageKey ?? 'orphe_ble_last_device', storage);
    for (const [name, id] of Object.entries(config.characteristics ?? {})) {
      this.registerCharacteristic(name, id);
    }
    if (config.reconnect) this.reconnectOptions = { ...config.reconnect };
  }

  // ─── characteristic 登録 ───────────────────────────────────────

  /** 論理名 → UUID ペアを登録する（config.characteristics への後追い追加）。 */
  registerCharacteristic(name: string, id: CharacteristicId): void {
    this.registry[name] = { ...id };
  }

  /** その論理名が登録済みか（プロファイルが宣言していない characteristic の判定）。 */
  hasCharacteristic(name: string): boolean {
    return Object.prototype.hasOwnProperty.call(this.registry, name);
  }

  // ─── 状態 ──────────────────────────────────────────────────────

  /** 現在割り当てられているデバイス。未選択なら null。 */
  get device(): BleDevice | null {
    return this.currentDevice;
  }

  /** GATT 接続中なら true。 */
  isConnected(): boolean {
    return !!this.currentDevice?.gatt?.connected;
  }

  /** 接続状態。`reconnecting` は自動再接続の試行中。 */
  get connectionState(): ConnectionState {
    if (this.isConnected()) return 'connected';
    if (this.reconnectInProgress) return 'reconnecting';
    if (this.connecting) return 'connecting';
    return 'disconnected';
  }

  /** デバイスSDK層の begin() が接続処理中フラグを立てるための口 */
  setConnecting(flag: boolean): void {
    this.connecting = flag;
  }

  // ─── デバイス選択 ──────────────────────────────────────────────

  /**
   * デバイスを確保する。選択済みなら何もしない。
   * 記憶デバイスがあれば chooser なしで復元し、なければ chooser を開く。
   */
  scan(uuid: string, options: OperationOptions = {}): Promise<void> {
    if (this.currentDevice) {
      if (options.forceDeviceSelection) {
        // 強制再選択では旧デバイスの切断イベントで再接続ループを起動させない。
        // arm は接続成功後の armAutoReconnect() で張り直される。
        this.reconnectArmed = false;
        this.dropCurrentDevice({ disconnect: true });
      } else {
        return Promise.resolve();
      }
    }

    // デバイス選択が実際に走るときだけログする（キャッシュ済みの GATT 操作では出さない）
    this.log('scan()', { uuid, options });
    const tryRestore = !options.forceDeviceSelection && this.memory.shouldTryRestore();
    return (async () => {
      const bluetooth = this.requireBluetooth();
      const restored = tryRestore ? await this.memory.restore(bluetooth) : null;
      if (!restored) {
        await this.requestDevice(options);
        return;
      }
      const reason = this.config.deviceGuard?.(restored) ?? null;
      if (reason) {
        this.memory.forget();
        if (this.reconnectInProgress) {
          throw new TransportError('DEVICE_DISALLOWED', reason);
        }
        await this.requestDevice(options);
        return;
      }
      this.log('scan() 記憶デバイスを復元', { id: restored.id, name: restored.name });
      this.adoptDevice(restored, { remembered: true });
    })().catch(error => {
      if (!options.silent) this.reportError(error);
      throw error;
    });
  }

  /** chooser を開いてデバイスを選択する（記憶は使わない） */
  private async requestDevice(_options: OperationOptions = {}): Promise<void> {
    const bluetooth = this.requireBluetooth();
    const configured = this.config.requestDeviceOptions;
    const requestDeviceOptions = typeof configured === 'function' ? configured() : configured;
    this.log('requestDevice()', { requestDeviceOptions });
    const device = await bluetooth.requestDevice(requestDeviceOptions);
    this.log('requestDevice() selected', { id: device.id, name: device.name });
    const reason = this.config.deviceGuard?.(device) ?? null;
    if (reason) {
      throw new TransportError('DEVICE_DISALLOWED', reason);
    }
    this.adoptDevice(device, { remembered: false });
  }

  /**
   * 記憶を破棄して必ず chooser を開く。
   * 接続済みデバイスから別デバイスへ手動で切り替える場合に使う。
   */
  selectDevice(): Promise<void> {
    this.disableAutoReconnect();
    this.invalidateNotifyOperations();
    this.forgetRememberedDevice();
    this.dropCurrentDevice({ disconnect: true });
    return this.requestDevice().catch(error => {
      this.reportError(error);
      throw error;
    });
  }

  /** 現在のデバイスを記憶する（接続成功後にデバイスSDK層が呼ぶ） */
  rememberCurrentDevice(): void {
    if (this.currentDevice) this.memory.remember(this.currentDevice);
  }

  /** 記憶しているデバイス情報（無ければ null） */
  rememberedDevice(): RememberedDeviceInfo | null {
    return this.memory.load();
  }

  /** 記憶デバイスを忘れる（次回は必ず chooser を出す）。 */
  forgetRememberedDevice(): void {
    this.memory.forget();
  }

  private adoptDevice(device: BleDevice, { remembered }: { remembered: boolean }): void {
    this.currentDevice = device;
    this.usingRememberedDevice = remembered;
    device.addEventListener('gattserverdisconnected', this.disconnectHandler);
    this.fireEvent('onScan', device.name);
  }

  private dropCurrentDevice({ disconnect }: { disconnect: boolean }): void {
    const device = this.currentDevice;
    if (!device) return;
    if (disconnect && device.gatt?.connected) {
      try { device.gatt.disconnect(); } catch { /* noop */ }
    }
    device.removeEventListener('gattserverdisconnected', this.disconnectHandler);
    this.currentDevice = null;
    this.characteristics = {};
    this.usingRememberedDevice = false;
  }

  // ─── GATT 接続 ─────────────────────────────────────────────────

  /**
   * uuid（論理名）の characteristic を確保する。
   * UUID 別にキャッシュし、GATT リンク切断後はキャッシュを無効化する。
   */
  connectGATT(uuid: string, options: OperationOptions = {}): Promise<void> {
    const device = this.currentDevice;
    if (!device?.gatt) {
      const error = new TransportError('NO_DEVICE', 'No Bluetooth Device');
      if (!options.silent) this.reportError(error);
      return Promise.reject(error);
    }
    const id = this.registry[uuid];
    if (!id) {
      const error = new TransportError('UNKNOWN_UUID', `Unknown characteristic name: ${uuid}`);
      if (!options.silent) this.reportError(error);
      return Promise.reject(error);
    }
    if (device.gatt.connected && this.characteristics[uuid]) {
      return Promise.resolve();
    }
    // リンクが切れている場合、旧接続の characteristic はすべて無効
    if (!device.gatt.connected) {
      this.characteristics = {};
    }

    this.log('connectGATT()', { uuid, serviceUUID: id.serviceUUID, linked: device.gatt.connected });
    const startedAt = Date.now();
    let connectPromise: Promise<unknown> = device.gatt.connect();
    const timeoutMs = Number(options.connectTimeoutMs ?? this.config.connectTimeoutMs);
    if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
      let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
      connectPromise = Promise.race([
        connectPromise.finally(() => clearTimeout(timeoutTimer)),
        new Promise((_, reject) => {
          timeoutTimer = setTimeout(() => {
            try { this.currentDevice?.gatt?.disconnect(); } catch { /* タイムアウト後の切断失敗は無視 */ }
            reject(new TransportError('CONNECT_TIMEOUT', `GATT connect timed out after ${timeoutMs}ms`));
          }, timeoutMs);
        }),
      ]);
    }

    let linkedAt = startedAt;
    return connectPromise
      .then(() => {
        linkedAt = Date.now();
        return device.gatt!.getPrimaryService(id.serviceUUID);
      })
      .then(service => service.getCharacteristic(id.characteristicUUID))
      .then(characteristic => {
        this.characteristics[uuid] = characteristic;
        // gatt.connect() と サービス探索のどちらが遅いかを切り分けられるようにする
        this.log('connectGATT() 完了', {
          uuid,
          connectMs: linkedAt - startedAt,
          discoverMs: Date.now() - linkedAt,
        });
        this.fireEvent('onConnect', uuid);
      })
      .catch(error => {
        // silent が抑止するのは onError への報告だけ。原因の追跡はできるようにする
        this.log('connectGATT() 失敗', { uuid, message: error instanceof Error ? error.message : String(error) });
        if (!options.silent) this.reportError(error);
        // 記憶デバイス経由の接続失敗は復元を諦め、次回は chooser を出す
        if (this.usingRememberedDevice) {
          this.memory.markUnavailable();
          this.dropCurrentDevice({ disconnect: false });
        }
        throw error;
      });
  }

  private characteristicFor(uuid: string): BleCharacteristic {
    const characteristic = this.characteristics[uuid];
    if (!characteristic) {
      throw new TransportError('UNKNOWN_UUID', `Characteristic not connected: ${uuid}`);
    }
    return characteristic;
  }

  // ─── read / write ──────────────────────────────────────────────

  /**
   * characteristic を read する。未接続なら選択・接続まで自動で行う。
   * @param uuid 論理名（`'DEVICE_INFORMATION'` など）
   */
  read(uuid: string, options: OperationOptions = {}): Promise<DataView> {
    return this.queue.enqueue(() =>
      this.scan(uuid, options)
        .then(() => this.connectGATT(uuid, options))
        .then(() => this.characteristicFor(uuid).readValue())
        .catch(error => {
          if (!options.silent) this.reportError(error);
          throw error;
        })
    );
  }

  /**
   * characteristic へ write する。未接続なら選択・接続まで自動で行う。
   * @param uuid 論理名（`'DEVICE_INFORMATION'` など）
   * @param data バイト列（配列でも TypedArray でも可）
   */
  write(uuid: string, data: ArrayLike<number> | BleBufferSource, options: OperationOptions = {}): Promise<void> {
    return this.queue.enqueue(() =>
      this.scan(uuid, options)
        .then(() => this.connectGATT(uuid, options))
        .then(() => {
          const bytes = toUint8Array(data);
          return this.characteristicFor(uuid).writeValue(bytes);
        })
        .then(() => {
          this.fireEvent('onWrite', uuid);
        })
        .catch(error => {
          this.reportError(error);
          throw error;
        })
    );
  }

  // ─── 切断・クリア ──────────────────────────────────────────────

  /** GATT を切断する。自動再接続が armed なら再接続ループが走る。 */
  disconnect(): void {
    if (!this.currentDevice?.gatt) {
      this.reportError(new TransportError('NO_DEVICE', 'No Bluetooth Device'));
      return;
    }
    if (!this.currentDevice.gatt.connected) {
      this.reportError(new TransportError('ALREADY_DISCONNECTED', 'Bluetooth Device is already disconnected'));
      return;
    }
    this.currentDevice.gatt.disconnect();
  }

  /** 切断せずにデバイス割り当てだけ解除する（別スロットへ譲るときなど）。notify 購読も無効化する。 */
  clear(): void {
    this.invalidateNotifyOperations();
    this.dropCurrentDevice({ disconnect: false });
  }

  /** 切断 + クリア + 自動再接続解除 */
  reset(): void {
    this.disableAutoReconnect();
    this.invalidateNotifyOperations();
    this.dropCurrentDevice({ disconnect: true });
  }

  // ─── notify ────────────────────────────────────────────────────
  //
  // 世代トークンは呼び出し時点で同期的に採番し、待機中に新しい start/stop や
  // 切断が発生した古い操作は handler を登録しない。characteristic 単位の
  // 直列化はグローバル GATT キューが兼ねる。

  /**
   * characteristic の notify を開始する。受信は `events.onNotification` へ流れる。
   * @param uuid 論理名（`'SENSOR_VALUES'` など）
   */
  startNotify(uuid: string, options: OperationOptions = {}): Promise<void> {
    this.log('startNotify()', { uuid });
    const token = this.nextNotifyToken(uuid);
    return this.queue.enqueue(() =>
      this.scan(uuid, options)
        .then(() => {
          if (this.notifyTokens[uuid] !== token) return undefined;
          return this.connectGATT(uuid, options);
        })
        .then(async () => {
          if (this.notifyTokens[uuid] !== token) return undefined;
          const characteristic = this.characteristicFor(uuid);
          await characteristic.startNotifications();
          // 待機中に新しい操作や切断が発生していたら、この古い handler は登録しない
          if (this.notifyTokens[uuid] !== token) return undefined;
          const previousHandler = this.notifyHandlers[uuid];
          const previousCharacteristic = this.notifyCharacteristics[uuid];
          if (previousHandler && previousCharacteristic) {
            try { previousCharacteristic.removeEventListener('characteristicvaluechanged', previousHandler); } catch { /* noop */ }
          }
          const handler = (event: { target?: { value?: DataView } }) => {
            this.dispatchNotification(uuid, event);
          };
          this.notifyHandlers[uuid] = handler;
          this.notifyCharacteristics[uuid] = characteristic;
          characteristic.addEventListener('characteristicvaluechanged', handler);
          this.fireEvent('onStartNotify', uuid);
          return undefined;
        })
        .catch(error => {
          this.reportError(error);
          throw error;
        })
    ).then(() => undefined);
  }

  /** characteristic の notify を停止する（CCCD の購読解除のみ）。 */
  stopNotify(uuid: string, options: OperationOptions = {}): Promise<void> {
    const token = this.nextNotifyToken(uuid);
    return this.queue.enqueue(() =>
      this.scan(uuid, options)
        .then(() => {
          if (this.notifyTokens[uuid] !== token) return undefined;
          return this.connectGATT(uuid, options);
        })
        .then(async () => {
          if (this.notifyTokens[uuid] !== token) return undefined;
          const characteristic = this.characteristicFor(uuid);
          const handler = this.notifyHandlers[uuid];
          const handlerCharacteristic = this.notifyCharacteristics[uuid] || characteristic;
          await characteristic.stopNotifications();
          if (handler) {
            try { handlerCharacteristic.removeEventListener('characteristicvaluechanged', handler); } catch { /* noop */ }
          }
          if (this.notifyHandlers[uuid] === handler) delete this.notifyHandlers[uuid];
          if (this.notifyCharacteristics[uuid] === handlerCharacteristic) delete this.notifyCharacteristics[uuid];
          if (this.notifyTokens[uuid] === token) this.fireEvent('onStopNotify', uuid);
          return undefined;
        })
        .catch(error => {
          this.reportError(error);
          throw error;
        })
    ).then(() => undefined);
  }

  private nextNotifyToken(uuid: string): number {
    const next = (this.notifyTokens[uuid] || 0) + 1;
    this.notifyTokens[uuid] = next;
    return next;
  }

  /** 通知データの配送。onNotification の throw は他の通知配送を壊さない */
  private dispatchNotification(uuid: string, event: { target?: { value?: DataView } }): void {
    const value = event.target?.value;
    if (!value) return;
    try {
      this.events.onNotification?.(uuid, value);
    } catch (error) {
      this.safeReportError(error);
    }
  }

  private invalidateNotifyOperations(): void {
    const uuids = new Set([
      ...Object.keys(this.notifyTokens),
      ...Object.keys(this.notifyHandlers),
      ...Object.keys(this.notifyCharacteristics),
    ]);
    for (const uuid of uuids) {
      this.notifyTokens[uuid] = (this.notifyTokens[uuid] || 0) + 1;
      const handler = this.notifyHandlers[uuid];
      const characteristic = this.notifyCharacteristics[uuid];
      if (handler && characteristic) {
        try { characteristic.removeEventListener('characteristicvaluechanged', handler); } catch { /* noop */ }
      }
      delete this.notifyHandlers[uuid];
      delete this.notifyCharacteristics[uuid];
    }
  }

  // ─── 自動再接続 ────────────────────────────────────────────────
  //
  // 接続処理そのもの（begin シーケンス）は config.reconnectConnect で
  // デバイスSDK層が注入する。resolve = 成功 / reject = 失敗。
  //
  // enable と arm は別段階:
  //   enableAutoReconnect() ... begin(autoReconnect: true) の意思表示
  //   armAutoReconnect()    ... 接続成功後に呼び、以後の切断でループを起動する
  // begin が途中で失敗した場合は armed にならず、切断イベントでループしない。

  /**
   * 自動再接続を有効化する（`config.reconnectConnect` が必要）。
   * 実際にループが走るのは接続成功後に armAutoReconnect() されてから。
   */
  enableAutoReconnect(options: ReconnectConfig = {}): void {
    if (typeof this.config.reconnectConnect !== 'function') {
      throw new TransportError('RECONNECT_NOT_CONFIGURED', 'config.reconnectConnect is required for auto reconnect');
    }
    this.reconnectEnabled = true;
    this.reconnectOptions = { ...this.config.reconnect, ...options };
  }

  /** 自動再接続を無効化し、進行中のループも止める。 */
  disableAutoReconnect(): void {
    this.reconnectEnabled = false;
    this.reconnectArmed = false;
    this.reconnectInProgress = false;
    this.suppressErrors = false;
  }

  /** 接続成功後に呼ぶ。以後の gattserverdisconnected で再接続ループを起動する */
  armAutoReconnect(): void {
    this.reconnectArmed = true;
  }

  /** 再接続ループを手動起動する（通常は切断イベントから自動起動される） */
  startReconnect(): void {
    void this.runReconnectLoop();
  }

  /**
   * 再接続成功後の内部フックを登録し、解除関数を返す。
   * begin() が再購読する経路以外の characteristic（Gait/FIFO 等）の
   * 再購読に使う。
   */
  addAfterReconnectSuccessHook(hook: () => unknown): () => void {
    this.afterReconnectSuccessHooks.push(hook);
    return () => {
      const index = this.afterReconnectSuccessHooks.indexOf(hook);
      if (index >= 0) this.afterReconnectSuccessHooks.splice(index, 1);
    };
  }

  /**
   * gattserverdisconnected の内部フックを登録し、解除関数を返す。
   * events.onDisconnect（ユーザ向け）を占有せずに、モジュール（Gait/FIFO 等）が
   * 自身の購読状態を無効化するために使う。ユーザコールバックより先に呼ばれる。
   */
  addDisconnectHook(hook: (event: unknown) => void): () => void {
    this.disconnectHooks.push(hook);
    return () => {
      const index = this.disconnectHooks.indexOf(hook);
      if (index >= 0) this.disconnectHooks.splice(index, 1);
    };
  }

  private maybeStartReconnect(): void {
    if (!this.reconnectEnabled || !this.reconnectArmed || this.reconnectInProgress) return;
    void this.runReconnectLoop();
  }

  private async runReconnectLoop(): Promise<void> {
    if (!this.reconnectEnabled || this.reconnectInProgress) return;
    const connect = this.config.reconnectConnect;
    if (!connect) {
      this.reportError(new TransportError('RECONNECT_NOT_CONFIGURED', 'config.reconnectConnect is required for auto reconnect'));
      return;
    }

    this.reconnectInProgress = true;
    const startedAt = Date.now();
    const maxAttempts = this.reconnectMaxAttempts();
    const intervalMs = this.reconnectIntervalMs();
    let lastError: unknown = null;

    for (let attempt = 1; this.reconnectEnabled && attempt <= maxAttempts; attempt++) {
      this.fireEvent('onReconnectAttempt', { attempt, maxAttempts, intervalMs });

      try {
        const hasDevice = await this.restoreDeviceForReconnect();
        if (!hasDevice) {
          throw new TransportError('RECONNECT_DEVICE_NOT_FOUND', 'Last connected Bluetooth device not found. Please reconnect manually.');
        }

        this.suppressErrors = true;
        const result = await connect();
        this.suppressErrors = false;

        this.reconnectInProgress = false;
        const info = {
          attempt,
          maxAttempts,
          elapsedMs: Date.now() - startedAt,
          result,
        };
        // 公開 callback が throw して内部復旧を妨げないよう、内部フックを先に起動する
        for (const hook of this.afterReconnectSuccessHooks.slice()) {
          try {
            const hookResult = hook();
            if (hookResult && typeof (hookResult as Promise<unknown>).catch === 'function') {
              (hookResult as Promise<unknown>).catch(hookError => this.safeReportError(hookError));
            }
          } catch (hookError) {
            this.safeReportError(hookError);
          }
        }
        this.fireEvent('onReconnectSuccess', info);
        return;
      } catch (error) {
        this.suppressErrors = false;
        lastError = error;
      }

      if (!this.reconnectEnabled || attempt >= maxAttempts) break;
      await this.waitMs(intervalMs);
    }

    this.reconnectInProgress = false;
    const error = lastError ?? new TransportError('RECONNECT_FAILED', 'Auto reconnect failed.');
    this.fireEvent('onReconnectFailed', { maxAttempts, elapsedMs: Date.now() - startedAt, error });
    this.safeReportError(error);
  }

  /** デバイスを失っている場合、記憶から復元する */
  private async restoreDeviceForReconnect(): Promise<boolean> {
    if (this.currentDevice) return true;
    const bluetooth = this.requireBluetooth();
    const restored = await this.memory.restore(bluetooth);
    if (!restored) return false;
    this.adoptDevice(restored, { remembered: true });
    return true;
  }

  private reconnectIntervalMs(): number {
    const interval = Number(this.reconnectOptions.intervalMs);
    return Number.isFinite(interval) && interval >= 0 ? interval : DEFAULT_RECONNECT_INTERVAL_MS;
  }

  private reconnectMaxAttempts(): number {
    const attempts = Number(this.reconnectOptions.maxAttempts);
    return Number.isFinite(attempts) && attempts > 0 ? attempts : DEFAULT_RECONNECT_MAX_ATTEMPTS;
  }

  private waitMs(ms: number): Promise<void> {
    const wait = this.config.wait ?? ((delayMs: number) => new Promise<void>(resolve => setTimeout(resolve, delayMs)));
    return wait(ms);
  }

  // ─── 内部ユーティリティ ────────────────────────────────────────

  private requireBluetooth(): BleBluetooth {
    if (!this.bluetooth) {
      throw new TransportError('NO_BLUETOOTH', 'Web Bluetooth API is not available');
    }
    return this.bluetooth;
  }

  /**
   * transport 内エラーの報告。自動再接続の試行中は onError を逐一発火させない
   * （最終失敗のみループが報告する）。
   */
  private reportError(error: unknown): void {
    if (this.suppressErrors) return; // 再接続試行中のエラーはループが最終報告する
    this.safeReportError(error);
  }

  /** onError 自体の throw も外へ伝播させない */
  private safeReportError(error: unknown): void {
    try {
      this.events.onError?.(error);
    } catch (reportError) {
      try { console.error('OrpheBleTransport onError callback failed:', reportError); } catch { /* noop */ }
    }
  }

  /**
   * ライフサイクルイベントの発火。ユーザコールバックの throw は
   * トランスポートの状態遷移を壊さず onError へ報告する。
   */
  private fireEvent(name: LifecycleEventName, ...args: unknown[]): void {
    const callback = this.events[name] as ((...a: unknown[]) => unknown) | undefined;
    if (typeof callback !== 'function') return;
    try {
      const result = callback(...args);
      if (result && typeof (result as Promise<unknown>).catch === 'function') {
        (result as Promise<unknown>).catch(error => this.safeReportError(error));
      }
    } catch (error) {
      this.safeReportError(error);
    }
  }

  private log(message: string, detail?: unknown): void {
    this.config.log?.(message, detail);
  }
}

function toUint8Array(data: ArrayLike<number> | BleBufferSource): Uint8Array {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  return Uint8Array.from(data as ArrayLike<number>);
}


/** localStorage が存在しない環境（テスト以外では通らない想定）用のフォールバック */
class InMemoryFallbackStorage implements StorageLike {
  private map = new Map<string, string>();
  getItem(key: string): string | null {
    return this.map.has(key) ? this.map.get(key)! : null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
}
