/**
 * OrpheCoreInsole — コンポジット・ファサード。
 *
 *   OrpheCoreInsole = OrpheBleTransport（通信） + DeviceProfile（core/insole 差分）
 *              + SampleEmitter（コールバック配送）
 *
 * デバイスSDK（Orphe / OrpheInsole）はこのファサードを内包するか、
 * 直接これを公開 API として使う。
 *
 *   const ble = new OrpheCoreInsole();   // profile 省略時は autoProfile()（デバイス名で CORE / INSOLE を判別）
 *   const ble = new OrpheCoreInsole({ profile: coreProfile(), id: 0 });
 *   ble.on('acc', (acc) => { ... });
 *   await ble.begin('SENSOR_VALUES', { autoReconnect: true });
 */
import type { BleBluetooth, StorageLike } from '../ble/web-bluetooth.ts';
import type { DeviceGuard, ReconnectConfig, TransportEvents } from '../ble/types.ts';
import type { BeginOptions, DeviceMode, DeviceProfile, SensorFieldMap } from './profile.ts';
import { OrpheBleTransport } from '../ble/transport.ts';
import { decodeFirmwareInfo } from '../protocol/fw-info.ts';
import type { FirmwareInfo } from '../protocol/fw-info.ts';
import { SampleEmitter } from './sample-emitter.ts';
import { autoProfile } from '../profiles/auto.ts';
import type { SampleListener } from './sample-emitter.ts';

/** FW 情報を read する characteristic の論理名 */
const FIRMWARE_NAME_UUID = 'GET_FW_NAME';

/** OrpheCoreInsole のコンストラクタオプション */
export interface OrpheCoreInsoleOptions<TFields extends object = SensorFieldMap> {
  /** デバイス種別の実装（coreProfile() / insoleProfile() / autoProfile()）。省略時は autoProfile() */
  profile?: DeviceProfile<TFields>;
  /** スロット番号（0 or 1）。記憶キーの分離に使う。既定 0 */
  id?: number;
  /** transport イベントの購読（onNotification は parse 前の生 DataView が透過で届く） */
  events?: TransportEvents;
  /** 再接続の既定設定（begin の options.reconnect が優先） */
  reconnect?: ReconnectConfig;
  /** gatt.connect() のハング対策タイムアウト（opt-in） */
  connectTimeoutMs?: number;
  /** デバイス重複割当ガード */
  deviceGuard?: DeviceGuard;
  /** 注入点（テスト・非ブラウザ環境用）: Web Bluetooth 実装。既定 navigator.bluetooth */
  bluetooth?: BleBluetooth;
  /** 注入点: デバイス記憶の保存先。既定 localStorage */
  storage?: StorageLike;
  /** 内部動作のデバッグログ出力先（requestDevice / GATT 解決 / notify 開始など） */
  log?: (message: string, detail?: unknown) => void;
  /** 注入点: 待機の実装。既定 setTimeout */
  wait?: (ms: number) => Promise<void>;
  /** テスト用注入点: BLE 実測周波数計測の単調クロック [ms]。既定 performance.now */
  clock?: () => number;
}

export class OrpheCoreInsole<TFields extends object = SensorFieldMap> {
  /** スロット番号（記憶デバイスの分離キー） */
  readonly id: number;
  /** デバイス種別の実装（接続シーケンス・パースを担う） */
  readonly profile: DeviceProfile<TFields>;
  /** BLE トランスポート（scan / read / write / notify / 再接続） */
  readonly transport: OrpheBleTransport;
  /** フィールド名 → リスナーへサンプルを配送する emitter */
  readonly emitter: SampleEmitter<TFields>;

  private readonly userEvents: TransportEvents;
  private readonly rawListeners = new Set<(uuid: string, value: DataView) => void>();
  private readonly notifySinks = new Map<string, (value: DataView) => void>();
  private readonly clock: () => number;
  private frequencyStart = 0;
  /** 前回 begin() の type。省略時は undefined のまま持ち、再接続のたびにプロファイルの既定を使う */
  private lastBeginType: string | undefined;
  private lastBeginOptions: BeginOptions = {};
  private firmwareInfo: FirmwareInfo | null = null;
  private readonly debugLog: (message: string, detail?: unknown) => void;

  constructor(options: OrpheCoreInsoleOptions<TFields> = {}) {
    this.profile = options.profile ?? (autoProfile() as unknown as DeviceProfile<TFields>);
    this.id = options.id ?? 0;
    this.userEvents = options.events ?? {};
    this.clock = options.clock ?? (() => performance.now());
    this.debugLog = options.log ?? (() => {});
    this.emitter = new SampleEmitter<TFields>((error) => this.userEvents.onError?.(error));

    // ユーザイベントは呼び出し時点で参照する（後から差し替え可能な遅延バインド）
    const delegate = <K extends keyof TransportEvents>(name: K) =>
      (...args: unknown[]) => {
        const callback = this.userEvents[name] as ((...a: unknown[]) => void) | undefined;
        callback?.(...args);
      };

    this.transport = new OrpheBleTransport({
      requestDeviceOptions: () => this.profile.requestDeviceOptions(),
      storageKey: this.profile.storageKey(this.id),
      characteristics: this.profile.characteristics(),
      reconnect: options.reconnect,
      reconnectConnect: () => this.runBegin(this.lastBeginType, this.lastBeginOptions),
      connectTimeoutMs: options.connectTimeoutMs,
      deviceGuard: options.deviceGuard,
      bluetooth: options.bluetooth,
      storage: options.storage,
      log: options.log,
      wait: options.wait,
      events: {
        onScan: delegate('onScan'),
        onConnect: delegate('onConnect'),
        onDisconnect: delegate('onDisconnect'),
        onError: delegate('onError'),
        onWrite: delegate('onWrite'),
        onStartNotify: delegate('onStartNotify'),
        onStopNotify: delegate('onStopNotify'),
        onReconnectAttempt: delegate('onReconnectAttempt'),
        onReconnectSuccess: delegate('onReconnectSuccess'),
        onReconnectFailed: delegate('onReconnectFailed'),
        onNotification: (uuid, value) => {
          // sink（FIFO / Gait 等のプロトコルモジュール）が横取り中は、
          // その uuid の通知を sink のみに渡し、周波数計測・onRaw・parse・
          // events.onNotification をすべてスキップする
          const sink = this.notifySinks.get(uuid);
          if (sink) {
            try {
              sink(value);
            } catch (error) {
              this.reportError(error);
            }
            return;
          }
          // BLE 実測周波数。15ms 以下の間隔は間引き（-1）。
          // 同じ notify のデータより先に配送する。
          const frequency = this.measureFrequencyHz();
          if (frequency > 0) {
            this.emitter.emit(uuid, [{ ble_frequency: frequency } as unknown as Partial<TFields>]);
          }
          // 生データ購読はパース前に呼ぶ
          for (const listener of [...this.rawListeners]) {
            try {
              listener(uuid, value);
            } catch (error) {
              this.reportError(error);
            }
          }
          const samples = this.profile.parse(uuid, value);
          if (samples && samples.length > 0) this.emitter.emit(uuid, samples);
          this.userEvents.onNotification?.(uuid, value);
        },
      },
    });
  }

  // ─── センサーデータ購読 ────────────────────────────────────────

  /**
   * 正規化フィールド名（'acc' / 'gyro' / 'quat' / 'press' ...）で購読する。
   * キーとペイロード型はプロファイルの TFields から推論される（補完が効く）。
   * '*' はサンプル全体。解除関数を返す。
   */
  on<K extends Extract<keyof TFields, string> | '*'>(
    field: K,
    listener: SampleListener<TFields, K>
  ): () => void {
    return this.emitter.on(field, listener);
  }

  /**
   * パース前の生 DataView を購読する（uuid は論理名）。解除関数を返す。
   * attachLegacyCallbacks の gotData 配送などが使う。
   */
  onRaw(listener: (uuid: string, value: DataView) => void): () => void {
    this.rawListeners.add(listener);
    return () => {
      this.rawListeners.delete(listener);
    };
  }

  /**
   * uuid（論理名）の notify を横取りする sink を設定する。FIFO 収録や歩容解析の
   * ように、request/response プロトコルの応答を通常のセンサー配送から切り離して
   * 消費するモジュール用。設定中はその uuid の通知が sink のみに渡る。
   * 解除関数を返す。同じ uuid への多重設定はエラー（横取りの奪い合い事故防止）。
   */
  setNotifySink(uuid: string, sink: (value: DataView) => void): () => void {
    if (this.notifySinks.has(uuid)) {
      throw new Error(`OrpheCoreInsole.setNotifySink: sink already installed for ${uuid}`);
    }
    this.notifySinks.set(uuid, sink);
    return () => {
      if (this.notifySinks.get(uuid) === sink) this.notifySinks.delete(uuid);
    };
  }

  /** コールバック例外などを onError へ安全に報告する（throw は伝播しない） */
  reportError(error: unknown): void {
    try {
      this.userEvents.onError?.(error);
    } catch { /* noop */ }
  }

  /** 前回 notify からの経過時間 → 周波数 [Hz]。15ms 以下は -1（間引き） */
  private measureFrequencyHz(): number {
    const now = this.clock();
    const diff = now - this.frequencyStart;
    this.frequencyStart = now;
    if (diff <= 15) return -1;
    return 1000 / diff;
  }

  // ─── ファームウェアと取得モード ────────────────────────────────

  /**
   * 接続中デバイスのファームウェア情報。begin() の中で 1 回だけ read してキャッシュする。
   * 未接続、または FW 情報を持たない個体では null。
   */
  get firmware(): FirmwareInfo | null {
    return this.firmwareInfo;
  }

  /**
   * 接続中の FW で実際に使える取得モードだけを返す。
   * FW 情報が取れない個体（旧 FW など）は判定できないため絞り込まない。
   */
  get availableModes(): DeviceMode[] {
    const modes = this.profile.modes ? this.profile.modes() : [];
    const releaseDate = this.firmwareInfo?.releaseDate ?? null;
    if (releaseDate === null) return modes;
    return modes.filter(mode => releaseDate >= mode.minReleaseDate);
  }

  /**
   * GET_FW_NAME を read してファームウェア情報を取り直す。
   * characteristic 未実装・read 失敗・日付未書込はすべて null（例外は投げない）。
   * デバイスの選択（chooser のキャンセル、別スロットへの割当済み）だけは失敗として reject する。
   */
  async readFirmwareInfo(): Promise<FirmwareInfo | null> {
    if (!this.transport.hasCharacteristic(FIRMWARE_NAME_UUID)) {
      this.firmwareInfo = null;
      return null;
    }
    // デバイス選択と GATT 接続をここで済ませる場合があるため、その間は connecting を出す
    this.transport.setConnecting(true);
    try {
      await this.transport.scan(FIRMWARE_NAME_UUID);
      try {
        this.firmwareInfo = decodeFirmwareInfo(await this.transport.read(FIRMWARE_NAME_UUID, { silent: true }));
      } catch {
        // 未実装の FW ではここに来る。判定不能として扱い、モードは絞り込まない
        this.firmwareInfo = null;
      }
    } finally {
      this.transport.setConnecting(false);
    }
    return this.firmwareInfo;
  }

  // ─── 接続ライフサイクル ────────────────────────────────────────

  /**
   * 接続してデータ取得を開始する。
   * シーケンスの中身はプロファイルが定義し、成功時にデバイスを記憶、
   * autoReconnect 指定時は以後の切断で同じシーケンスが自動再実行される。
   */
  async begin(type?: string, options: BeginOptions = {}): Promise<unknown> {
    // chooser の強制は最初のデバイス選択にだけ効かせる。プロファイルの各 GATT 操作や
    // 自動再接続へは渡さない（渡すと操作のたびに chooser が開く）
    const { forceDeviceSelection, ...profileOptions } = options;
    this.lastBeginType = type;
    this.lastBeginOptions = profileOptions;

    if (options.autoReconnect) {
      this.transport.enableAutoReconnect(options.reconnect ?? {});
    } else if (this.transport.connectionState !== 'reconnecting') {
      this.transport.disableAutoReconnect();
    }

    if (forceDeviceSelection) {
      this.transport.setConnecting(true);
      try {
        await this.transport.scan('DEVICE_INFORMATION', { forceDeviceSelection: true });
      } finally {
        this.transport.setConnecting(false);
      }
    }
    return this.runBegin(type, profileOptions);
  }

  /** begin シーケンス本体（手動 begin と自動再接続の共通経路） */
  private async runBegin(type: string | undefined, options: BeginOptions): Promise<unknown> {
    this.transport.setConnecting(true);
    try {
      if (this.profile.resolveDevice) {
        // デバイス名で振る舞いを決めるプロファイルには、接続シーケンスの前に選んだデバイスを渡す
        await this.transport.scan('DEVICE_INFORMATION');
        this.profile.resolveDevice(this.transport.device?.name ?? null, this.debugLog);
      }
      // プロファイルの接続シーケンスが FW で分岐できるよう、先に FW を読む
      await this.readFirmwareInfo();
      const notificationType = type ?? this.profile.defaultNotificationType;
      const result = await this.profile.begin({
        transport: this.transport,
        notificationType,
        options,
        firmware: this.firmwareInfo,
        log: this.debugLog,
      });
      this.transport.rememberCurrentDevice();
      this.transport.armAutoReconnect();
      return result;
    } finally {
      this.transport.setConnecting(false);
    }
  }

  /** 切断してクリアする。自動再接続も解除される */
  stop(): void {
    this.reset();
  }

  /** stop() と同じ。切断・記憶クリア・自動再接続解除 */
  reset(): void {
    this.transport.reset();
  }

  /** GATT 接続中なら true */
  isConnected(): boolean {
    return this.transport.isConnected();
  }

  /** 現在の接続状態（'disconnected' / 'connecting' / 'connected'） */
  get connectionState() {
    return this.transport.connectionState;
  }
}
