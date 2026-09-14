/**
 * DeviceProfile — デバイス固有差分（CORE / INSOLE）の注入点。
 *
 * OrpheDevice ファサードはこの interface だけに依存する。
 * プロファイルが持つのは:
 *   - chooser フィルタ / characteristic テーブル / 記憶キー
 *   - begin() の接続シーケンス（DeviceInfo 書込・streaming mode・時刻同期・notify 開始）
 *   - 通知パケットのパース（DataView → 正規化サンプル列）
 * 通信そのもの（GATT/notify/再接続）は transport に委譲し、ここには書かない。
 */
import type { BleRequestDeviceOptions } from '../ble/web-bluetooth.ts';
import type { GattIo, ReconnectConfig } from '../ble/types.ts';
import type { CharacteristicId } from '../protocol/uuids.ts';
import type { FirmwareInfo } from '../protocol/fw-info.ts';

/**
 * パース済みの正規化サンプル。
 * フィールド名がそのまま SampleEmitter の購読名になる
 * （例: acc / gyro / quat / press / converted_acc / serial_number）。
 * デバイス固有フィールドの追加は自由。
 */
export interface SensorSample {
  [field: string]: unknown;
}

/**
 * プロファイルが配送するフィールド名 → ペイロード型のマップ。
 * DeviceProfile<TFields> として宣言すると、OrpheDevice.on() のイベントキー補完と
 * リスナー引数の型付けに使われる（例: InsoleSensorFields）。
 */
export type SensorFieldMap = Record<string, unknown>;

/**
 * 取得モード 1 件ぶんの定義。
 * begin() の notification type のほか、FIFO のような上位機能も 1 モードとして並べる。
 */
export interface DeviceMode {
  /** モード識別子（begin() に渡す type 名と同じ文字列） */
  id: string;
  /** 表示用のラベル */
  label: string;
  /**
   * 利用に必要な最小 FW リリース日（`YYYYMMDD`）。0 は FW を問わない。
   * 接続中デバイスのリリース日と比較して {@link OrpheDevice.availableModes} を決める。
   */
  minReleaseDate: number;
}

/** serial 欠損イベント（'lost_data' フィールド）のペイロード */
export interface LostDataInfo {
  /** 欠損検知時の serial 番号 */
  serial: number;
  /** 前回受信した serial 番号 */
  prev: number;
}

/**
 * begin() のオプション。
 * プロファイル固有のキー（INSOLE の streamingMode、CORE の range 等）も
 * このオブジェクトに混ぜて渡せる（インデックスシグネチャで透過する）。
 */
export interface BeginOptions {
  /** 切断時の自動再接続を有効化 */
  autoReconnect?: boolean;
  /** 再接続の間隔・回数 */
  reconnect?: ReconnectConfig;
  /** 記憶デバイスを無視して必ず chooser を出す */
  forceDeviceSelection?: boolean;
  /** プロファイル固有オプション（range / streamingMode 等）はそのまま透過する */
  [key: string]: unknown;
}

/** DeviceProfile.begin() に渡される接続シーケンスの実行コンテキスト */
export interface BeginContext {
  /** GATT 操作（read/write/startNotify）を行うトランスポート */
  transport: GattIo;
  /** 正規化済みの notification type（begin() の第1引数） */
  notificationType: string;
  /** begin() に渡されたオプション（プロファイル固有キーを含む） */
  options: BeginOptions;
  /** 接続先の FW 情報（begin() の先頭で読む。読めなければ null） */
  firmware: FirmwareInfo | null;
  /** デバッグログ（OrpheDeviceOptions.log）。接続シーケンスの判断を残すのに使う */
  log?: (message: string, detail?: unknown) => void;
}

/**
 * デバイス固有差分（CORE / INSOLE）の注入点。
 * OrpheDevice はこの interface だけに依存し、接続シーケンスとパースを委譲する。
 */
export interface DeviceProfile<TFields extends object = SensorFieldMap> {
  /** 'core' | 'insole' など */
  readonly kind: string;
  /** begin() の type 省略時に使う notification type */
  readonly defaultNotificationType: string;
  /** デバイス記憶の localStorage キー（スロット id ごとに一意） */
  storageKey(id: number): string;
  /** chooser のフィルタ設定 */
  requestDeviceOptions(): BleRequestDeviceOptions;
  /** 論理名 → UUID ペアのテーブル */
  characteristics(): Record<string, CharacteristicId>;
  /**
   * 接続シーケンス。transport の read/write/startNotify だけで記述する。
   * resolve = 成功（値は begin() の戻り値になる）/ reject = 失敗。
   * 自動再接続時にも同じシーケンスが再実行される。
   */
  begin(context: BeginContext): Promise<unknown>;
  /**
   * 通知パケットをパースする。対象外の uuid や不正パケットは null を返す。
   * 返したサンプル列（TFields の部分集合）は SampleEmitter へそのまま配送される。
   */
  parse(uuid: string, data: DataView): Array<Partial<TFields>> | null;
  /**
   * このデバイスが提供しうる取得モードの一覧（FW による絞り込み前）。
   * 未実装なら FW によるモード制限を行わない。
   */
  modes?(): DeviceMode[];
}
