/**
 * BLE トランスポート層の契約（設定・イベント・操作オプション）。
 *
 * 依存方向:
 *   デバイス層 (OrpheCoreInsole / DeviceProfile) → OrpheBleTransport → Web Bluetooth API
 *
 * Web Bluetooth そのものの型は web-bluetooth.ts、エラーは errors.ts。
 */
import type { BleBluetooth, BleBufferSource, BleDevice, BleRequestDeviceOptions, StorageLike } from './web-bluetooth.ts';
import type { CharacteristicId } from '../protocol/uuids.ts';

// ─── イベント / コールバック ─────────────────────────────────────

/** onReconnectAttempt のペイロード（再接続の試行ごとに通知） */
export interface ReconnectAttemptInfo {
  /** 何回目の試行か（1 始まり） */
  attempt: number;
  /** 試行回数の上限 */
  maxAttempts: number;
  /** 試行間隔 [ms] */
  intervalMs: number;
}

/** onReconnectSuccess のペイロード */
export interface ReconnectSuccessInfo {
  /** 成功した試行の番号（1 始まり） */
  attempt: number;
  /** 試行回数の上限 */
  maxAttempts: number;
  /** 切断からの経過時間 [ms] */
  elapsedMs: number;
  /** 再実行した begin シーケンスの戻り値 */
  result: unknown;
}

/** onReconnectFailed のペイロード（上限まで失敗して諦めたとき） */
export interface ReconnectFailedInfo {
  /** 試行回数の上限 */
  maxAttempts: number;
  /** 切断からの経過時間 [ms] */
  elapsedMs: number;
  /** 最後の試行で発生したエラー */
  error: unknown;
}

/**
 * トランスポートからデバイスSDK層へのイベント通知。
 * すべて省略可能。ユーザコールバックの throw はトランスポートの状態遷移を
 * 壊さない（safe-callback ラップされ、onError へ報告される）。
 */
export interface TransportEvents {
  /** デバイス選択（chooser または記憶デバイス復元）完了 */
  onScan?(deviceName: string | undefined): void;
  /** characteristic 取得完了（uuid = 論理名） */
  onConnect?(uuid: string): void;
  /** gattserverdisconnected */
  onDisconnect?(event: unknown): void;
  /** transport 内で発生したエラー（自動再接続中は抑制され最後の1件のみ保持） */
  onError?(error: unknown): void;
  /** write 完了（uuid は論理名） */
  onWrite?(uuid: string): void;
  /** notify 購読の開始要求（uuid は論理名） */
  onStartNotify?(uuid: string): void;
  /** notify 購読の停止要求（uuid は論理名） */
  onStopNotify?(uuid: string): void;
  /** characteristicvaluechanged。データのパースはデバイスSDK層の責務 */
  onNotification?(uuid: string, value: DataView): void;
  /** 自動再接続の試行ごとに通知 */
  onReconnectAttempt?(info: ReconnectAttemptInfo): void;
  /** 自動再接続の成功（begin シーケンス再実行済み） */
  onReconnectSuccess?(info: ReconnectSuccessInfo): void;
  /** 自動再接続を諦めた（上限到達） */
  onReconnectFailed?(info: ReconnectFailedInfo): void;
}

// ─── 設定 ────────────────────────────────────────────────────────

/** 自動再接続の設定 */
export interface ReconnectConfig {
  /** 再接続試行の間隔。既定 3000ms */
  intervalMs?: number;
  /** 再接続の最大試行回数。既定 120 */
  maxAttempts?: number;
}

/**
 * デバイス重複割当ガード（別スロットに割当済みのデバイスを弾く等）。
 * 許可なら null、拒否ならエラーメッセージを返す。
 */
export type DeviceGuard = (device: BleDevice) => string | null;

/** {@link OrpheBleTransport} の生成設定。 */
export interface TransportConfig {
  /** chooser のフィルタ設定。関数を渡すと chooser を開くたびに呼んで最新の設定を使う */
  requestDeviceOptions: BleRequestDeviceOptions | (() => BleRequestDeviceOptions);
  /** デバイス記憶の localStorage キー（スロットごとに一意にする） */
  storageKey?: string;
  /** 論理名 → UUID ペア。registerCharacteristic() でも追加できる */
  characteristics?: Record<string, CharacteristicId>;
  /** デバイスSDK層へのイベント通知先 */
  events?: TransportEvents;
  /** 自動再接続の設定 */
  reconnect?: ReconnectConfig;
  /**
   * 自動再接続1回分の接続処理。デバイスSDKの begin() シーケンス
   * （DeviceInfo書込・streaming mode設定・時刻同期・notify開始）を渡す。
   * 未設定の場合、自動再接続は有効化できない。
   */
  reconnectConnect?: () => Promise<unknown>;
  /** gatt.connect() のハング対策タイムアウト（opt-in・既定なし） */
  connectTimeoutMs?: number;
  /** デバイス重複割当ガード */
  deviceGuard?: DeviceGuard;
  /** 注入点: 既定 navigator.bluetooth */
  bluetooth?: BleBluetooth;
  /** 注入点: 既定 localStorage */
  storage?: StorageLike;
  /** デバッグログ出力先（未設定ならログなし） */
  log?: (message: string, detail?: unknown) => void;
  /** テスト用: 再接続待機の実装（既定 setTimeout） */
  wait?: (ms: number) => Promise<void>;
}

/**
 * プロファイルやプロトコルヘルパが必要とする GATT 操作の最小集合。
 * {@link OrpheBleTransport} がこれを満たす。テストではモックを渡せる。
 * 具象クラスへ依存させないための境界。
 */
export interface GattIo {
  /** characteristic を read する（uuid は論理名） */
  read(uuid: string, options?: OperationOptions): Promise<DataView>;
  /** characteristic へ write する（uuid は論理名） */
  write(uuid: string, data: ArrayLike<number> | BleBufferSource, options?: OperationOptions): Promise<void>;
  /** notify を開始する（uuid は論理名） */
  startNotify(uuid: string, options?: OperationOptions): Promise<void>;
  /** notify を停止する（uuid は論理名） */
  stopNotify(uuid: string, options?: OperationOptions): Promise<void>;
}

/** scan / read / write / notify 操作ごとの上書きオプション */
export interface OperationOptions {
  /** 記憶デバイスを無視して必ず chooser を出す */
  forceDeviceSelection?: boolean;
  /** gatt.connect() タイムアウトの操作単位上書き */
  connectTimeoutMs?: number;
  /**
   * 失敗しても events.onError へ報告しない（例外は throw する）。
   * 任意 characteristic の存在確認のように「無ければ無いで良い」read に使う。
   */
  silent?: boolean;
}

/** 接続状態。reconnecting は自動再接続の試行中 */
export type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'reconnecting';
