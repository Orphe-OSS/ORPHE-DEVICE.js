/**
 * InsoleProfile — ORPHE INSOLE の DeviceProfile 実装。
 *
 * gyro の物理値換算は raw int16 × レンジ別代表感度（LSM6DSOX:
 * ±250/500/1000/2000 dps で 8.75/17.5/35/70 mdps/LSB）であり、
 * 理想 Q15（raw/32768*range）ではないことに注意（約12.8%の差になる）。
 */
import type { BleRequestDeviceOptions } from '../ble/web-bluetooth.ts';
import type { GattIo } from '../ble/types.ts';
import type { CharacteristicId } from '../protocol/uuids.ts';
import { TransportError } from '../ble/errors.ts';
import type { BeginContext, DeviceMode, DeviceProfile, LostDataInfo } from '../device/profile.ts';
import type { Quat, Vec3 } from '../protocol/geometry.ts';
import { ORPHE_UUID, orpheCharacteristics } from '../protocol/uuids.ts';
import {
  INSOLE_MODES,
  INSOLE_PRESSURE_CALIBRATION_MIN_RELEASE_DATE,
  INSOLE_STREAMING_MODES,
} from '../modes/insole.ts';
import {
  PRESSURE_SENSOR_COUNT,
  decodePressureCalibration,
  encodePressureCalibrationRequest,
  isPressureCalibrationPacket,
  isPressureCalibrationPlaceholder,
  pressureToNewton,
} from '../protocol/pressure-calibration.ts';
import type { PressureCalibration } from '../protocol/pressure-calibration.ts';
import type { FirmwareInfo } from '../protocol/fw-info.ts';
import type { OperationOptions } from '../ble/types.ts';
import { syncDeviceTime } from '../device/time-sync.ts';
import { normalizeQuaternionInsoleStyle, quatToEuler } from '../protocol/geometry.ts';
import type { EulerAngles } from '../protocol/geometry.ts';

// DEVICE_INFORMATION のレンジ設定 index（0..3）→ 物理フルスケール値
/** 加速度レンジ設定 index（0..3）→ 物理フルスケール値 [G] */
export const INSOLE_ACC_RANGES = Object.freeze([2, 4, 8, 16] as const);
/** ジャイロレンジ設定 index（0..3）→ 物理フルスケール値 [dps] */
export const INSOLE_GYRO_RANGES = Object.freeze([250, 500, 1000, 2000] as const);
/** フルスケール 1 dps あたりの感度 [dps/LSB]（例: ±2000dps → 0.07） */
export const INSOLE_GYRO_DPS_PER_LSB_PER_RANGE = 0.000035;

/**
 * ORPHE INSOLE 用の chooser フィルタ。
 * 一部の INSOLE firmware は advertisement に service UUID を載せないため、
 * chooser では INS の namePrefix で候補を絞り、optionalServices で
 * 接続後に必要な service へアクセスする。service UUID を advertise する
 * FW は名前に依らず出せるよう OR フィルタも併記する。
 * 'device_information' は標準 BLE DIS (0x180A)。FW が実装している場合に
 * Firmware Revision の読み出しに使う。
 */
export function insoleRequestDeviceOptions(): BleRequestDeviceOptions {
  return {
    filters: [
      { namePrefix: 'INS' },
      { services: [ORPHE_UUID.INFORMATION_SERVICE] },
    ],
    acceptAllDevices: false,
    optionalServices: [
      ORPHE_UUID.INFORMATION_SERVICE,
      ORPHE_UUID.OTHER_SERVICE,
      'device_information',
    ],
    optionalManufacturerData: [0x0000],
  };
}

/** {@link parseInsoleSensorValues} のパースオプション。 */
export interface InsoleParseOptions {
  /** 加速度のフルスケール [G]。既定 16 */
  accRange?: number;
  /** ジャイロのフルスケール [dps]。既定 2000 */
  gyroRange?: number;
  /** テスト用注入点: パケット基準時刻の「今日」を決める現在時刻 */
  now?: () => Date;
}

/** サンプル内の各ベクトル値に付くメタ情報 */
export interface InsoleSampleStamp {
  /** サンプル時刻（epoch ms。パケット内時刻を当日の日付に展開したもの） */
  timestamp: number;
  /** パケットの通し番号（uint16。lost_data 検出に使う） */
  serial_number: number;
  /** パケット内のフレーム番号（0..3） */
  packet_number: number;
}

/** スタンプ付き3軸ベクトル */
export interface InsoleStampedVec3 extends Vec3, InsoleSampleStamp {}
/** スタンプ付きクォータニオン */
export interface InsoleStampedQuat extends Quat, InsoleSampleStamp {}

export interface InsolePress extends InsoleSampleStamp {
  /** 6ch 圧力の ADC 生値 (uint16) */
  values: number[];
}

/**
 * フィールド名 → ペイロード型のマップ。
 * OrpheCoreInsole.on() のイベントキー補完とリスナー引数の型付けに使われる。
 */
export interface InsoleSensorFields {
  /** サンプル時刻（epoch ms） */
  timestamp: number;
  /** パケット通し番号（uint16） */
  serial_number: number;
  /** パケット内フレーム番号（0..3） */
  packet_number: number;
  /** クォータニオン Q14（mode 1/4 のみ） */
  quat: InsoleStampedQuat;
  /** 角速度（-1..1 の正規化値） */
  gyro: InsoleStampedVec3;
  /** 加速度（-1..1 の正規化値） */
  acc: InsoleStampedVec3;
  /** 6ch 圧力（mode 3/4 のみ） */
  press: InsolePress;
  /**
   * 6ch 圧力 [N]（mode 3/4 のみ）。
   * 対応 FW なら begin() で取得した個体別係数、それ以外は固定式で換算する。
   */
  converted_press: InsolePress;
  /** 角速度 [dps]（レンジ別センサー感度で換算） */
  converted_gyro: InsoleStampedVec3;
  /** 加速度 [G]（gyro と同様にレンジ換算） */
  converted_acc: InsoleStampedVec3;
  /** 正規化済み quat から計算した Euler 角（gotEuler 相当。mode 1/4 のみ） */
  euler: EulerAngles;
  /** BLE 実測周波数 [Hz]（gotBLEFrequency 相当。facade が配送する） */
  ble_frequency: number;
  /** serial 欠損・重複（lostData 相当。modular 差分） */
  lost_data: LostDataInfo;
}

/**
 * parseInsoleSensorValues が返すパケット内の 1 サンプル（配送前の中間形）。
 * streaming mode により quat / press は欠ける
 */
export interface InsoleParsedSample extends InsoleSampleStamp {
  /** 姿勢クォータニオン（モード 1 / 4） */
  quat?: InsoleStampedQuat;
  /** ジャイロの生値 */
  gyro?: InsoleStampedVec3;
  /** 加速度の生値 */
  acc?: InsoleStampedVec3;
  /** 6ch 圧力（モード 3 / 4） */
  press?: InsolePress;
  /** ジャイロの物理値 [dps] */
  converted_gyro?: InsoleStampedVec3;
  /** 加速度の物理値 [G] */
  converted_acc?: InsoleStampedVec3;
}

/** parse() が返し emitter へ配送されるサンプル（フィールド順は固定。toDispatchSample 参照） */
export type InsoleSensorSample = Partial<InsoleSensorFields>;

/** 104 バイトパケットのデコード結果（4 フレーム） */
export interface InsoleSensorPacket {
  /** パケットヘッダー（streaming mode に対応） */
  header: number;
  /** パケット通し番号（uint16） */
  serial_number: number;
  /** パケット基準時刻（epoch ms） */
  timestamp: number;
  /** フレーム列（古い順） */
  samples: InsoleParsedSample[];
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
 * ORPHE INSOLE SENSOR_VALUES packet parser。
 * - header 50 (0x32): quat+gyro+acc ×4（mode 1）
 * - header 55 (0x37): gyro+acc+press ×4（mode 3）
 * - header 54 (0x36): FIFO データパケット（55 と同一レイアウト）
 * - header 56 (0x38): quat+gyro+acc+press ×2（mode 4）
 * 104 バイト以外は null。未知ヘッダは空サンプルでヘッダ情報のみ返す。
 */
export function parseInsoleSensorValues(data: DataView, options: InsoleParseOptions = {}): InsoleSensorPacket | null {
  if (!data || typeof data.getUint8 !== 'function') {
    throw new TypeError('parseInsoleSensorValues expects a DataView');
  }
  if (data.byteLength !== 104) return null;

  const header = data.getUint8(0);
  const serial_number = data.getUint16(1);
  const gyroRange = Number.isFinite(Number(options.gyroRange)) ? Number(options.gyroRange) : 2000;
  const accRange = Number.isFinite(Number(options.accRange)) ? Number(options.accRange) : 16;
  // deg/s per LSB（例: ±2000 dps → 0.07）。正規化値ではなく raw int16 に掛ける。
  const gyroDpsPerLsb = gyroRange * INSOLE_GYRO_DPS_PER_LSB_PER_RANGE;
  const now = options.now ? options.now() : new Date();
  const t_start = timestampToday(now, data.getUint8(3), data.getUint8(4), data.getUint8(5), data.getUint16(6));
  const samples: InsoleParsedSample[] = [];
  // quaternion は signed Q14（1.0 = 16384）。acc/gyro の正規化値は
  // raw int16 / 32768。gyro の物理値だけレンジ別感度で換算する。
  const quatScale = 16384;

  function vector3(x: number, y: number, z: number, timestamp: number, packet_number: number): InsoleStampedVec3 {
    return {
      x: data.getInt16(x) / 32768,
      y: data.getInt16(y) / 32768,
      z: data.getInt16(z) / 32768,
      timestamp,
      serial_number,
      packet_number,
    };
  }

  function quat(w: number, x: number, y: number, z: number, timestamp: number, packet_number: number): InsoleStampedQuat {
    return {
      w: data.getInt16(w) / quatScale,
      x: data.getInt16(x) / quatScale,
      y: data.getInt16(y) / quatScale,
      z: data.getInt16(z) / quatScale,
      timestamp,
      serial_number,
      packet_number,
    };
  }

  function withConverted(sample: InsoleParsedSample): InsoleParsedSample {
    const gyro = sample.gyro;
    if (gyro) {
      // gyro.* は raw int16 / 32768。×32768 で raw に戻してから感度を掛ける。
      sample.converted_gyro = {
        x: gyro.x * 32768 * gyroDpsPerLsb,
        y: gyro.y * 32768 * gyroDpsPerLsb,
        z: gyro.z * 32768 * gyroDpsPerLsb,
        timestamp: gyro.timestamp,
        serial_number,
        packet_number: gyro.packet_number,
      };
    }
    const acc = sample.acc;
    if (acc) {
      sample.converted_acc = {
        x: acc.x * accRange,
        y: acc.y * accRange,
        z: acc.z * accRange,
        timestamp: acc.timestamp,
        serial_number,
        packet_number: acc.packet_number,
      };
    }
    return sample;
  }

  if (header === 50) {
    let timestamp = t_start;
    for (let i = 3; i >= 0; i--) {
      if (i !== 3) timestamp += data.getUint8(28 + 21 * i);
      samples.push(withConverted({
        timestamp,
        serial_number,
        packet_number: 3 - i,
        quat: quat(8 + 21 * i, 10 + 21 * i, 12 + 21 * i, 14 + 21 * i, timestamp, 3 - i),
        gyro: vector3(16 + 21 * i, 18 + 21 * i, 20 + 21 * i, timestamp, 3 - i),
        acc: vector3(22 + 21 * i, 24 + 21 * i, 26 + 21 * i, timestamp, 3 - i),
      }));
    }
  } else if (header === 55 || header === 54) {
    const offset = 24;
    for (let i = 3; i >= 0; i--) {
      const timestamp = t_start;
      const packet_number = 3 - i;
      samples.push(withConverted({
        timestamp,
        serial_number,
        packet_number,
        gyro: vector3(8 + offset * i, 10 + offset * i, 12 + offset * i, timestamp, packet_number),
        acc: vector3(14 + offset * i, 16 + offset * i, 18 + offset * i, timestamp, packet_number),
        press: {
          values: [
            data.getUint16(20 + offset * i),
            data.getUint16(22 + offset * i),
            data.getUint16(24 + offset * i),
            data.getUint16(26 + offset * i),
            data.getUint16(28 + offset * i),
            data.getUint16(30 + offset * i),
          ],
          timestamp,
          serial_number,
          packet_number,
        },
      }));
    }
  } else if (header === 56) {
    const offset = 32;
    for (let i = 1; i >= 0; i--) {
      const timestamp = t_start;
      const packet_number = 1 - i;
      samples.push(withConverted({
        timestamp,
        serial_number,
        packet_number,
        quat: quat(8 + offset * i, 10 + offset * i, 12 + offset * i, 14 + offset * i, timestamp, packet_number),
        gyro: vector3(16 + offset * i, 18 + offset * i, 20 + offset * i, timestamp, packet_number),
        acc: vector3(22 + offset * i, 24 + offset * i, 26 + offset * i, timestamp, packet_number),
        press: {
          values: [
            data.getUint16(28 + offset * i),
            data.getUint16(30 + offset * i),
            data.getUint16(32 + offset * i),
            data.getUint16(34 + offset * i),
            data.getUint16(36 + offset * i),
            data.getUint16(38 + offset * i),
          ],
          timestamp,
          serial_number,
          packet_number,
        },
      }));
    }
  } else {
    return { header, serial_number, timestamp: t_start, samples: [] };
  }

  return { header, serial_number, timestamp: t_start, samples };
}

/** DEVICE_INFORMATION の read 結果（デバイス設定） */
export interface InsoleDeviceInformation {
  /** バッテリー残量（少ない:0、普通:1、多い:2） */
  battery: number;
  /** 取り付け位置 bit0: 0=LEFT/1=RIGHT, bit1: 0=足底/1=足背 */
  mount_position: number;
  /** レンジ設定 index（acc: 0..3 → ±2/4/8/16G, gyro: 0..3 → ±250/500/1000/2000dps） */
  range: {
    /** 加速度レンジの index */ acc: number;
    /** ジャイロレンジの index */ gyro: number;
  };
  /** read した生ペイロード（未定義バイトの参照用） */
  raw: DataView;
}

/** DEVICE_INFORMATION の read ペイロードをデコードする */
export function decodeInsoleDeviceInformation(data: DataView): InsoleDeviceInformation {
  return {
    battery: data.getUint8(0),
    mount_position: data.getUint8(1),
    range: {
      acc: data.getUint8(8),
      gyro: data.getUint8(9),
    },
    raw: data,
  };
}

// setting は getUint8 由来の整数のみ受け付ける（範囲外・非整数は fallback）
function rangeFromSetting(ranges: readonly number[], setting: unknown, fallback: number): number {
  return typeof setting === 'number' && Number.isInteger(setting) && setting >= 0 && setting < ranges.length
    ? ranges[setting]!
    : fallback;
}

/** 係数取得の間に使う配信モード（圧力を含むモードでないと FW が応答しない） */
const PRESSURE_CALIBRATION_FETCH_MODE = 4;

type BeginLog = NonNullable<BeginContext['log']>;

/** insoleProfile() のオプション */
export interface InsoleProfileOptions {
  /** begin() の streamingMode 省略時の既定。既定 4 */
  streamingMode?: number;
  /** 時刻同期の計測回数。既定 3 */
  timeSyncSamples?: number;
  /** 個体別圧力校正係数の取得設定 */
  pressureCalibration?: {
    /** 対応 FW で begin() 時に取得するか。既定 true */
    fetch?: boolean;
    /** 1ch あたりの応答待ち [ms]。既定 1000 */
    timeoutMs?: number;
    /** 1ch あたりの試行回数。既定 3 */
    retries?: number;
  };
}

export class InsoleProfile implements DeviceProfile<InsoleSensorFields> {
  readonly kind = 'insole';
  readonly defaultNotificationType = 'SENSOR_VALUES';

  /** begin() で取得したデバイス設定。parse() の換算レンジに使う */
  device_information: InsoleDeviceInformation | null = null;
  /** 最後に設定した streaming mode */
  streaming_mode: number | null = null;
  /**
   * begin() で取得した個体別圧力校正係数（index = センサー番号 0..5）。
   * 旧 FW・未取得は null。FW に値が書かれていない ch はプレースホルダとして null になり、
   * その ch だけ固定式で換算する。
   */
  pressure_calibrations: (PressureCalibration | null)[] | null = null;
  /** 校正係数の応答待ち（センサー番号 → resolve） */
  private readonly pendingCalibration = new Map<number, (calibration: PressureCalibration) => void>();

  private readonly defaults: InsoleProfileOptions;
  // serial 追跡（modular 差分・初期化フラグ方式）
  private serialInitialized = false;
  private serialNumber = 0;

  constructor(options: InsoleProfileOptions = {}) {
    this.defaults = options;
  }

  storageKey(id: number): string {
    // 利用者の記憶デバイスを引き継ぐため、このキー文字列は変更しないこと
    return `orphe_insole_last_bluetooth_device_${id}`;
  }

  requestDeviceOptions(): BleRequestDeviceOptions {
    return insoleRequestDeviceOptions();
  }

  characteristics(): Record<string, CharacteristicId> {
    return orpheCharacteristics();
  }

  modes(): DeviceMode[] {
    return INSOLE_MODES.map(mode => ({ ...mode }));
  }

  async begin(context: BeginContext): Promise<string> {
    const { transport, options } = context;
    const mode = Number(options.streamingMode ?? options.dataStreamingMode ?? this.defaults.streamingMode ?? 4);
    // デバイスに触る前に検証する（不正 mode で chooser を開かない）
    if (!Number.isInteger(mode) || !INSOLE_STREAMING_MODES[mode]) {
      throw new TransportError('INVALID_MODE', `Invalid ORPHE INSOLE data streaming mode: ${mode}. Use 1, 3, or 4.`);
    }

    const infoData = await transport.read('DEVICE_INFORMATION', options);
    this.device_information = decodeInsoleDeviceInformation(infoData);

    // 取得は毎回行う（切断後に別デバイスへ繋ぎ替えても古い係数を使わない）
    this.pressure_calibrations = null;
    const log = context.log ?? (() => {});
    if (this.shouldFetchPressureCalibration(context.firmware, log)) {
      // FW は圧力を含む配信モードのときだけ応答し、応答は SENSOR_VALUES の notify で届く。
      // 要求モードが圧力を含まなければ、取得の間だけ全センサーのモードにする
      const fetchMode = INSOLE_STREAMING_MODES[mode]!.fields.press ? mode : PRESSURE_CALIBRATION_FETCH_MODE;
      await this.setDataStreamingMode(transport, fetchMode);
      await transport.startNotify('SENSOR_VALUES', options);
      this.pressure_calibrations = await this.fetchPressureCalibrations(transport, options, log);
      if (fetchMode !== mode) await this.setDataStreamingMode(transport, mode);
      await syncDeviceTime(transport, { samples: this.defaults.timeSyncSamples ?? 3 });
      return 'done begin(); SENSOR VALUES';
    }

    await this.setDataStreamingMode(transport, mode);
    await syncDeviceTime(transport, { samples: this.defaults.timeSyncSamples ?? 3 });
    await transport.startNotify('SENSOR_VALUES', options);
    return 'done begin(); SENSOR VALUES';
  }

  /** 校正係数の取得設定（オプション省略時は既定値で埋めたもの） */
  pressureCalibrationSettings(): Required<NonNullable<InsoleProfileOptions['pressureCalibration']>> {
    const settings = this.defaults.pressureCalibration ?? {};
    return {
      fetch: settings.fetch ?? true,
      timeoutMs: settings.timeoutMs ?? 1000,
      retries: settings.retries ?? 3,
    };
  }

  /**
   * 対応 FW（リリース日がしきい値以上）かつ取得が有効なら true。FW 不明は旧 FW 扱い。
   * 取得しない理由はここでログに出す
   */
  private shouldFetchPressureCalibration(firmware: FirmwareInfo | null, log: BeginLog): boolean {
    if (!this.pressureCalibrationSettings().fetch) {
      log('圧力校正: 取得無効（pressureCalibration.fetch = false）。固定式で換算');
      return false;
    }
    if (!firmware) {
      log('圧力校正: FW 不明のため取得しません。固定式で換算');
      return false;
    }
    const threshold = INSOLE_PRESSURE_CALIBRATION_MIN_RELEASE_DATE;
    if (firmware.releaseDate < threshold) {
      log(`圧力校正: 非対応 FW（リリース日 ${firmware.releaseDate} < ${threshold}）。固定式で換算`);
      return false;
    }
    log(`圧力校正: 対応 FW（リリース日 ${firmware.releaseDate}）。係数を取得します`);
    return true;
  }

  /**
   * 6ch ぶんの校正係数を 1ch ずつ取得し、ch ごとの結果と集計をログに出す。
   * 無応答は試行回数まで再送し、使い切った ch は固定式で換算する（begin() は止めない）。
   * FW に値が書かれていない ch（プレースホルダ）も固定式にする。
   */
  private async fetchPressureCalibrations(
    transport: GattIo,
    options: OperationOptions,
    log: BeginLog
  ): Promise<(PressureCalibration | null)[]> {
    const { timeoutMs, retries } = this.pressureCalibrationSettings();
    const result: (PressureCalibration | null)[] = [];
    let calibrated = 0;
    let placeholder = 0;
    let missing = 0;
    for (let sensorIndex = 0; sensorIndex < PRESSURE_SENSOR_COUNT; sensorIndex++) {
      let received: PressureCalibration | null = null;
      for (let attempt = 0; attempt < retries && !received; attempt++) {
        received = await this.requestPressureCalibration(transport, sensorIndex, timeoutMs, options);
      }
      if (!received) {
        missing++;
        log(`圧力校正 ch${sensorIndex}: 応答なし（${retries} 回）。固定式で換算`);
        result.push(null);
      } else if (isPressureCalibrationPlaceholder(received)) {
        placeholder++;
        log(`圧力校正 ch${sensorIndex}: 未書込（func 0・係数すべて 1.0）。固定式で換算`, received);
        result.push(null);
      } else {
        calibrated++;
        log(`圧力校正 ch${sensorIndex}: 個体別係数`, received);
        result.push(received);
      }
    }
    log(`圧力校正: 個体別係数 ${calibrated}ch / 未書込 ${placeholder}ch / 応答なし ${missing}ch`);
    return result;
  }

  /** 1ch の校正係数を要求し、応答か timeout まで待つ。無応答は null */
  private async requestPressureCalibration(
    transport: GattIo,
    sensorIndex: number,
    timeoutMs: number,
    options: OperationOptions
  ): Promise<PressureCalibration | null> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let resolveWaiter: ((calibration: PressureCalibration) => void) | undefined;
    // 応答は parse() 側で拾って resolve する。要求を書く前に待ち受けを登録する
    const waiter = new Promise<PressureCalibration | null>(resolve => {
      resolveWaiter = resolve;
      this.pendingCalibration.set(sensorIndex, resolve);
      timer = setTimeout(() => {
        if (this.pendingCalibration.get(sensorIndex) === resolve) this.pendingCalibration.delete(sensorIndex);
        resolve(null);
      }, timeoutMs);
    });
    try {
      await transport.write('DEVICE_INFORMATION', encodePressureCalibrationRequest(sensorIndex), options);
    } catch {
      if (this.pendingCalibration.get(sensorIndex) === resolveWaiter) this.pendingCalibration.delete(sensorIndex);
      clearTimeout(timer);
      return null;
    }
    const calibration = await waiter;
    clearTimeout(timer);
    return calibration;
  }

  /** SENSOR_VALUES に混ざって届く校正係数の応答を待ち受けへ渡す */
  private receivePressureCalibration(data: DataView): void {
    const decoded = decodePressureCalibration(data);
    if (!decoded) return;
    const resolve = this.pendingCalibration.get(decoded.sensorIndex);
    if (!resolve) return;
    this.pendingCalibration.delete(decoded.sensorIndex);
    resolve(decoded.calibration);
  }

  /** press（ADC 生値）を N に換算した InsolePress を作る */
  private toConvertedPress(press: InsolePress): InsolePress {
    const calibrations = this.pressure_calibrations;
    return {
      ...press,
      values: press.values.map((raw, i) => pressureToNewton(raw, calibrations ? calibrations[i] : null)),
    };
  }

  /** streaming mode（1/3/4）を書き込む。接続中の切替にも使える */
  async setDataStreamingMode(transport: GattIo, mode: number): Promise<void> {
    const normalizedMode = Number(mode);
    if (!Number.isInteger(normalizedMode) || !INSOLE_STREAMING_MODES[normalizedMode]) {
      throw new TransportError('INVALID_MODE', `Invalid ORPHE INSOLE data streaming mode: ${mode}. Use 1, 3, or 4.`);
    }
    await transport.write('DEVICE_INFORMATION', Uint8Array.from([0x0d, normalizedMode]));
    this.streaming_mode = normalizedMode;
  }

  parse(uuid: string, data: DataView): InsoleSensorSample[] | null {
    if (uuid !== 'SENSOR_VALUES') return null;
    // 校正係数の応答はセンサーサンプルではない（serial 追跡にも載せない）
    if (isPressureCalibrationPacket(data)) {
      this.receivePressureCalibration(data);
      return null;
    }
    const packet = parseInsoleSensorValues(data, this.sensorParseOptions());
    if (!packet) return null; // 104 バイト以外

    const out: InsoleSensorSample[] = [];
    // serial gap は未知ヘッダ含めパース成功後に必ず確認し、
    // サンプル配送より先に通知する
    const loss = this.checkSerialGap(packet.serial_number);
    if (loss) out.push({ lost_data: loss });

    // header 54（FIFO データパケット）は FIFO 収集側が生データを直接消費する
    // 前提のため、フィールド配送しない
    if (packet.header !== 54) {
      for (const sample of packet.samples) {
        out.push(this.toDispatchSample(packet.header, sample));
      }
    }
    return out.length > 0 ? out : null;
  }

  /**
   * 配送順にフィールドを並べ替え、euler を挿入する。
   *   header 50: acc → quat → gyro → converted_acc → converted_gyro → euler
   *   header 55: acc → gyro → converted_acc → converted_gyro → press
   *   header 56: quat → euler → acc → gyro → converted_acc → converted_gyro → press
   * euler は正規化（INSOLE 方式）済み quat から計算する。
   */
  private toDispatchSample(header: number, sample: InsoleParsedSample): InsoleSensorSample {
    const euler = sample.quat
      ? quatToEuler(normalizeQuaternionInsoleStyle(sample.quat))
      : undefined;
    const out: InsoleSensorSample = {};
    if (header === 56) {
      out.quat = sample.quat;
      out.euler = euler;
    }
    out.acc = sample.acc;
    if (header === 50) out.quat = sample.quat;
    out.gyro = sample.gyro;
    out.converted_acc = sample.converted_acc;
    out.converted_gyro = sample.converted_gyro;
    if (header === 50) out.euler = euler;
    if (header !== 50) out.press = sample.press;
    if (header !== 50 && sample.press) out.converted_press = this.toConvertedPress(sample.press);
    out.timestamp = sample.timestamp;
    out.serial_number = sample.serial_number;
    out.packet_number = sample.packet_number;
    return out;
  }

  private checkSerialGap(current: number): LostDataInfo | null {
    if (!this.serialInitialized) {
      this.serialInitialized = true;
      this.serialNumber = current;
      return null;
    }
    const prev = this.serialNumber;
    this.serialNumber = current;
    const diff = (current - prev + 65536) % 65536;
    return diff !== 1 ? { serial: current, prev } : null;
  }

  /**
   * 取得済みレンジ設定 index → パーサーのフルスケール値（未取得は 16G/2000dps）
   *
   * @internal
   */
  sensorParseOptions(): InsoleParseOptions {
    const range = this.device_information?.range;
    return {
      accRange: rangeFromSetting(INSOLE_ACC_RANGES, range?.acc, 16),
      gyroRange: rangeFromSetting(INSOLE_GYRO_RANGES, range?.gyro, 2000),
    };
  }
}

/** ORPHE INSOLE 用の DeviceProfile を生成する */
export function insoleProfile(options: InsoleProfileOptions = {}): InsoleProfile {
  return new InsoleProfile(options);
}
