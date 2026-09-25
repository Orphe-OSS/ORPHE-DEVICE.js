/**
 * OrpheInsole — `new OrpheInsole(0)` + `gotPress = function…` スタイルの INSOLE API。
 * 通信・パース・接続シーケンスは OrpheCoreInsole + insoleProfile が担い、ここは
 * 旧来の呼び出し形をそのまま受けるための薄い層。
 */
import type { LegacyBeginOptions, LegacyDeviceInjections } from './legacy-device.ts';
import { LegacyDevice } from './legacy-device.ts';
import type {
  InsoleDeviceInformation,
  InsoleParseOptions,
  InsolePress,
  InsoleSensorFields,
  InsoleSensorPacket,
  InsoleStampedQuat,
  InsoleStampedVec3,
} from '../profiles/insole.ts';
import { InsoleProfile, decodeInsoleDeviceInformation, insoleProfile, parseInsoleSensorValues } from '../profiles/insole.ts';
import { INSOLE_STREAMING_MODES } from '../modes/insole.ts';
import { ORPHE_UUID } from '../protocol/uuids.ts';
import type { EulerAngles, Quat, Vec3 } from '../protocol/geometry.ts';

/** advertisement から読み取ったデバイス状態（gotStatus のペイロード） */
export interface InsoleAdvertisementStatus {
  name: string | undefined;
  rssi: number | undefined;
  txPower: number | undefined;
  id: string;
  battery: number;
  model_type: number;
  mounting_position: number;
  human_activity_recognition: number;
  version: string;
}

/** addSensorDataListener() に届くイベント */
export interface InsoleSensorDataEvent {
  deviceId: number;
  receivedAt: number;
  packet: InsoleSensorPacket;
  data: DataView;
}

/** begin() のオプション */
export interface InsoleBeginOptions extends LegacyBeginOptions {
  /** データストリーミングモード（1 / 3 / 4）。既定 4 */
  streamingMode?: number;
  /** streamingMode の別名 */
  dataStreamingMode?: number;
}

const REALTIME_HEADERS = new Set([50, 55, 56]);

export class OrpheInsole extends LegacyDevice<InsoleSensorFields> {
  static readonly STREAMING_MODES = INSOLE_STREAMING_MODES;

  /** SENSOR_VALUES の DataView を INSOLE のサンプル列に変換する */
  static parseSensorValues(data: DataView, options: InsoleParseOptions = {}): InsoleSensorPacket | null {
    return parseInsoleSensorValues(data, options);
  }

  /** リアルタイム配信モードの仕様を返す */
  static getStreamingModeInfo(mode: number): (typeof INSOLE_STREAMING_MODES)[number] | null {
    return INSOLE_STREAMING_MODES[Number(mode)] ?? null;
  }

  readonly ORPHE_INFORMATION = ORPHE_UUID.INFORMATION_SERVICE;
  readonly ORPHE_DEVICE_INFORMATION = ORPHE_UUID.DEVICE_INFORMATION;
  readonly ORPHE_DATE_TIME = ORPHE_UUID.DATE_TIME;
  readonly ORPHE_OTHER_SERVICE = ORPHE_UUID.OTHER_SERVICE;
  readonly ORPHE_SENSOR_VALUES = ORPHE_UUID.SENSOR_VALUES;
  readonly ORPHE_STEP_ANALYSIS = ORPHE_UUID.STEP_ANALYSIS;

  /** 内包する InsoleProfile（device_information / streaming_mode / 圧力校正の持ち主） */
  readonly profile: InsoleProfile;
  protected readonly deviceLabel = 'ORPHE INSOLE';

  quat: Quat | InsoleStampedQuat = { w: 0, x: 0, y: 0, z: 0 };
  delta: Vec3 = { x: 0, y: 0, z: 0 };
  euler: EulerAngles = { pitch: 0, roll: 0, yaw: 0 };
  gyro: Vec3 | InsoleStampedVec3 = { x: 0, y: 0, z: 0 };
  acc: Vec3 | InsoleStampedVec3 = { x: 0, y: 0, z: 0 };
  press: InsolePress | { values: number[] } = { values: [0, 0, 0, 0, 0, 0] };
  converted_press: InsolePress | { values: number[] } = { values: [0, 0, 0, 0, 0, 0] };
  converted_gyro: Vec3 | InsoleStampedVec3 = { x: 0, y: 0, z: 0 };
  converted_acc: Vec3 | InsoleStampedVec3 = { x: 0, y: 0, z: 0 };
  /** 最後に受信した advertisement のステータス。未受信なら null */
  lastStatus: InsoleAdvertisementStatus | null = null;
  /** getFirmwareVersion() が解決したバージョン文字列のキャッシュ */
  firmware_version: string | null = null;
  /** 直近に受信した serial 番号 */
  serial_number = 0;

  private readonly sensorDataListeners = new Set<(event: InsoleSensorDataEvent) => void>();
  private detachSensorData: (() => void) | null = null;
  private advertisementListener: ((event: unknown) => void) | null = null;

  constructor(id = 0, injections: LegacyDeviceInjections = {}) {
    const profile = insoleProfile();
    super(profile, id, injections);
    this.profile = profile;
    this.attachCallbacks();
  }

  // ─── 状態 ────────────────────────────────────────────────────

  /** begin() で取得したデバイス情報。未取得なら '' */
  get device_information(): InsoleDeviceInformation | '' {
    return this.profile.device_information ?? '';
  }

  /** 現在のデータストリーミングモード。未設定なら undefined */
  get streaming_mode(): number | undefined {
    return this.profile.streaming_mode ?? undefined;
  }

  protected updateState(sample: Partial<InsoleSensorFields>): void {
    if (sample.quat) this.quat = sample.quat;
    if (sample.gyro) this.gyro = sample.gyro;
    if (sample.acc) this.acc = sample.acc;
    if (sample.press) this.press = sample.press;
    if (sample.converted_press) this.converted_press = sample.converted_press;
    if (sample.converted_gyro) this.converted_gyro = sample.converted_gyro;
    if (sample.converted_acc) this.converted_acc = sample.converted_acc;
    if (sample.euler) this.euler = sample.euler;
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
   * 接続して SENSOR_VALUES の取得を開始する。
   * 失敗は onError に報告したうえで reject する。
   */
  async begin(str_type: string | InsoleBeginOptions = 'SENSOR_VALUES', options: InsoleBeginOptions = {}): Promise<string> {
    let type = str_type;
    if (typeof type === 'object' && type !== null) {
      options = type;
      type = 'SENSOR_VALUES';
    }
    if (type === 'RAW') {
      console.warn('RAW is deprecated. Please use SENSOR_VALUES instead.');
      type = 'SENSOR_VALUES';
    }
    if (type !== 'SENSOR_VALUES') {
      console.warn(`${String(type)} is not supported on ORPHE INSOLE. SENSOR_VALUES will be used instead.`);
      type = 'SENSOR_VALUES';
    }
    return this.runBegin(type, options);
  }

  /** データストリーミングモード（1 / 3 / 4）を書き込む。接続中の切替にも使える */
  setDataStreamingMode(mode = 4): Promise<void> {
    return this.profile.setDataStreamingMode(this.transport, mode);
  }

  /** デバイス情報を読んで device_information を更新する */
  async getDeviceInformation(): Promise<InsoleDeviceInformation> {
    const data = await this.read('DEVICE_INFORMATION');
    this.profile.device_information = decodeInsoleDeviceInformation(data);
    return this.profile.device_information;
  }

  /** INSOLE の FW では未対応 */
  setDeviceInformation(_obj: unknown): void {
    const error = this.notSupported('setDeviceInformation');
    console.warn(error.message);
    this.onError(error);
  }

  /** 解析ログをリセットする */
  resetAnalysisLogs(): Promise<void> {
    return this.write('DEVICE_INFORMATION', [0x04]);
  }

  /**
   * ファームウェアバージョン文字列。advertisement から受信していれば返し、
   * なければ FW 情報のビルド ID を返す。どちらもなければ null（例外は投げない）。
   */
  async getFirmwareVersion(): Promise<string | null> {
    if (this.firmware_version) return this.firmware_version;
    const version = this.lastStatus?.version ?? this.firmware?.name ?? null;
    if (version) this.firmware_version = version;
    return version;
  }

  // ─── リアルタイムパケットの購読 ─────────────────────────────────

  /**
   * デコード済みのリアルタイムパケットを購読する。got* とは独立に呼ばれ、解除関数を返す。
   * FIFO 収録中の要求応答パケットは通知されない。
   */
  addSensorDataListener(listener: (event: InsoleSensorDataEvent) => void): () => void {
    if (typeof listener !== 'function') {
      throw new TypeError('OrpheInsole.addSensorDataListener expects a function');
    }
    this.sensorDataListeners.add(listener);
    if (!this.detachSensorData) {
      this.detachSensorData = this.device.onRaw((uuid, data) => this.emitSensorData(uuid, data));
    }
    return () => this.removeSensorDataListener(listener);
  }

  removeSensorDataListener(listener: (event: InsoleSensorDataEvent) => void): boolean {
    const removed = this.sensorDataListeners.delete(listener);
    if (this.sensorDataListeners.size === 0 && this.detachSensorData) {
      this.detachSensorData();
      this.detachSensorData = null;
    }
    return removed;
  }

  private emitSensorData(uuid: string, data: DataView): void {
    if (uuid !== 'SENSOR_VALUES' || this.sensorDataListeners.size === 0) return;
    const packet = parseInsoleSensorValues(data, this.profile.sensorParseOptions());
    if (!packet || !REALTIME_HEADERS.has(packet.header)) return;
    const event: InsoleSensorDataEvent = Object.freeze({ deviceId: this.id, receivedAt: Date.now(), packet, data });
    for (const listener of [...this.sensorDataListeners]) {
      try {
        listener(event);
      } catch (error) {
        this.onError(error);
      }
    }
  }

  // ─── advertisement 監視 ───────────────────────────────────────

  /** watchAdvertisements が使える環境でのみ監視を始める */
  async autoStartWatchingAdvertisements(): Promise<void> {
    const device = this.bluetoothDevice;
    if (!device || typeof device.watchAdvertisements !== 'function') return;
    await this.startWatchingAdvertisements();
  }

  /** advertisement の監視を開始する。受信は onAdvertisementReceived → gotStatus */
  async startWatchingAdvertisements(): Promise<void> {
    const device = this.bluetoothDevice;
    if (!device || typeof device.watchAdvertisements !== 'function') {
      this._log('watchAdvertisements is not supported on this device/browser');
      return;
    }
    if (!this.advertisementListener) {
      this.advertisementListener = (event) => this.onAdvertisementReceived(event as AdvertisingEvent);
      device.addEventListener('advertisementreceived', this.advertisementListener);
    }
    try {
      await device.watchAdvertisements();
      this._log('Started watching advertisements', device.name);
    } catch (error) {
      this.onError(error);
    }
  }

  stopWatchingAdvertisements(): void {
    const device = this.bluetoothDevice;
    if (device && this.advertisementListener) {
      device.removeEventListener('advertisementreceived', this.advertisementListener);
    }
    this.advertisementListener = null;
  }

  onAdvertisementReceived(event: AdvertisingEvent): void {
    this.onAdvertisement(event);
    const dv = event.manufacturerData?.get(0x0000) ?? null;
    if (!dv || dv.byteLength < 18) return;
    const status: InsoleAdvertisementStatus = {
      name: event.device?.name,
      rssi: event.rssi,
      txPower: event.txPower,
      id: event.device?.id ?? '',
      battery: dv.getUint8(14),
      model_type: dv.getUint8(5),
      mounting_position: dv.getUint8(6),
      human_activity_recognition: dv.getUint8(7),
      version: `${dv.getUint8(15)}.${dv.getUint8(16)}.${dv.getUint8(17)}`,
    };
    this.lastStatus = status;
    this.gotStatus(status);
  }

  // ─── ユーザが上書きするコールバック ────────────────────────────

  gotStatus(_status: InsoleAdvertisementStatus): void { }
  gotPress(_press: InsolePress): void { }
  gotConvertedPress(_press: InsolePress): void { }
  gotQuat(_quat: Quat): void { }
  gotGyro(_gyro: Vec3): void { }
  gotAcc(_acc: Vec3): void { }
  gotConvertedGyro(_gyro: Vec3): void { }
  gotConvertedAcc(_acc: Vec3): void { }
  gotDelta(_delta: Vec3): void { }
  gotEuler(_euler: EulerAngles): void { }
  onAdvertisement(_event: AdvertisingEvent): void { }
}

/** BluetoothAdvertisingEvent の必要な部分だけ */
interface AdvertisingEvent {
  device?: { id?: string; name?: string };
  rssi?: number;
  txPower?: number;
  manufacturerData?: { get(key: number): DataView | undefined };
}
