/**
 * AutoProfile — 接続したデバイスの名前から CORE / INSOLE を判別して振る舞うプロファイル。
 *
 *   const ble = new OrpheCoreInsole({ profile: autoProfile() });
 *   await ble.begin(); // CORE なら STEP_ANALYSIS、INSOLE なら SENSOR_VALUES で開始
 *
 * chooser には両デバイスを出し、選ばれたデバイス名で中身のプロファイルを決める
 * （{@link detectDeviceKind}）。判別後の接続シーケンス・パース・取得モードは
 * CoreProfile / InsoleProfile にそのまま委譲する。
 */
import type { BleRequestDeviceOptions } from '../ble/web-bluetooth.ts';
import type { BeginContext, DeviceMode, DeviceProfile } from '../device/profile.ts';
import type { PressureCalibration } from '../protocol/pressure-calibration.ts';
import { orpheCharacteristics } from '../protocol/uuids.ts';
import type { CharacteristicId } from '../protocol/uuids.ts';
import { CoreProfile } from './core.ts';
import type { CoreDeviceInformation, CoreProfileOptions, CoreSensorFields } from './core.ts';
import { InsoleProfile } from './insole.ts';
import type { InsoleDeviceInformation, InsoleProfileOptions, InsoleSensorFields } from './insole.ts';

/** 判別結果のデバイス種別 */
export type DeviceKind = 'core' | 'insole';

/** INSOLE のデバイス名の接頭辞（advertise 名は `INS...`） */
const INSOLE_NAME_PREFIX = 'INS';

/**
 * デバイス名から種別を判別する。`INS` で始まれば INSOLE、それ以外（名前が取れない場合を含む）は CORE。
 * chooser は ORPHE の service UUID か `INS` の名前でしか候補を出さないため、INSOLE 以外は CORE とみなせる。
 */
export function detectDeviceKind(name: string | null | undefined): DeviceKind {
  return name?.startsWith(INSOLE_NAME_PREFIX) ? 'insole' : 'core';
}

/** CORE と INSOLE のフィールドを合わせたもの。同名フィールドのペイロードは両方の型の union */
export type AutoSensorFields = {
  [K in keyof CoreSensorFields | keyof InsoleSensorFields]:
    | (K extends keyof CoreSensorFields ? CoreSensorFields[K] : never)
    | (K extends keyof InsoleSensorFields ? InsoleSensorFields[K] : never);
};

/** autoProfile() のオプション。判別後に使うプロファイルへそのまま渡す */
export interface AutoProfileOptions {
  /** CORE と判別したときの coreProfile() オプション */
  core?: CoreProfileOptions;
  /** INSOLE と判別したときの insoleProfile() オプション */
  insole?: InsoleProfileOptions;
}

/** 重複を除いて連結する（filters のようなオブジェクトは JSON で比較する） */
function unique<T>(items: T[]): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = JSON.stringify(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export class AutoProfile implements DeviceProfile<AutoSensorFields> {
  /** CORE と判別したときに使うプロファイル */
  readonly core: CoreProfile;
  /** INSOLE と判別したときに使うプロファイル */
  readonly insole: InsoleProfile;

  private resolved: CoreProfile | InsoleProfile | null = null;

  constructor(options: AutoProfileOptions = {}) {
    this.core = new CoreProfile(options.core);
    this.insole = new InsoleProfile(options.insole);
  }

  /** 判別済みのプロファイル。接続前は null */
  get current(): CoreProfile | InsoleProfile | null {
    return this.resolved;
  }

  /** 判別済みなら 'core' / 'insole'、接続前は 'auto' */
  get kind(): string {
    return this.resolved?.kind ?? 'auto';
  }

  /** 判別後のプロファイルの既定 type。接続前は CORE の既定を返す */
  get defaultNotificationType(): string {
    return (this.resolved ?? this.core).defaultNotificationType;
  }

  /** 判別後のプロファイルが begin() で取得したデバイス設定 */
  get device_information(): CoreDeviceInformation | InsoleDeviceInformation | null {
    return this.resolved?.device_information ?? null;
  }

  /** INSOLE の現在ストリーミングモード（FIFO の復帰先）。CORE・接続前は null */
  get streaming_mode(): number | null {
    return this.resolved === this.insole ? this.insole.streaming_mode : null;
  }

  /** FifoRecorder が停止時に復帰先を書き戻す。INSOLE のときだけ反映する */
  set streaming_mode(mode: number | null) {
    if (this.resolved === this.insole) this.insole.streaming_mode = mode;
  }

  /** INSOLE の個体別圧力校正係数。CORE・接続前は null */
  get pressure_calibrations(): (PressureCalibration | null)[] | null {
    return this.resolved === this.insole ? this.insole.pressure_calibrations : null;
  }

  storageKey(id: number): string {
    return `orphe_core_insole_last_bluetooth_device_${id}`;
  }

  requestDeviceOptions(): BleRequestDeviceOptions {
    const insole = this.insole.requestDeviceOptions();
    const core = this.core.requestDeviceOptions();
    return {
      filters: unique([...(insole.filters ?? []), ...(core.filters ?? [])]),
      acceptAllDevices: false,
      optionalServices: unique([...(insole.optionalServices ?? []), ...(core.optionalServices ?? [])]),
      optionalManufacturerData: unique([
        ...(insole.optionalManufacturerData ?? []),
        ...(core.optionalManufacturerData ?? []),
      ]),
    };
  }

  characteristics(): Record<string, CharacteristicId> {
    return orpheCharacteristics();
  }

  /** 選ばれたデバイスの名前でプロファイルを決める（begin() の中で接続シーケンスより先に呼ばれる） */
  resolveDevice(name: string | null, log?: (message: string, detail?: unknown) => void): void {
    const kind = detectDeviceKind(name);
    this.resolved = kind === 'insole' ? this.insole : this.core;
    log?.('autoProfile: デバイス種別を判別', { name, kind });
  }

  modes(): DeviceMode[] {
    return this.resolved ? this.resolved.modes() : [];
  }

  begin(context: BeginContext): Promise<unknown> {
    return this.requireResolved().begin(context);
  }

  parse(uuid: string, data: DataView): Array<Partial<AutoSensorFields>> | null {
    return this.resolved ? this.resolved.parse(uuid, data) : null;
  }

  private requireResolved(): CoreProfile | InsoleProfile {
    if (!this.resolved) throw new Error('autoProfile: デバイスが未選択のため CORE / INSOLE を判別できない');
    return this.resolved;
  }
}

/** 接続したデバイスの名前で CORE / INSOLE を切り替えるプロファイルを作る */
export function autoProfile(options: AutoProfileOptions = {}): AutoProfile {
  return new AutoProfile(options);
}
