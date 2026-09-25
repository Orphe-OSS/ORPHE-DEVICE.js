/**
 * Web Bluetooth API の構造的型。
 *
 * DOM lib に依存せず、Node 上のテストでモック実装を注入できるようにするため
 * 利用する範囲だけを自前で定義する。実行時はブラウザの navigator.bluetooth が
 * そのまま当てはまる。
 */

/** DOM lib の BufferSource 相当（DOM lib 非依存のための自前定義） */
export type BleBufferSource = ArrayBufferView | ArrayBuffer;

/** BluetoothRemoteGATTCharacteristic 相当 */
export interface BleCharacteristic {
  /** 現在値を読む */
  readValue(): Promise<DataView>;
  /** 値を書き込む */
  writeValue(data: BleBufferSource): Promise<void>;
  /** notify（CCCD 購読）を開始する */
  startNotifications(): Promise<unknown>;
  /** notify（CCCD 購読）を停止する */
  stopNotifications(): Promise<unknown>;
  /** characteristicvaluechanged のリスナーを登録する */
  addEventListener(type: string, listener: (event: BleValueChangedEvent) => void): void;
  /** characteristicvaluechanged のリスナーを解除する */
  removeEventListener(type: string, listener: (event: BleValueChangedEvent) => void): void;
}

/** characteristicvaluechanged イベント相当 */
export interface BleValueChangedEvent {
  /** 値を発火した characteristic */
  target?: {
    /** 受信データ */ value?: DataView;
  };
}

/** BluetoothRemoteGATTService 相当 */
export interface BleGattService {
  /** サービス配下の characteristic を取得する */
  getCharacteristic(uuid: string): Promise<BleCharacteristic>;
}

/** BluetoothRemoteGATTServer 相当 */
export interface BleGattServer {
  /** GATT 接続中なら true */
  readonly connected: boolean;
  /** GATT 接続する */
  connect(): Promise<BleGattServer>;
  /** GATT 切断する */
  disconnect(): void;
  /** プライマリサービスを取得する */
  getPrimaryService(uuid: string): Promise<BleGattService>;
}

/** BluetoothDevice 相当 */
export interface BleDevice {
  /** ブラウザが割り当てたデバイス id（記憶デバイスの照合に使う） */
  readonly id?: string;
  /** アドバタイズされたデバイス名 */
  readonly name?: string;
  /** GATT サーバ */
  readonly gatt?: BleGattServer;
  /**
   * 広告の受信を開始する。Chrome では New Permissions Backend 有効時のみ生えるため、
   * 未対応環境では undefined。記憶デバイスへ再接続する前の在圏確認に使う。
   */
  watchAdvertisements?(options?: { signal?: AbortSignal }): Promise<void>;
  /** gattserverdisconnected / advertisementreceived などのリスナーを登録する */
  addEventListener(type: string, listener: (event: unknown) => void): void;
  /** リスナーを解除する */
  removeEventListener(type: string, listener: (event: unknown) => void): void;
}

/** navigator.bluetooth.requestDevice() のオプション（利用する範囲のみ） */
export interface BleRequestDeviceOptions {
  /** chooser に出すデバイスの絞り込み条件 */
  filters?: Array<{
    /** このサービス UUID を広告するデバイスだけ出す */ services?: string[];
    /** デバイス名がこの接頭辞のものだけ出す */ namePrefix?: string;
  }>;
  /** すべてのデバイスを出す（filters と併用不可） */
  acceptAllDevices?: boolean;
  /** 接続後にアクセスを許可するサービス UUID */
  optionalServices?: string[];
  /** アクセスを許可する製造者データの Company ID */
  optionalManufacturerData?: number[];
}

/** navigator.bluetooth 相当 */
export interface BleBluetooth {
  /** chooser を出してユーザにデバイスを選ばせる */
  requestDevice(options: BleRequestDeviceOptions): Promise<BleDevice>;
  /** Chrome の New Permissions Backend。未対応環境では undefined */
  getDevices?(): Promise<BleDevice[]>;
}

/** localStorage 相当（デバイス記憶の永続化先） */
export interface StorageLike {
  /** キーの値を返す（無ければ null） */
  getItem(key: string): string | null;
  /** キーへ値を保存する */
  setItem(key: string, value: string): void;
  /** キーを削除する */
  removeItem(key: string): void;
}
