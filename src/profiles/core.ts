/**
 * CoreProfile — ORPHE CORE の DeviceProfile 実装。
 *
 * - header 50 (200Hz) の quaternion は FW により Q14 / Q15 のどちらでも来るため、実ノルムで正規化する。
 * - converted_gyro はレンジ別のデータシート感度で deg/s に換算する（INSOLE と同じ換算）。
 * STEP_ANALYSIS は steps の単調増加で重複配送を抑止する。
 */
import type { CharacteristicId } from '../protocol/uuids.ts';
import { TransportError } from '../ble/errors.ts';
import type { BeginContext, DeviceMode, DeviceProfile, LostDataInfo } from '../device/profile.ts';
import type { Quat, Vec3 } from '../protocol/geometry.ts';
import type { BleRequestDeviceOptions } from '../ble/web-bluetooth.ts';
import { ORPHE_UUID, orpheCharacteristics } from '../protocol/uuids.ts';
import { CORE_MODES } from '../modes/core.ts';
import { syncDeviceTime } from '../device/time-sync.ts';
import { getFloat16 } from '../protocol/float16.ts';
import { normalizeQuaternionCoreStyle, quatToEuler } from '../protocol/geometry.ts';
import type { EulerAngles } from '../protocol/geometry.ts';

/** 加速度レンジ設定 index（0..3）→ 物理フルスケール値 [G] */
export const CORE_ACC_RANGES = Object.freeze([2, 4, 8, 16] as const);
/** ジャイロレンジ設定 index（0..3）→ 物理フルスケール値 [dps] */
export const CORE_GYRO_RANGES = Object.freeze([250, 500, 1000, 2000] as const);

/**
 * ジャイロ感度: フルスケール 1 dps あたりの deg/s/LSB（LSM6DSOX 代表値。±2000 dps で 70 mdps/LSB）。
 * header 40 の int8 は int16 の上位バイトなので ×256 してから掛ける。
 */
const CORE_GYRO_DPS_PER_LSB_PER_RANGE = 0.000035;

function gyroRawToDps(raw: number, gyroRange: number): number {
  return raw * gyroRange * CORE_GYRO_DPS_PER_LSB_PER_RANGE;
}

// ─── ペイロード型（got* コールバック引数の形状） ─────────────────

/** header 50（200Hz パケット）の各サンプルに付くスタンプ */
export interface CoreSampleStamp {
  /** サンプル時刻（epoch ms。パケット内時刻を当日の日付に展開したもの） */
  timestamp: number;
  /** パケットの通し番号（uint16。lost_data 検出に使う） */
  serial_number: number;
  /** パケット内のフレーム番号（0..3） */
  packet_number: number;
}

/** CORE の3軸ベクトル。stamp は header 50 のみ付く（header 40 は無し） */
export interface CoreVec3 extends Vec3, Partial<CoreSampleStamp> {}
/** CORE のクォータニオン。stamp は header 50 のみ付く */
export interface CoreQuat extends Quat, Partial<CoreSampleStamp> {}

/** スカラー系コールバック（gotType 等）の {value} 形状 */
export interface CoreScalar {
  /** スカラー値 */
  value: number;
}

/** 歩容概要ペイロード（STEP_ANALYSIS sub 0） */
export interface CoreGaitPayload {
  /** 歩行タイプ（0:none / 1:walk / 2:run / 3:stance） */
  type: number;
  /** 進行方向の分類値 */
  direction: number;
  /** 消費カロリー（FW 計算値） */
  calorie: number;
  /** 距離（FW 計算値） */
  distance: number;
  /** 累計歩数 */
  steps: number;
  /** 立脚期時間 [s] */
  standing_phase_duration: number;
  /** 遊脚期時間 [s] */
  swing_phase_duration: number;
}

/** ストライドペイロード。steps は steps_number として渡される */
export interface CoreStridePayload extends Vec3 {
  /** その歩の累計歩数 */
  steps_number: number;
}

export interface CorePronationPayload extends Vec3 {}

/**
 * フィールド名 → ペイロード型のマップ。
 * OrpheDevice.on() のイベントキー補完とリスナー引数の型付けに使われる。
 * フィールド名は got* コールバック名から got を除いた snake_case。
 */
export interface CoreSensorFields {
  /** サンプル時刻（epoch ms、header 50 のみ） */
  timestamp: number;
  /** パケット通し番号（header 50 のみ） */
  serial_number: number;
  /** パケット内フレーム番号 0..3（header 50 のみ） */
  packet_number: number;
  /** 加速度（-1..1 の正規化値） */
  acc: CoreVec3;
  /** クォータニオン（header 50 は実ノルムで正規化、header 40 は Q14） */
  quat: CoreQuat;
  /** 角速度（-1..1 の正規化値） */
  gyro: CoreVec3;
  /** 加速度 [G]（acc × レンジ） */
  converted_acc: CoreVec3;
  /** 角速度 [dps]（レンジ別のデータシート感度で換算） */
  converted_gyro: CoreVec3;
  /** 微小変位（STEP_ANALYSIS sub 4） */
  delta: Vec3;
  /** 累計歩数（STEP_ANALYSIS） */
  steps_number: CoreScalar;
  /** 歩容概要（1歩ごと） */
  gait: CoreGaitPayload;
  /** 歩行タイプ単体（gait と同時に配送） */
  type: CoreScalar;
  /** 距離単体（gait と同時に配送） */
  distance: CoreScalar;
  /** 進行方向単体（gait と同時に配送） */
  direction: CoreScalar;
  /** カロリー単体（gait と同時に配送） */
  calorie: CoreScalar;
  /** 立脚期時間 [s]（gait と同時に配送） */
  standing_phase_duration: CoreScalar;
  /** 遊脚期時間 [s]（gait と同時に配送） */
  swing_phase_duration: CoreScalar;
  /** 着地時の足角度 [deg]（stride と同時に配送） */
  foot_angle: CoreScalar;
  /** ストライドベクトル（1歩ごと） */
  stride: CoreStridePayload;
  /** プロネーションベクトル（1歩ごと） */
  pronation: CorePronationPayload;
  /** 着地衝撃（pronation と同時に配送） */
  landing_impact: CoreScalar;
  /** quat から計算した Euler 角（gotEuler 相当） */
  euler: EulerAngles;
  /** BLE 実測周波数 [Hz]（gotBLEFrequency 相当。facade が配送する） */
  ble_frequency: number;
  /** serial 欠損（lostData 相当。header 50 のみ） */
  lost_data: LostDataInfo;
}

/** parse() が返す1サンプル（CoreSensorFields の部分集合） */
export type CoreSensorSample = Partial<CoreSensorFields>;

/** parseCoreSensorValues のオプション */
export interface CoreParseOptions {
  /** 加速度のフルスケール [G] */
  accRange: number;
  /** ジャイロのフルスケール [dps] */
  gyroRange: number;
  /** テスト用注入点: パケット基準時刻の「今日」を決める現在時刻 */
  now?: () => Date;
  /** header 50 で quat のノルムが 0 のフレームに使う直前の姿勢 */
  previousQuat?: Quat | null;
}

function timestampToday(now: Date, hours: number, minutes: number, seconds: number, milliseconds: number): number {
  const date = new Date(now.getTime());
  date.setHours(hours);
  date.setMinutes(minutes);
  date.setSeconds(seconds);
  date.setMilliseconds(milliseconds);
  return date.getTime();
}

/**
 * SENSOR_VALUES packet parser。
 * - header 50 (0x32): 200Hz・92byte・21byte×4フレーム
 * - header 40 (0x28): 通常・quat Q14・gyro/acc int8/127・単一サンプル
 * 対象外ヘッダ・不正長は null。
 */
export function parseCoreSensorValues(data: DataView, options: CoreParseOptions): CoreSensorSample[] | null {
  const header = data.getUint8(0);
  const { accRange, gyroRange } = options;

  if (header === 50) {
    if (data.byteLength !== 92) return null;
    const serial_number = data.getUint16(1);
    const now = options.now ? options.now() : new Date();
    const t_base = timestampToday(now, data.getUint8(3), data.getUint8(4), data.getUint8(5), data.getUint16(6));
    // フレーム i の基準時刻からの経過 [ms]。フレーム 3（最古）には delta が無いので等間隔とみなす
    const delta0 = data.getUint8(28);
    const delta1 = data.getUint8(49);
    const delta2 = data.getUint8(70);
    const frameAgeMs = [delta0, delta1, delta2, delta2 + (delta1 - delta0)];

    const samples: CoreSensorSample[] = [];
    let previousQuat = options.previousQuat ?? null;
    for (let i = 3; i >= 0; i--) {
      const timestamp = t_base - frameAgeMs[i]!;
      const packet_number = 3 - i;
      const stamp = { timestamp, serial_number, packet_number };
      const gyro: CoreVec3 = {
        x: data.getInt16(16 + 21 * i) / 32768,
        y: data.getInt16(18 + 21 * i) / 32768,
        z: data.getInt16(20 + 21 * i) / 32768,
        ...stamp,
      };
      const acc: CoreVec3 = {
        x: data.getInt16(22 + 21 * i) / 32768,
        y: data.getInt16(24 + 21 * i) / 32768,
        z: data.getInt16(26 + 21 * i) / 32768,
        ...stamp,
      };
      const unit = normalizeFrameQuat(
        data.getInt16(8 + 21 * i),
        data.getInt16(10 + 21 * i),
        data.getInt16(12 + 21 * i),
        data.getInt16(14 + 21 * i),
        previousQuat,
      );
      previousQuat = unit;
      const quat: CoreQuat = { ...unit, ...stamp };
      samples.push({
        ...stamp,
        // 配送順は固定（acc → quat → gyro → converted_acc → converted_gyro → euler）
        acc,
        quat,
        gyro,
        converted_acc: { x: acc.x * accRange, y: acc.y * accRange, z: acc.z * accRange, ...stamp },
        converted_gyro: {
          x: gyroRawToDps(gyro.x * 32768, gyroRange),
          y: gyroRawToDps(gyro.y * 32768, gyroRange),
          z: gyroRawToDps(gyro.z * 32768, gyroRange),
          ...stamp,
        },
        euler: quatToEuler(quat),
      });
    }
    return samples;
  }

  if (header === 40) {
    if (data.byteLength < 17) return null;
    // CORE 2.0 の通常 SENSOR_VALUES は quaternion が Q14。
    // Q15 (/32768) として読むと norm が約 0.5 になり Euler 角が不安定になる。
    const quatScale = 16384;
    const gyro: CoreVec3 = {
      x: data.getInt8(9) / 127,
      y: data.getInt8(10) / 127,
      z: data.getInt8(11) / 127,
    };
    const acc: CoreVec3 = {
      x: data.getInt8(14) / 127,
      y: data.getInt8(15) / 127,
      z: data.getInt8(16) / 127,
    };
    const quat: CoreQuat = {
      w: data.getInt16(1) / quatScale,
      x: data.getInt16(3) / quatScale,
      y: data.getInt16(5) / quatScale,
      z: data.getInt16(7) / quatScale,
    };
    return [{
      acc,
      quat,
      gyro,
      converted_acc: { x: acc.x * accRange, y: acc.y * accRange, z: acc.z * accRange },
      converted_gyro: {
        x: gyroRawToDps(data.getInt8(9) * 256, gyroRange),
        y: gyroRawToDps(data.getInt8(10) * 256, gyroRange),
        z: gyroRawToDps(data.getInt8(11) * 256, gyroRange),
      },
      // header 40 の euler は normalize 済みの quat から計算する
      euler: quatToEuler(normalizeQuaternionCoreStyle(quat)),
    }];
  }

  return null;
}

/** header 50 の quat（固定小数点の int16）を単位クォータニオンにする。ノルムがほぼ 0 なら直前の姿勢を維持 */
function normalizeFrameQuat(w: number, x: number, y: number, z: number, previous: Quat | null): Quat {
  const norm = Math.sqrt(w * w + x * x + y * y + z * z);
  if (norm > 1e-6) return { w: w / norm, x: x / norm, y: y / norm, z: z / norm };
  if (previous && Math.hypot(previous.w, previous.x, previous.y, previous.z) > 1e-6) {
    return { w: previous.w, x: previous.x, y: previous.y, z: previous.z };
  }
  return { w: 1, x: 0, y: 0, z: 0 };
}

// ─── STEP_ANALYSIS ───────────────────────────────────────────────

/** STEP_ANALYSIS パケットのデコード結果（sub 0/1/2/4 のいずれか1つを持つ） */
export interface CoreStepAnalysisPacket {
  /** サブヘッダ（byte1）: 0=gait / 1=stride / 2=pronation / 4=quat+delta */
  subheader: number;
  /** 累計歩数（byte2-3, uint16 BE） */
  steps: number;
  /** 歩容概要（sub 0） */
  gait?: {
    /** 歩行タイプ（0:none / 1:walk / 2:run / 3:stance） */ type: number;
    /** 進行方向の分類値 */ direction: number;
    /** 消費カロリー */ calorie: number;
    /** 距離 [m] */ distance: number;
    /** 立脚期時間 [s] */ standing_phase_duration: number;
    /** 遊脚期時間 [s] */ swing_phase_duration: number;
  };
  /** ストライド（sub 1）。ベクトル成分 + 着地時の足角度 */
  stride?: {
    /** 着地時の足角度 [deg] */ foot_angle: number;
  } & Vec3;
  /** プロネーション（sub 2）。ベクトル成分 + 着地衝撃 */
  pronation?: {
    /** 着地衝撃 */ landing_impact: number;
  } & Vec3;
  /** 姿勢クォータニオン（sub 4） */
  quat?: Quat;
  /** 微小変位（sub 4） */
  delta?: Vec3;
}

/**
 * STEP_ANALYSIS packet（20byte）のステートレスなデコード。
 * 重複配送の抑止（steps 単調増加フィルタ）は CoreProfile 側で行う。
 */
export function decodeCoreStepAnalysis(data: DataView): CoreStepAnalysisPacket | null {
  if (data.byteLength < 20) return null;
  const subheader = data.getUint8(1);
  const steps = data.getUint16(2);
  const packet: CoreStepAnalysisPacket = { subheader, steps };

  if (subheader === 0) {
    const flags = data.getUint8(4);
    packet.gait = {
      type: (flags & 0b11000000) >>> 6,
      direction: (flags & 0b00111000) >>> 3,
      calorie: getFloat16(data, 6),
      distance: data.getFloat32(8),
      standing_phase_duration: data.getFloat32(12),
      swing_phase_duration: data.getFloat32(16),
    };
  } else if (subheader === 1) {
    packet.stride = {
      foot_angle: data.getFloat32(4),
      x: data.getFloat32(8),
      y: data.getFloat32(12),
      z: data.getFloat32(16),
    };
  } else if (subheader === 2) {
    packet.pronation = {
      landing_impact: data.getFloat32(4),
      x: data.getFloat32(8),
      y: data.getFloat32(12),
      z: data.getFloat32(16),
    };
  } else if (subheader === 4) {
    packet.quat = {
      w: getFloat16(data, 6),
      x: getFloat16(data, 8),
      y: getFloat16(data, 10),
      z: getFloat16(data, 12),
    };
    packet.delta = {
      x: getFloat16(data, 14),
      y: getFloat16(data, 16),
      z: getFloat16(data, 18),
    };
  }
  // subheader 3 (Stride Attitude) / 5 / 6 は未対応

  return packet;
}

// ─── DEVICE_INFORMATION ──────────────────────────────────────────

/** DEVICE_INFORMATION の read 結果（デバイス設定） */
export interface CoreDeviceInformation {
  /** バッテリー残量（少ない:0、普通:1、多い:2） */
  battery: number;
  /** 取り付け位置 bit0: 0=left/1=right, bit1: 0=足底/1=足背 */
  lr: number;
  /** 記録モード（0:記録してない 1:記録中 2:一時停止中） */
  rec_mode: number;
  /** 自動ラン記録設定 */
  rec_auto_run: number;
  /** LED の明るさ設定 */
  led_brightness: number;
  /** ログの単位時間（上位バイト） */
  time01: number;
  /** ログの単位時間（下位バイト） */
  time02: number;
  /** レンジ設定 index（acc: 0..3 → ±2/4/8/16G, gyro: 0..3 → ±250/500/1000/2000dps） */
  range: {
    /** 加速度レンジの index */ acc: number;
    /** ジャイロレンジの index */ gyro: number;
  };
  /** read した生ペイロード（未定義バイトの参照用） */
  raw: DataView;
}

/** DEVICE_INFORMATION の read ペイロードをデコードする */
export function decodeCoreDeviceInformation(data: DataView): CoreDeviceInformation {
  return {
    battery: data.getUint8(0),
    lr: data.getUint8(1),
    rec_mode: data.getUint8(2),
    rec_auto_run: data.getUint8(3),
    led_brightness: data.getUint8(4),
    time01: data.getUint8(6),
    time02: data.getUint8(7),
    range: {
      acc: data.getUint8(8),
      gyro: data.getUint8(9),
    },
    raw: data,
  };
}

/** setDeviceInformation の書込 payload */
export function encodeCoreDeviceInformation(info: Omit<CoreDeviceInformation, 'raw' | 'battery' | 'rec_mode'>): Uint8Array {
  return Uint8Array.from([
    0x01,
    info.lr,
    info.led_brightness,
    0, // モーターの強さ（未使用）
    info.rec_auto_run,
    info.time01,
    info.time02,
    info.range.acc,
    info.range.gyro,
  ]);
}

// index 0..3 は表の値、それ以外の数値はフルスケール値として素通し、数値でなければ fallback
function rangeFromSetting(ranges: readonly number[], setting: unknown, fallback: number): number {
  if (typeof setting !== 'number' || !Number.isFinite(setting)) return fallback;
  return Number.isInteger(setting) && setting >= 0 && setting < ranges.length ? ranges[setting]! : setting;
}

// 物理フルスケール値 → index。該当なしは null（デバイスの現在値を維持）
function indexFromRange(ranges: readonly number[], physical: unknown): number | null {
  const index = ranges.indexOf(Number(physical));
  return index >= 0 ? index : null;
}

/**
 * ORPHE CORE 用の chooser フィルタ。
 * 標準は services フィルタのみ（CR-2 / CR-3 実機は advertisement に
 * service UUID を載せている）。
 *
 * `namePrefix` を渡すと OR フィルタ（名前でもサービスUUIDでもヒット）になる。
 * service UUID を advertise しない環境や同居接続で名前でも拾いたい場合に使う。
 */
export function coreRequestDeviceOptions(options: { namePrefix?: string } = {}): BleRequestDeviceOptions {
  const filters: BleRequestDeviceOptions['filters'] = [];
  if (options.namePrefix) filters.push({ namePrefix: options.namePrefix });
  filters.push({ services: [ORPHE_UUID.INFORMATION_SERVICE] });
  return {
    filters,
    acceptAllDevices: false,
    optionalServices: [ORPHE_UUID.INFORMATION_SERVICE, ORPHE_UUID.OTHER_SERVICE],
  };
}

// ─── プロファイル ────────────────────────────────────────────────

/** begin() に渡せる notification type の一覧 */
export const CORE_NOTIFICATION_TYPES = Object.freeze([
  'STEP_ANALYSIS',
  'SENSOR_VALUES',
  'STEP_ANALYSIS_AND_SENSOR_VALUES',
] as const);

/** coreProfile() のオプション */
export interface CoreProfileOptions {
  /**
   * begin 中の DeviceInfo 書込後の待機時間。既定 500ms（CORE 2 でデバイス情報の
   * 書込反映に時間がかかることへの対策）。テストでは 0 に。
   */
  settleMs?: number;
  /** 時刻同期の計測回数。既定 3 */
  timeSyncSamples?: number;
  /**
   * chooser に namePrefix フィルタを併用（OR）する。
   * サービス UUID のフィルタに一致しない環境でも名前で拾えるようにする（例 'CR-'）。
   */
  namePrefix?: string;
  /**
   * header 50 の 104 バイト版パケットも先頭 92 バイトとして受け付ける。既定 false。
   * 104 バイト版の quaternion は STEP_ANALYSIS と軸の取り方が異なるため、姿勢表示に混ぜる場合は注意する。
   */
  acceptExtendedSensorValues?: boolean;
}

export class CoreProfile implements DeviceProfile<CoreSensorFields> {
  readonly kind = 'core';
  readonly defaultNotificationType = 'STEP_ANALYSIS';

  /** begin() で取得したデバイス設定。parse() の換算レンジに使う */
  device_information: CoreDeviceInformation | null = null;

  private defaults: CoreProfileOptions;
  // STEP_ANALYSIS の重複配送抑止カウンタ
  private stepsNumber = 0;
  private gaitSteps = 0;
  private strideSteps = 0;
  private pronationSteps = 0;
  // SENSOR_VALUES header 50 の serial 追跡（lost_data 相当）。uint16 の巻き戻りは連続とみなす
  private serialNumber: number | null = null;
  // header 50 で quat のノルムが 0 のフレームに使う直前の姿勢（全ソース共通）
  private lastQuat: Quat | null = null;

  constructor(options: CoreProfileOptions = {}) {
    this.defaults = options;
  }

  storageKey(id: number): string {
    // 利用者の記憶デバイスを引き継ぐため、このキー文字列は変更しないこと
    return `orphe_last_bluetooth_device_${id}`;
  }

  /** chooser の namePrefix フィルタを変える（次に chooser を開くときから効く。undefined で外す） */
  setNamePrefix(namePrefix: string | undefined): void {
    this.defaults = { ...this.defaults, namePrefix };
  }

  requestDeviceOptions(): BleRequestDeviceOptions {
    return coreRequestDeviceOptions(
      this.defaults.namePrefix ? { namePrefix: this.defaults.namePrefix } : {}
    );
  }

  characteristics(): Record<string, CharacteristicId> {
    return orpheCharacteristics();
  }

  modes(): DeviceMode[] {
    return CORE_MODES.map(mode => ({ ...mode }));
  }

  /** resetAnalysisLogs 相当の内部カウンタ初期化 */
  resetAnalysisState(): void {
    this.stepsNumber = 0;
    this.gaitSteps = 0;
    this.strideSteps = 0;
    this.pronationSteps = 0;
  }

  async begin(context: BeginContext): Promise<string> {
    const { transport, options } = context;
    const type = normalizeNotificationType(context.notificationType);
    // 接続し直すと serial の連続性は保証されないので追跡をやり直す
    this.serialNumber = null;

    const infoData = await transport.read('DEVICE_INFORMATION', options);
    this.device_information = decodeCoreDeviceInformation(infoData);

    // options.range（物理値）が指定されていれば index に変換して上書きする
    const range = (options.range ?? {}) as { acc?: unknown; gyro?: unknown };
    const accIndex = indexFromRange(CORE_ACC_RANGES, range.acc);
    const gyroIndex = indexFromRange(CORE_GYRO_RANGES, range.gyro);
    if (accIndex !== null) this.device_information.range.acc = accIndex;
    if (gyroIndex !== null) this.device_information.range.gyro = gyroIndex;

    await transport.write('DEVICE_INFORMATION', encodeCoreDeviceInformation(this.device_information));

    // CORE 2 はデバイス情報の書込反映に時間がかかることがある
    const settleMs = this.defaults.settleMs ?? 500;
    if (settleMs > 0) await new Promise(resolve => setTimeout(resolve, settleMs));

    await syncDeviceTime(transport, { samples: this.defaults.timeSyncSamples ?? 3 });

    if (type === 'STEP_ANALYSIS') {
      await transport.startNotify('STEP_ANALYSIS', options);
      return 'done begin(); STEP ANALYSIS';
    }
    if (type === 'SENSOR_VALUES') {
      await transport.startNotify('SENSOR_VALUES', options);
      return 'done begin(); SENSOR VALUES';
    }
    await transport.startNotify('STEP_ANALYSIS', options);
    await transport.startNotify('SENSOR_VALUES', options);
    return 'done begin(); STEP_ANALYSIS and SENSOR VALUES';
  }

  parse(uuid: string, data: DataView): CoreSensorSample[] | null {
    if (uuid === 'SENSOR_VALUES') {
      if (this.defaults.acceptExtendedSensorValues && data.byteLength === 104 && data.getUint8(0) === 50) {
        data = new DataView(data.buffer, data.byteOffset, 92);
      }
      const samples: CoreSensorSample[] = [];
      // header 50 は長さ検査より先に serial を追跡する（長さ不正でも lost_data は発火する）
      if (data.byteLength >= 3 && data.getUint8(0) === 50) {
        const loss = this.checkSerialGap(data.getUint16(1));
        if (loss) samples.push({ lost_data: loss });
      }
      const parsed = parseCoreSensorValues(data, { ...this.sensorParseOptions(), previousQuat: this.lastQuat });
      if (parsed) {
        samples.push(...parsed);
        this.rememberQuat(parsed[parsed.length - 1]?.quat);
      }
      return samples.length > 0 ? samples : null;
    }
    if (uuid === 'STEP_ANALYSIS') {
      return this.parseStepAnalysis(data);
    }
    return null;
  }

  private checkSerialGap(current: number): LostDataInfo | null {
    const prev = this.serialNumber;
    this.serialNumber = current;
    if (prev === null) return null;
    return (current - prev + 65536) % 65536 === 1 ? null : { serial: current, prev };
  }

  /**
   * 取得済みレンジ設定 index → パーサーのフルスケール値（未取得は 16G/2000dps）。
   *
   * @internal
   */
  sensorParseOptions(): CoreParseOptions {
    const range = this.device_information?.range;
    return {
      accRange: rangeFromSetting(CORE_ACC_RANGES, range?.acc, 16),
      gyroRange: rangeFromSetting(CORE_GYRO_RANGES, range?.gyro, 2000),
    };
  }

  private rememberQuat(quat: Quat | undefined): void {
    if (quat) this.lastQuat = { w: quat.w, x: quat.x, y: quat.y, z: quat.z };
  }

  private parseStepAnalysis(data: DataView): CoreSensorSample[] | null {
    const packet = decodeCoreStepAnalysis(data);
    if (!packet) return null;
    const { subheader, steps } = packet;
    const sample: CoreSensorSample = {};

    // フィールドの挿入順 = 配送順（emitter は宣言順に配送する）
    if (subheader >= 0 && subheader <= 2 && steps > this.stepsNumber) {
      sample.steps_number = { value: steps };
      this.stepsNumber = steps;
    }

    if (subheader === 0 && packet.gait && steps > this.gaitSteps) {
      this.gaitSteps = steps;
      const gait: CoreGaitPayload = { ...packet.gait, steps };
      sample.gait = gait;
      sample.type = { value: gait.type };
      sample.distance = { value: gait.distance };
      sample.direction = { value: gait.direction };
      sample.calorie = { value: gait.calorie };
      sample.standing_phase_duration = { value: gait.standing_phase_duration };
      sample.swing_phase_duration = { value: gait.swing_phase_duration };
    } else if (subheader === 1 && packet.stride && steps > this.strideSteps) {
      this.strideSteps = steps;
      sample.foot_angle = { value: packet.stride.foot_angle };
      sample.stride = { x: packet.stride.x, y: packet.stride.y, z: packet.stride.z, steps_number: steps };
    } else if (subheader === 2 && packet.pronation && steps > this.pronationSteps) {
      this.pronationSteps = steps;
      sample.pronation = { x: packet.pronation.x, y: packet.pronation.y, z: packet.pronation.z };
      sample.landing_impact = { value: packet.pronation.landing_impact };
    } else if (subheader === 4 && packet.quat && packet.delta) {
      sample.quat = packet.quat;
      sample.delta = packet.delta;
      this.rememberQuat(packet.quat);
      // sub 4 の euler は意図的に正規化なしの quat から計算する
      sample.euler = quatToEuler(packet.quat);
    }

    return Object.keys(sample).length > 0 ? [sample] : null;
  }
}

function normalizeNotificationType(type: string): string {
  if (type === 'RAW') {
    console.warn('RAW is deprecated. Please use SENSOR_VALUES instead.');
    return 'SENSOR_VALUES';
  }
  if (type === 'ANALYSIS') {
    console.warn('ANALYSIS is deprecated. Please use STEP_ANALYSIS instead.');
    return 'STEP_ANALYSIS';
  }
  if (type === 'ANALYSIS_AND_RAW') {
    console.warn('ANALYSIS_AND_RAW is deprecated. Please use STEP_ANALYSIS_AND_SENSOR_VALUES instead.');
    return 'STEP_ANALYSIS_AND_SENSOR_VALUES';
  }
  if (!(CORE_NOTIFICATION_TYPES as readonly string[]).includes(type)) {
    // 未知タイプは fail fast
    throw new TransportError('INVALID_MODE', `Invalid ORPHE CORE notification type: ${type}. Use ${CORE_NOTIFICATION_TYPES.join(' | ')}.`);
  }
  return type;
}

/** ORPHE CORE 用の DeviceProfile を生成する */
export function coreProfile(options: CoreProfileOptions = {}): CoreProfile {
  return new CoreProfile(options);
}
