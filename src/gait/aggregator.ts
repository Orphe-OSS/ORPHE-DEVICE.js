/**
 * サブパケットを歩単位に集約し、1 歩ぶんの歩容パラメーター（GaitRow）を組み立てる。
 *
 * overview / stride / pronation は取りこぼし対策で 2 回ずつ送られるため、
 * step_number 単位で集約・重複除去し、3 種揃った歩だけを出力する。
 * step 損失（incomplete / gap / jump）の統計もここで持つ。
 */
import { GAIT_TYPES, STRIDE_DIRECTIONS, footStrikeToStr, pronationToStr } from './packet.ts';
import type { GaitOverviewPacket, GaitPronationPacket, GaitStridePacket } from './packet.ts';


const MAX_PENDING_STEPS = 64; // 揃わないまま溜まる歩の上限（メモリ保護）

// step 損失検出のパラメータ。FW は overview/stride/pronation を各2回、その歩の
// 直後にまとめて送る。数歩あとの step が届いた時点で揃っていない歩は回復不能。
/** この歩数ぶん先の step が届いた時点で、揃っていない歩を回復不能（incomplete）とみなす */
export const GAIT_STALE_STEP_DISTANCE = 8;
/** これを超える step 前進は欠損（gap）でなく採番ジャンプとして扱う */
export const GAIT_GAP_COUNT_LIMIT = 64;
const MISSED_STEP_MEMORY = 256;

/** gaitRowToCsv / download の CSV ヘッダー行 */
export const GAIT_CSV_HEADER =
  'step_number,gait_type,stride_direction,distance_m,' +
  'stance_phase_s,swing_phase_s,duration_s,cadence_hz,speed_mps,' +
  'foot_angle_deg,stride_x_m,stride_y_m,stride_z_m,stride_norm_m,' +
  'landing_force,strike_angle_deg,foot_strike,' +
  'pronation_deg,pronation_type,pronation_z_deg,calorie';

/** uint16 の wraparound を考慮した前進距離（65535→0 をまたいでも正しく数える） */
export function stepDistance(from: number, to: number): number {
  return (to - from + 0x10000) % 0x10000;
}

/** 1歩ぶんの集約結果（overview + stride + pronation + 派生指標） */
export interface GaitRow {
  /** 歩番号（uint16、wraparound あり） */
  step_number: number;
  /** 歩行タイプ名（{@link GAIT_TYPES}） */
  gait_type: string;
  /** ストライド方向名（{@link STRIDE_DIRECTIONS}） */
  stride_direction: string;
  /** 距離 [m] */
  distance_m: number | null;
  /** 立脚期時間 [s] */
  stance_phase_s: number | null;
  /** 遊脚期時間 [s] */
  swing_phase_s: number | null;
  /** 1歩の所要時間 [s]（立脚期 + 遊脚期） */
  duration_s: number | null;
  /** ケイデンス [Hz]（1 / duration_s） */
  cadence_hz: number | null;
  /** 速度 [m/s]（stride_norm_m / duration_s） */
  speed_mps: number | null;
  /** 着地時の足角度 [deg] */
  foot_angle_deg: number | null;
  /** ストライド X 成分 [m] */
  stride_x_m: number | null;
  /** ストライド Y 成分 [m] */
  stride_y_m: number | null;
  /** ストライド Z 成分 [m] */
  stride_z_m: number | null;
  /** ストライドベクトルのノルム [m] */
  stride_norm_m: number | null;
  /** 着地衝撃 */
  landing_force: number | null;
  /** 着地角度 X [deg]（接地パターン判定の元値） */
  strike_angle_deg: number | null;
  /** 接地パターン名（`none` / `heelStrike` / `midfoot` / `forefoot`） */
  foot_strike: string;
  /** プロネーション角 Y [deg]（種別判定の元値） */
  pronation_deg: number | null;
  /** プロネーション種別名（`none` / `neutral` / `over` / `severeOver` / `under` / `severeUnder`） */
  pronation_type: string;
  /** プロネーション角 Z [deg] */
  pronation_z_deg: number | null;
  /** 消費カロリー */
  calorie: number | null;
}

/**
 * 回復不能と判定した歩の内訳。
 *
 * - `incomplete`: サブパケットが揃わないまま古くなった歩
 * - `gap`: 歩番号が飛んで一度も届かなかった歩
 * - `step_number_jump`: 前進量が大きすぎて欠損でなく採番ジャンプと判断した
 */
export type GaitStepLossInfo =
  | {
      /** 判別用タグ */ reason: 'incomplete';
      /** 対象の歩番号 */ step_number: number;
      /** 届かなかったサブパケット名（overview / stride / pronation） */ missing: string[];
    }
  | {
      /** 判別用タグ */ reason: 'gap';
      /** 届かなかった歩番号 */ steps: number[];
      /** その件数 */ count: number;
    }
  | {
      /** 判別用タグ */ reason: 'step_number_jump';
      /** ジャンプ前の歩番号 */ from: number;
      /** ジャンプ後の歩番号 */ to: number;
      /** 前進量 */ forward: number;
    };

/** 歩の損失統計の snapshot。{@link InsoleGait.diagnostics} の `stepLoss` で取れる。 */
export interface GaitStepLossStats {
  /** 3種のサブパケットが揃って出力できた歩数 */
  completedSteps: number;
  /** 揃わないまま回復不能になった歩数 */
  incompleteSteps: number;
  /** incomplete の内訳（どのサブパケットが足りなかったか） */
  missingParts: {
    /** overview が欠けた回数 */ overview: number;
    /** stride が欠けた回数 */ stride: number;
    /** pronation が欠けた回数 */ pronation: number;
  };
  /** 一度も届かなかった歩数 */
  gapSteps: number;
  /** 採番ジャンプと判断した回数 */
  jumps: number;
  /** 最後に観測した歩番号 */
  lastSeenStep: number | null;
  /** まだ揃うのを待っている歩数 */
  pendingSteps: number;
}


// ── 派生指標・CSV ────────────────────────────────────────────────────
/** ストライドベクトルのノルム（1歩の移動量）。成分欠損時は null */
export function strideNorm(stride: Pick<GaitStridePacket, 'stride_x' | 'stride_y' | 'stride_z'>): number | null {
  const { stride_x: x, stride_y: y, stride_z: z } = stride;
  if (x === null || y === null || z === null) return null;
  return Math.sqrt(x * x + y * y + z * z);
}

/** 1歩ぶんの集約途中バッファ。3種すべて揃うと {@link GaitRow} になる。 */
export interface GaitPendingParts {
  /** 歩容概要パケット（sub 0） */
  overview?: GaitOverviewPacket;
  /** ストライドパケット（sub 1） */
  stride?: GaitStridePacket;
  /** プロネーションパケット（sub 2） */
  pronation?: GaitPronationPacket;
}

/** overview / stride / pronation を1歩ぶんにまとめ、派生指標も算出する */
export function buildGaitRow(stepNumber: number, parts: Required<GaitPendingParts>): GaitRow {
  const { overview, stride, pronation } = parts;
  const stance = overview.stance_phase_s; // sanitizeNonNeg 済み（-1/負値は null）
  const swing = overview.swing_phase_s;
  let duration = stance !== null && swing !== null ? stance + swing : null;
  if (duration !== null && duration <= 0) duration = null;
  const norm = strideNorm(stride);
  // cadence / speed は「有限かつ正の duration」のときだけ計算する
  const durationValid = duration !== null && duration > 0;
  const cadence = durationValid ? 1.0 / duration! : null;
  const speed = durationValid && norm !== null ? norm / duration! : null;
  return {
    step_number: stepNumber,
    gait_type: overview.gait_type,
    stride_direction: overview.stride_direction,
    distance_m: overview.distance_m,
    stance_phase_s: stance,
    swing_phase_s: swing,
    duration_s: duration,
    cadence_hz: cadence,
    speed_mps: speed,
    foot_angle_deg: stride.foot_angle,
    stride_x_m: stride.stride_x,
    stride_y_m: stride.stride_y,
    stride_z_m: stride.stride_z,
    stride_norm_m: norm,
    landing_force: pronation.landing_force,
    strike_angle_deg: pronation.pronation_x,
    foot_strike: footStrikeToStr(pronation.pronation_x),
    pronation_deg: pronation.pronation_y,
    pronation_type: pronationToStr(pronation.pronation_y),
    pronation_z_deg: pronation.pronation_z,
    calorie: overview.calorie,
  };
}

function csvCell(v: number | string | null | undefined): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : v.toFixed(4);
  return String(v);
}

/** 1歩ぶんの {@link GaitRow} を {@link GAIT_CSV_HEADER} の並びで CSV 1 行にする。 */
export function gaitRowToCsv(row: GaitRow): string {
  return [
    row.step_number, row.gait_type, row.stride_direction, row.distance_m,
    row.stance_phase_s, row.swing_phase_s, row.duration_s, row.cadence_hz, row.speed_mps,
    row.foot_angle_deg, row.stride_x_m, row.stride_y_m, row.stride_z_m, row.stride_norm_m,
    row.landing_force, row.strike_angle_deg, row.foot_strike,
    row.pronation_deg, row.pronation_type, row.pronation_z_deg, row.calorie,
  ].map(csvCell).join(',');
}

// ── step 集約 ────────────────────────────────────────────────────────
/**
 * 各サブパケットを step_number 単位に集約し、overview/stride/pronation が
 * 揃った歩を返す。サブパケットは複数回送られるため、同じ歩は一度だけ出力する。
 * step 損失（incomplete / gap / jump）も統計・通知する。
 */
export class GaitAggregator {
  private pending = new Map<number, GaitPendingParts>();
  private emitted = new Set<number>();
  private lastSeenStep: number | null = null;
  private missedSteps = new Set<number>(); // gap 計上済み step（後着で取り消すため）
  private statsData = {
    completedSteps: 0,
    incompleteSteps: 0,
    missingParts: { overview: 0, stride: 0, pronation: 0 },
    gapSteps: 0,
    jumps: 0,
  };

  /** 回復不能と判定した歩の通知（InsoleGait が配線する） */
  onStepLoss: ((info: GaitStepLossInfo) => void) | null = null;

  /** 損失統計の snapshot（診断用・読み取り専用） */
  stats(): GaitStepLossStats {
    return {
      ...this.statsData,
      missingParts: { ...this.statsData.missingParts },
      lastSeenStep: this.lastSeenStep,
      pendingSteps: this.pending.size,
    };
  }

  /**
   * サブパケットを 1 件取り込む。
   * @returns その歩の 3 種が揃ったら完成した {@link GaitRow}、まだなら null
   */
  add(packet: GaitOverviewPacket | GaitStridePacket | GaitPronationPacket): GaitRow | null {
    const step = packet.step_number;
    if (this.emitted.has(step)) return null; // 既出（2回目の送信）は無視

    // gap 計上済みの歩が遅れて届いた場合は計上を取り消す
    if (this.missedSteps.delete(step)) {
      this.statsData.gapSteps = Math.max(0, this.statsData.gapSteps - 1);
    }

    const isNewStep = !this.pending.has(step);
    let parts = this.pending.get(step);
    if (!parts) {
      parts = {};
      this.pending.set(step, parts);
    }
    if (packet.type === 'overview') parts.overview = packet;
    else if (packet.type === 'stride') parts.stride = packet;
    else parts.pronation = packet;

    if (isNewStep) this.noteStepSeen(step);

    let row: GaitRow | null = null;
    if (parts.overview && parts.stride && parts.pronation) {
      row = buildGaitRow(step, parts as Required<GaitPendingParts>);
      this.pending.delete(step);
      this.markEmitted(step);
      this.statsData.completedSteps++;
    }
    this.evictStalePending();
    this.evictOldPending();
    return row;
  }

  // step_number の前進から「1サブパケットも届かなかった歩（gap）」を検出する。
  // 前進が GAIT_GAP_COUNT_LIMIT を超える場合は採番リセット/ジャンプ扱い
  // （resetAnalysisLogs や FW 再起動で step_number は巻き戻る）。
  private noteStepSeen(step: number): void {
    if (this.lastSeenStep === null) {
      this.lastSeenStep = step;
      return;
    }
    const forward = stepDistance(this.lastSeenStep, step);
    if (forward === 0) return;
    if (forward > GAIT_GAP_COUNT_LIMIT) {
      const backward = stepDistance(step, this.lastSeenStep);
      if (backward <= GAIT_GAP_COUNT_LIMIT) return; // 既知 step の少し後ろへの後着
      this.statsData.jumps++;
      const from = this.lastSeenStep;
      this.lastSeenStep = step;
      this.notifyLoss({ reason: 'step_number_jump', from, to: step, forward });
      return;
    }
    if (forward > 1) {
      const missed: number[] = [];
      for (let i = 1; i < forward; i++) {
        const missedStep = (this.lastSeenStep + i) % 0x10000;
        if (this.pending.has(missedStep) || this.emitted.has(missedStep)) continue;
        missed.push(missedStep);
        this.missedSteps.add(missedStep);
        while (this.missedSteps.size > MISSED_STEP_MEMORY) {
          this.missedSteps.delete(this.missedSteps.values().next().value!);
        }
      }
      if (missed.length > 0) {
        this.statsData.gapSteps += missed.length;
        this.notifyLoss({ reason: 'gap', steps: missed, count: missed.length });
      }
    }
    this.lastSeenStep = step;
  }

  // 最新 step より GAIT_STALE_STEP_DISTANCE 以上古い pending は再送も終わっている
  // ため、回復不能（incomplete）として計上して捨てる。
  private evictStalePending(): void {
    if (this.lastSeenStep === null) return;
    for (const [step, parts] of this.pending) {
      const behind = stepDistance(step, this.lastSeenStep);
      if (behind >= GAIT_STALE_STEP_DISTANCE) {
        this.pending.delete(step);
        this.countIncomplete(step, parts);
      }
    }
  }

  private countIncomplete(step: number, parts: GaitPendingParts): void {
    this.statsData.incompleteSteps++;
    const missing: string[] = [];
    for (const type of ['overview', 'stride', 'pronation'] as const) {
      if (!parts[type]) {
        this.statsData.missingParts[type]++;
        missing.push(type);
      }
    }
    this.notifyLoss({ reason: 'incomplete', step_number: step, missing });
  }

  private notifyLoss(info: GaitStepLossInfo): void {
    if (!this.onStepLoss) return;
    try {
      this.onStepLoss(info);
    } catch {
      /* コールバック例外で集約を止めない */
    }
  }

  // step_number は uint16 で wraparound するため、最古の判定は数値の大小ではなく
  // 挿入順（＝到着順）で行う（step 0 を最古と誤認しない）。
  private markEmitted(step: number): void {
    this.emitted.add(step);
    const cap = MAX_PENDING_STEPS * 4;
    while (this.emitted.size > cap) {
      this.emitted.delete(this.emitted.values().next().value!);
    }
  }

  private evictOldPending(): void {
    while (this.pending.size > MAX_PENDING_STEPS) {
      const oldest = this.pending.keys().next().value!;
      const parts = this.pending.get(oldest)!;
      this.pending.delete(oldest);
      this.countIncomplete(oldest, parts);
    }
  }
}
