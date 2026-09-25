/**
 * FIFO 収集ループの状態機械。
 *
 * - NotifyQueue   … notify を promise で待てるキュー（応答待ちの同期化）
 * - FifoLoopState … 1 収録ぶんの回収済みデータ・再要求キュー・ロス計上
 * - DrainBudget   … stop() 後の回収フェーズの idle 予算
 *
 * BLE は一切触らない。純粋にロジックだけを持ち、recorder.ts が組み合わせて使う。
 */
import {
  FIFO_CATCHUP_MAX_BUDGET_FACTOR,
  FIFO_MAX_CARRY_OVER_SERIALS,
  FIFO_RING_BUFFER_CAPACITY,
  UINT16_MAX,
  buildRequestsFromSerials,
  serialDistance,
} from './protocol.ts';
import type { FifoRequestRange } from './protocol.ts';


// ── 通知キュー（promise ベース） ─────────────────────────────────────
/** notify を promise で待てるようにするキュー。FIFO の同期的な応答待ちに使う。 */
export class NotifyQueue {
  private items: DataView[] = [];
  private waiters: Array<(value: DataView | null) => void> = [];

  /** 受信した notify を積む。待機中の {@link wait} があれば直接渡す。 */
  push(data: DataView): void {
    const w = this.waiters.shift();
    if (w) w(data);
    else this.items.push(data);
  }

  /** 未処理の受信を全部捨てる（モード切替直後の残骸除去などに使う）。 */
  drain(): void {
    this.items.length = 0;
  }

  /** timeout(ms) 待って先頭を取り出す。タイムアウトで null */
  wait(timeoutMs: number): Promise<DataView | null> {
    if (this.items.length) return Promise.resolve(this.items.shift()!);
    return new Promise((resolve) => {
      let settled = false;
      const done = (v: DataView | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const i = this.waiters.indexOf(done);
        if (i >= 0) this.waiters.splice(i, 1);
        resolve(v);
      };
      const timer = setTimeout(() => done(null), timeoutMs);
      this.waiters.push(done);
    });
  }
}

// ── ループ状態 ───────────────────────────────────────────────────────
/**
 * 回復不能な欠損の原因。
 *
 * - `ring_overflow`: 追従が間に合わず FW リングバッファが上書きされた
 * - `carryover_overflow`: 再要求キューが上限を超えたので諦めた
 * - `fw_nodata`: 再要求したが FW にすでにデータが無かった
 * - `resync_backlog`: 再同期時に要求範囲より古くなったバックログ
 * - `stopped_pending`: 収集終了までに回収できなかった末尾ぶん
 */
export type FifoLossReason = 'ring_overflow' | 'carryover_overflow' | 'fw_nodata' | 'resync_backlog' | 'stopped_pending';

/** 1 回ぶんの回復不能ロス。 */
export interface FifoLossEvent {
  /** 失われた原因 */
  reason: FifoLossReason;
  /** 失われたシリアル数 */
  dropped: number;
}

/** ポーリングループ 1 収録ぶんの状態（回収済みデータ・再要求キュー・ロス計上）。 */
export class FifoLoopState {
  /** 最後まで要求し終えたシリアル番号。null は「未同期（次ポーリングで再アンカー）」 */
  lastSerial: number | null = null;
  /** 次ループで再要求する範囲（BLE で取りこぼしたぶん） */
  carryOver: FifoRequestRange[] = [];
  /** 回収済みの生パケット。key はシリアル番号 */
  rawStore = new Map<number, DataView>();
  /** 回復不能に失われた累計シリアル数 */
  dropped = 0;
  /** 未通知の回復不能ロスイベント（呼び出し側が drain） */
  lossEvents: FifoLossEvent[] = [];
  /** lastSerial=null が「再同期由来」か（初回 start 直後と区別） */
  resyncPending = false;
  /** 収録スパンの起点シリアル */
  firstStoredSerial: number | null = null;
  /** firstStoredSerial からの最大距離（収録スパン-1） */
  storedSpanMax = 0;

  /**
   * rawStore へ格納したシリアルの収録スパンを記録する。firstStoredSerial は
   * 「スパンの起点（＝これまでで最小）」であり、より手前のシリアルが来たら巻き戻す。
   * これをしないと serialDistance(起点, 手前) が ~65536 になり storedSpanMax が爆発し、
   * finalizePendingLoss が幻の巨大欠損を計上する（収録アークは半周 < 32768 前提）。
   */
  noteStored(serial: number): void {
    if (this.firstStoredSerial === null) {
      this.firstStoredSerial = serial;
      this.storedSpanMax = 0;
      return;
    }
    const fwd = serialDistance(this.firstStoredSerial, serial);
    const bwd = serialDistance(serial, this.firstStoredSerial);
    if (bwd < fwd) {
      this.firstStoredSerial = serial;
      this.storedSpanMax += bwd;
    } else if (fwd > this.storedSpanMax) {
      this.storedSpanMax = fwd;
    }
  }

  /**
   * 収録スパンの終端を、格納の有無に関わらず serial まで延ばす（stop 時の catch-up 用）。
   * 延ばさないと回収できなかった末尾が計上対象外になり「黙った切り捨て」になる。
   * modular 距離で判定し、半周超は異常値として無視する。
   */
  noteSpanTarget(serial: number): void {
    if (this.firstStoredSerial === null) return;
    const fwd = serialDistance(this.firstStoredSerial, serial);
    if (fwd > UINT16_MAX / 2) return;
    if (fwd > this.storedSpanMax) this.storedSpanMax = fwd;
  }

  /**
   * 収集終了時の最終計上。スパン内で「格納も回復不能計上もされていない」シリアルを
   * dropped に計上する。不変条件: スパン内シリアル数 = rawStore.size + dropped。
   *
   * @returns 今回追加で計上したロス数
   */
  finalizePendingLoss(): number {
    if (this.firstStoredSerial === null) return 0;
    const expected = this.storedSpanMax + 1;
    const pending = expected - this.rawStore.size - this.dropped;
    if (pending <= 0) return 0;
    this.dropped += pending;
    this.lossEvents.push({ reason: 'stopped_pending', dropped: pending });
    return pending;
  }

  /** 新規リクエストの [startSerial, requestSize] を計算 */
  calcRequestRange(currentSerial: number, accumulatedCount: number, maxNewRequest: number): [start: number, size: number] {
    if (this.lastSerial === null) {
      const requestSize = Math.min(accumulatedCount, maxNewRequest);
      // 再同期直後は「直近 requestSize 件」だけを要求するため、それより古い未回収
      // バックログは要求されず失われる。無音欠損にしないよう計上する。
      // 初回 start 直後（resyncPending=false）はバッファ消去済みなので損失ではない。
      if (this.resyncPending) {
        const lost = Math.max(0, accumulatedCount - requestSize);
        if (lost > 0) {
          this.dropped += lost;
          this.lossEvents.push({ reason: 'resync_backlog', dropped: lost });
        }
        this.resyncPending = false;
      }
      const startSerial = requestSize > 0
        ? (((currentSerial - (requestSize - 1)) % UINT16_MAX) + UINT16_MAX) % UINT16_MAX
        : 0;
      return [startSerial, requestSize];
    }

    let need = serialDistance(this.lastSerial, currentSerial);
    if (need > FIFO_RING_BUFFER_CAPACITY) {
      // 追従が間に合わず FW リングバッファが上書きされた分は回復不能。
      // 「気づかない欠損」になりやすいので必ず記録・通知する。
      const skip = need - FIFO_RING_BUFFER_CAPACITY;
      this.lastSerial = (this.lastSerial + skip) % UINT16_MAX;
      this.carryOver = [];
      this.dropped += skip;
      this.lossEvents.push({ reason: 'ring_overflow', dropped: skip });
      need = serialDistance(this.lastSerial, currentSerial);
    }
    const requestSize = Math.min(need, maxNewRequest);
    const startSerial = (this.lastSerial + 1) % UINT16_MAX;
    return [startSerial, requestSize];
  }

  /** レスポンス後に lastSerial と carryOver を更新。戻り値はログ用 */
  updateAfterResponse(bleLoss: Set<number>, newNoData: Set<number>, startSerial: number, requestSize: number): 'resync' | 'ok' {
    if (bleLoss.size > 0) {
      this.carryOver.push(...buildRequestsFromSerials(bleLoss));
      const totalPending = this.carryOver.reduce((sum, [, c]) => sum + c, 0);
      if (totalPending > FIFO_MAX_CARRY_OVER_SERIALS) {
        // carryOver が溢れた分の再要求は諦める＝回復不能ロス
        this.dropped += totalPending;
        this.lossEvents.push({ reason: 'carryover_overflow', dropped: totalPending });
        this.carryOver = [];
        this.lastSerial = null;
        this.resyncPending = true; // 次ポーリングでバックログ超過分を計上する
        return 'resync';
      }
    }
    if (newNoData.size > 0) {
      // 新規レンジの no-data → lastSerial を現在シリアルへ再アンカー（resync）。
      // carryOver（既知の再要求キュー）は破棄しない。破棄すると散発欠損が恒久ロス化し
      // 収束しない。FW から消えた分は次サイクルで fw_nodata として自然に抜ける。
      this.lastSerial = null;
      this.resyncPending = true;
    } else if (requestSize > 0) {
      this.lastSerial = (startSerial + requestSize - 1) % UINT16_MAX;
    }
    return 'ok';
  }
}

// ── 停止後の回収予算（idle ベース） ──────────────────────────────────
/**
 * 「無音が budgetMs 続いたら諦める」予算。データが届いている間は noteProgress() で
 * 期限が延び、hardDeadline（budgetMs × FIFO_CATCHUP_MAX_BUDGET_FACTOR）で必ず打ち切る。
 */
export class DrainBudget {
  /** 無音を許容する時間 [ms] */
  budgetMs: number;
  /** 現在の期限（{@link noteProgress} で延びる） */
  deadline: number;
  /** 延長しても超えない絶対期限 */
  hardDeadline: number;

  constructor(budgetMs: number, now: number = Date.now()) {
    this.budgetMs = Math.max(0, budgetMs);
    this.deadline = now + this.budgetMs;
    this.hardDeadline = now + this.budgetMs * FIFO_CATCHUP_MAX_BUDGET_FACTOR;
  }

  /** 絶対期限を「延長なしの予算」として扱う */
  static fromDeadline(deadline: number, now: number = Date.now()): DrainBudget {
    const b = new DrainBudget(Math.max(0, deadline - now), now);
    b.hardDeadline = deadline;
    return b;
  }

  /** 数値なら絶対期限として、DrainBudget ならそのまま受け取る。 */
  static coerce(budgetOrDeadline: number | DrainBudget): DrainBudget {
    return typeof budgetOrDeadline === 'number' ? DrainBudget.fromDeadline(budgetOrDeadline) : budgetOrDeadline;
  }

  /** 予算切れなら true。 */
  get expired(): boolean {
    return this.remainingMs() <= 0;
  }

  /** 残り時間 [ms]。期限切れなら 0。 */
  remainingMs(): number {
    return Math.max(0, Math.min(this.deadline, this.hardDeadline) - Date.now());
  }

  /** データが届いたので期限を延ばす（hardDeadline は超えない）。 */
  noteProgress(): void {
    this.deadline = Math.min(Date.now() + this.budgetMs, this.hardDeadline);
  }
}
