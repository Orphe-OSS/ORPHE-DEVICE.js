/**
 * INSOLE の圧力データ（`press.values` = 6ch ADC 生値）を扱うユーティリティ。
 * 検証・キャリブレーション・CoP（圧力中心）計算・接地検出を提供する。
 *
 * BLE 接続には依存しないので、記録済みデータの解析など Node 上でもそのまま使える。
 *
 * 注意: ADC 生値は物理量（体重・N）ではない。個体差・装着差があるため、
 * 物理量的な扱いが必要な場合は PressureCalibrator で 2点キャリブレーションを行うこと。
 */

/** 圧力センサのチャネル数 */
export const SENSOR_COUNT = 6;
/** ADC 生値の上限（uint16） */
export const MAX_UINT16 = 65535;

/** センサ 1 点の座標 */
export interface InsoleSensorPoint {
  x: number;
  y: number;
  label?: string;
}

/** validatePress() が返すフラグ */
export type InsolePressFlag = 'BAD_LENGTH' | 'NOT_FINITE' | 'NEGATIVE' | 'SATURATED_CH';

/** validatePress() の結果 */
export interface InsolePressValidation {
  /** フラグが 1 つもなければ true */
  ok: boolean;
  /** クランプ・補完済みの安全な 6 要素配列 */
  values: number[];
  flags: InsolePressFlag[];
  channels: {
    /** 飽和値に張り付いたチャネル番号 */
    saturated: number[];
  };
}

/** computeCoP() が返すフラグ */
export type InsoleCoPFlag = InsolePressFlag | 'BAD_LAYOUT' | 'LOAD_BELOW_THRESHOLD';

/** computeCoP() の結果 */
export interface InsoleCoP {
  x: number;
  y: number;
  /** 合計荷重（入力と同じ単位） */
  load: number;
  /** false のとき x, y は 0（使用しないこと） */
  isValid: boolean;
  flags: InsoleCoPFlag[];
}

/** ContactDetector の接地イベント */
export interface InsoleContactDownEvent {
  event: 'down';
  timestamp: number;
  /** 直前の離地からの経過時間 [ms]。初回は null */
  flightMs: number | null;
}

/** ContactDetector の離地イベント */
export interface InsoleContactUpEvent {
  event: 'up';
  timestamp: number;
  /** 直前の接地からの経過時間 [ms]。初回は null */
  stanceMs: number | null;
}

/** sideFromMountPosition() の結果 */
export interface InsoleMountInfo {
  side: 'left' | 'right';
  surface: 'plantar' | 'dorsal';
  isRight: boolean;
  isDorsal: boolean;
}

/** PressureCalibrator の保存形式 */
export interface InsolePressureCalibrationJSON {
  zero: number[];
  full: number[];
}

/** StuckChannelMonitor のオプション */
export interface StuckChannelMonitorOptions {
  /** 連続何フレーム 0 が続いたら張り付きとみなすか（既定 200 ≒ mode4 で 2 秒） */
  windowFrames?: number;
  /** 「荷重が乗っている」とみなす合計生値のしきい値（既定 1000） */
  minTotalLoad?: number;
}

/** ContactDetector のオプション */
export interface ContactDetectorOptions {
  /** 接地判定しきい値（要キャリブレーション） */
  on: number;
  /** 離地判定しきい値（on より小さくすること） */
  off: number;
  /** 接地とみなす最小継続時間 [ms]。これ未満で off を割っても離地イベントを出さない（既定 0） */
  minContactMs?: number;
  /** 離地とみなす最小継続時間 [ms]（既定 0） */
  minFlightMs?: number;
}

/**
 * 6ch 圧力センサのインソール画像上マーカー座標（0..1 の画像比率・実機採寸値）。
 * チャネルの物理配置はモデルによって異なる場合があるため、
 * 配置が異なるモデルでは同形式の配列でリマップ層を挟むこと。
 */
export const SENSOR_LAYOUT_IMAGE: InsoleSensorPoint[] = [
  { x: 0.7596, y: 0.1680, label: 'P0' },
  { x: 0.7513, y: 0.3320, label: 'P1' },
  { x: 0.4024, y: 0.2210, label: 'P2' },
  { x: 0.5245, y: 0.3483, label: 'P3' },
  { x: 0.2884, y: 0.3681, label: 'P4' },
  { x: 0.5552, y: 0.8206, label: 'P5' },
];

// 画像比率 → 足ローカル座標の変換係数
const FOOT_LOCAL_X_RANGE = 0.58;
const FOOT_LOCAL_Y_RANGE = 0.9;

/**
 * 6ch 圧力センサの足ローカル座標系レイアウト（SENSOR_LAYOUT_IMAGE から導出。右足基準）。
 * x: 内外方向 / y: 前後方向（+がつま先側）。単位は足長を約1とする無次元。
 * 左足には mirrorForSide() で左右反転したものを使う。
 */
export const SENSOR_LAYOUT: InsoleSensorPoint[] = SENSOR_LAYOUT_IMAGE.map((sensor) => ({
  x: (sensor.x - 0.5) * FOOT_LOCAL_X_RANGE,
  y: (0.5 - sensor.y) * FOOT_LOCAL_Y_RANGE,
  label: sensor.label,
}));

/**
 * レイアウトを左右反転した新しい配列を返す（元の配列・要素は変更しない）。
 * SENSOR_LAYOUT は右足基準なので、左足には mirrorForSide(SENSOR_LAYOUT, 'left') を使う。
 */
export function mirrorForSide<T extends { x: number }>(layout: readonly T[], side: 'left' | 'right'): T[] {
  const mirror = side === 'left';
  return layout.map((sensor) => Object.assign({}, sensor, { x: mirror ? -sensor.x : sensor.x }));
}

/**
 * 圧力生値の単一フレーム検証。
 * flags:
 * - BAD_LENGTH   配列でない・6ch 未満（値は 0 埋めで補完される）
 * - NOT_FINITE   NaN / Infinity / 数値化不能（0 に置換される）
 * - NEGATIVE     負値（0 にクランプされる）
 * - SATURATED_CH 飽和値（既定 65535 = uint16 上限）に張り付いたチャネルあり
 *
 * 「0 張り付き（断線疑い）」は時間履歴が必要なため StuckChannelMonitor を使うこと。
 * 元の配列は変更しない。
 */
export function validatePress(
  values: readonly number[] | null | undefined,
  options?: { saturationValue?: number } | null,
): InsolePressValidation {
  const saturationValue = (options && options.saturationValue) || MAX_UINT16;
  const flags: InsolePressFlag[] = [];
  const saturated: number[] = [];

  if (!Array.isArray(values) || values.length < SENSOR_COUNT) {
    flags.push('BAD_LENGTH');
  }
  const source: readonly unknown[] = Array.isArray(values) ? values : [];
  const sanitized: number[] = [];
  for (let i = 0; i < SENSOR_COUNT; i++) {
    const numberValue = Number(source[i]);
    if (!Number.isFinite(numberValue)) {
      // 長さ不足で欠けた分は BAD_LENGTH に集約し、NOT_FINITE は出さない
      if (i < source.length) flags.push('NOT_FINITE');
      sanitized.push(0);
      continue;
    }
    if (numberValue < 0) {
      flags.push('NEGATIVE');
      sanitized.push(0);
      continue;
    }
    if (numberValue >= saturationValue) {
      saturated.push(i);
      sanitized.push(saturationValue);
      continue;
    }
    sanitized.push(numberValue);
  }
  if (saturated.length > 0) flags.push('SATURATED_CH');

  return {
    ok: flags.length === 0,
    values: sanitized,
    flags: Array.from(new Set(flags)),
    channels: { saturated },
  };
}

/**
 * 「0 張り付き」チャネル（断線・接触不良疑い）の監視。
 * 足全体に荷重が乗っているのに特定チャネルだけ 0 が続く状態を検出する。
 * 単一フレームでは踵上げ等と区別できないため、時間窓で判定する。
 *
 * ```js
 * const monitor = new StuckChannelMonitor({ windowFrames: 200, minTotalLoad: 1000 });
 * insole.gotPress = (press) => {
 *   const stuck = monitor.update(press.values);
 *   if (stuck.length) console.warn('stuck channels:', stuck);
 * };
 * ```
 */
export class StuckChannelMonitor {
  windowFrames: number;
  minTotalLoad: number;
  private _zeroStreak: number[] = [];

  constructor(options?: StuckChannelMonitorOptions | null) {
    const opts = options || {};
    const windowFrames = opts.windowFrames;
    const minTotalLoad = opts.minTotalLoad;
    this.windowFrames = windowFrames !== undefined && windowFrames > 0 ? windowFrames : 200;
    this.minTotalLoad = minTotalLoad !== undefined && minTotalLoad >= 0 ? minTotalLoad : 1000;
    this.reset();
  }

  /** 張り付きカウントをリセットする */
  reset(): void {
    this._zeroStreak = new Array<number>(SENSOR_COUNT).fill(0);
  }

  /**
   * 1 フレーム分の生値を渡す。
   * @returns 張り付きと判定されたチャネル番号の配列（なければ空配列）
   */
  update(values: readonly number[] | null | undefined): number[] {
    const validated = validatePress(values);
    const total = validated.values.reduce((sum, value) => sum + value, 0);
    const stuck: number[] = [];
    for (let i = 0; i < SENSOR_COUNT; i++) {
      // 荷重が乗っているフレームでのみ 0 連続をカウント（離地中はリセットしない・進めない）
      if (total >= this.minTotalLoad) {
        this._zeroStreak[i] = validated.values[i] === 0 ? this._zeroStreak[i]! + 1 : 0;
      }
      if (this._zeroStreak[i]! >= this.windowFrames) stuck.push(i);
    }
    return stuck;
  }
}

/**
 * 2点キャリブレーション（無負荷時・全体重時）による 0..1 正規化。
 *
 * ```js
 * const calib = new PressureCalibrator();
 * calib.setZero(zeroSamples);  // 無負荷で 1〜2 秒分の press.values を集めて渡す
 * calib.setFull(fullSamples);  // 全体重で同様
 * const normalized = calib.normalize(press.values); // 各ch 0..1
 * ```
 */
export class PressureCalibrator {
  /** 無負荷時の各チャネル平均 */
  zero: number[] = new Array<number>(SENSOR_COUNT).fill(0);
  /** 全体重時の各チャネル平均 */
  full: number[] = new Array<number>(SENSOR_COUNT).fill(MAX_UINT16);
  private _zeroSet = false;
  private _fullSet = false;

  /** setZero と setFull の両方が済んでいるか */
  isCalibrated(): boolean {
    return this._zeroSet && this._fullSet;
  }

  /** 無負荷時の press.values の配列を渡す */
  setZero(samples: readonly (readonly number[])[] | null | undefined): void {
    this.zero = averageChannels(samples);
    this._zeroSet = true;
  }

  /** 全体重時の press.values の配列を渡す */
  setFull(samples: readonly (readonly number[])[] | null | undefined): void {
    this.full = averageChannels(samples);
    this._fullSet = true;
  }

  /**
   * 生値を正規化する。
   * @returns 各チャネル 0..1 にクランプされた 6 要素配列
   */
  normalize(values: readonly number[] | null | undefined): number[] {
    const validated = validatePress(values);
    return validated.values.map((value, i) => {
      const range = this.full[i]! - this.zero[i]!;
      const normalized = (value - this.zero[i]!) / (range + 1e-6);
      return Math.max(0, Math.min(1, normalized));
    });
  }

  /** 保存用（localStorage 等）の形式に変換する */
  toJSON(): InsolePressureCalibrationJSON {
    return { zero: this.zero.slice(), full: this.full.slice() };
  }

  /** toJSON() の出力から復元する。形式が不正なら未キャリブレーションのインスタンスを返す */
  static fromJSON(json: Partial<InsolePressureCalibrationJSON> | null | undefined): PressureCalibrator {
    const calibrator = new PressureCalibrator();
    if (json && Array.isArray(json.zero) && Array.isArray(json.full) &&
      json.zero.length >= SENSOR_COUNT && json.full.length >= SENSOR_COUNT) {
      calibrator.zero = json.zero.slice(0, SENSOR_COUNT).map((value) => {
        return Number.isFinite(Number(value)) ? Number(value) : 0;
      });
      calibrator.full = json.full.slice(0, SENSOR_COUNT).map((value) => {
        return Number.isFinite(Number(value)) ? Number(value) : MAX_UINT16;
      });
      calibrator._zeroSet = true;
      calibrator._fullSet = true;
    }
    return calibrator;
  }
}

function averageChannels(samples: readonly (readonly number[])[] | null | undefined): number[] {
  const sum = new Array<number>(SENSOR_COUNT).fill(0);
  if (!Array.isArray(samples) || samples.length === 0) return sum;
  let count = 0;
  for (const sample of samples) {
    const validated = validatePress(sample);
    validated.values.forEach((value, i) => { sum[i] = sum[i]! + value; });
    count++;
  }
  return sum.map((value) => value / count);
}

/**
 * 圧力中心（CoP）を計算する。
 * @param values press.values（生値または正規化値）
 * @param layout センサ座標（既定 SENSOR_LAYOUT = 右足基準。左足は mirrorForSide(SENSOR_LAYOUT, 'left') を渡す）
 * @param options minLoad: これ未満の合計荷重では isValid=false（既定 1）
 */
export function computeCoP(
  values: readonly number[] | null | undefined,
  layout?: readonly { x: number; y: number }[] | null,
  options?: { minLoad?: number } | null,
): InsoleCoP {
  const sensors = layout || SENSOR_LAYOUT;
  const minLoad = options && typeof options.minLoad === 'number' && options.minLoad >= 0
    ? options.minLoad
    : 1;
  const validated = validatePress(values);
  const flags: InsoleCoPFlag[] = validated.flags;
  if (sensors.length < SENSOR_COUNT) {
    return { x: 0, y: 0, load: 0, isValid: false, flags: flags.concat('BAD_LAYOUT') };
  }
  const load = validated.values.reduce((sum, value) => sum + value, 0);

  if (load < minLoad) {
    return { x: 0, y: 0, load, isValid: false, flags: flags.concat('LOAD_BELOW_THRESHOLD') };
  }

  let copX = 0;
  let copY = 0;
  validated.values.forEach((value, i) => {
    const weight = value / load;
    copX += sensors[i]!.x * weight;
    copY += sensors[i]!.y * weight;
  });
  return { x: copX, y: copY, load, isValid: validated.ok, flags };
}

/**
 * 接地/離地イベント検出（ヒステリシス + チャタリング除去用の最小継続時間）。
 *
 * ```js
 * const detector = new ContactDetector({ on: 800, off: 400, minContactMs: 50 });
 * detector.footDown = (info) => console.log('down', info.flightMs);
 * detector.footUp = (info) => console.log('up', info.stanceMs);
 * insole.gotPress = (press) => {
 *   const total = press.values.reduce((a, b) => a + b, 0);
 *   detector.update(total, press.timestamp);
 * };
 * ```
 */
export class ContactDetector {
  /** 接地判定しきい値 */
  on: number;
  /** 離地判定しきい値 */
  off: number;
  minContactMs: number;
  minFlightMs: number;
  /** 接地時コールバック（上書きして使う） */
  footDown: (info: InsoleContactDownEvent) => void;
  /** 離地時コールバック（上書きして使う） */
  footUp: (info: InsoleContactUpEvent) => void;
  /** 現在接地中か */
  isContact = false;
  private _lastChange: number | null = null;

  /** @throws {TypeError} options.on が options.off より大きくない場合 */
  constructor(options: ContactDetectorOptions) {
    const opts: Partial<ContactDetectorOptions> = options || {};
    if (!(opts.on !== undefined && opts.off !== undefined && opts.on > opts.off)) {
      throw new TypeError('ContactDetector: options.on must be greater than options.off');
    }
    const minContactMs = opts.minContactMs;
    const minFlightMs = opts.minFlightMs;
    this.on = opts.on;
    this.off = opts.off;
    this.minContactMs = minContactMs !== undefined && minContactMs > 0 ? minContactMs : 0;
    this.minFlightMs = minFlightMs !== undefined && minFlightMs > 0 ? minFlightMs : 0;
    this.footDown = function () { };
    this.footUp = function () { };
    this.reset();
  }

  /** 状態を離地・履歴なしに戻す */
  reset(): void {
    this.isContact = false;
    this._lastChange = null;
  }

  /**
   * 1 フレーム分の合計荷重を渡す。状態が変わったときだけイベントを返し、対応するコールバックも呼ぶ。
   * @param total 合計荷重（生値または正規化値。on/off と同じ単位で）
   * @param timestampMs タイムスタンプ [ms]（press.timestamp）
   */
  update(total: number, timestampMs: number): InsoleContactDownEvent | InsoleContactUpEvent | null {
    const elapsed = this._lastChange === null ? null : timestampMs - this._lastChange;

    if (!this.isContact && total > this.on) {
      if (elapsed !== null && elapsed < this.minFlightMs) return null; // 直前の離地が短すぎる → チャタリング
      this.isContact = true;
      this._lastChange = timestampMs;
      const info: InsoleContactDownEvent = { event: 'down', timestamp: timestampMs, flightMs: elapsed };
      this.footDown(info);
      return info;
    }
    if (this.isContact && total < this.off) {
      if (elapsed !== null && elapsed < this.minContactMs) return null; // 接地が短すぎる → チャタリング
      this.isContact = false;
      this._lastChange = timestampMs;
      const info: InsoleContactUpEvent = { event: 'up', timestamp: timestampMs, stanceMs: elapsed };
      this.footUp(info);
      return info;
    }
    return null;
  }
}

/**
 * device_information.mount_position から装着情報を解釈する。
 * bit0: 0=LEFT, 1=RIGHT / bit1: 0=足底(plantar), 1=足背(dorsal)
 * @returns 数値でない場合（未接続・未取得）は null
 */
export function sideFromMountPosition(mountPosition: unknown): InsoleMountInfo | null {
  if (typeof mountPosition !== 'number' || !Number.isFinite(mountPosition)) return null;
  const isRight = (mountPosition & 0b01) === 0b01;
  const isDorsal = (mountPosition & 0b10) === 0b10;
  return {
    side: isRight ? 'right' : 'left',
    surface: isDorsal ? 'dorsal' : 'plantar',
    isRight,
    isDorsal,
  };
}

/** 上記ユーティリティをまとめたオブジェクト */
export const OrpheInsoleUtils = {
  SENSOR_COUNT,
  MAX_UINT16,
  SENSOR_LAYOUT_IMAGE,
  SENSOR_LAYOUT,
  mirrorForSide,
  validatePress,
  StuckChannelMonitor,
  PressureCalibrator,
  computeCoP,
  ContactDetector,
  sideFromMountPosition,
};
