/**
 * FifoRecorder — FIFO（ロスレス）収集のメインクラス。
 *
 * プロトコルの組立・解釈は protocol.ts、ループの状態は state.ts に置き、
 * ここでは BLE との橋渡し（コマンド送信・notify 横取り・ポーリング）と
 * ユーザ向けコールバックだけを担当する。
 */
import type { PressureCalibration } from '../protocol/pressure-calibration.ts';
import type { BleBufferSource } from '../ble/web-bluetooth.ts';
import { TransportError } from '../ble/errors.ts';
import { downloadCsv } from '../csv.ts';
import {
  CORE_REALTIME_READ_MODE,
  DATA_PACKET_BYTE_LENGTH,
  DEFAULT_DRAIN_TIMEOUT_MS,
  FIFO_READ_MODE,
  FIFO_RE_REQUEST_DATA_NUM,
  MAX_DATA_NUMBER_REQUESTED_AT_ONCE,
  OP_INFO,
  OP_READ_MODE,
  RESP_STATUS,
  SUB_DELETE_ALL,
  SUB_GET_SERIAL,
  SUB_START_MONITOR,
  SUB_STOP_MONITOR,
  UINT16_MAX,
  buildRequestsFromSerials,
  calcExpectedSerials,
  createGetSensorDataRequest,
  decodeFifoPacket,
  expandRequestsToList,
  extractSerialIfSensorPacket,
  parseCurrentSerial,
  parseNoDataResponse,
  rawStoreToCSV,
  serialDistance,
} from './protocol.ts';
import type { FifoCurrentSerial, FifoRequestRange, FifoSample } from './protocol.ts';
import { DrainBudget, FifoLoopState, NotifyQueue } from './state.ts';
import type { FifoLossEvent } from './state.ts';


// ── メインクラス ─────────────────────────────────────────────────────
/**
 * FifoRecorder が必要とする OrpheDevice の構造的サブセット。
 * OrpheDevice（insoleProfile / coreProfile）をそのまま渡せる。
 * FW の FIFO コマンド仕様は両デバイス共通（core は対応 FW が必要）。
 */
export interface FifoHost {
  /** デバイス識別子。コールバックの deviceId に載る */
  readonly id: number;
  /** FIFO コマンドの送信に使う */
  readonly transport: {
    /** DEVICE_INFORMATION へコマンドバイト列を書き込む */
    write(uuid: string, data: ArrayLike<number> | BleBufferSource): Promise<unknown>;
  };
  /**
   * 復帰先読み取りモードの取得・書き戻しに使う。
   * insoleProfile は streaming_mode の現在値へ復帰。core は 1（リアルタイム要求）で復帰
   * （FifoRecorderOptions.restoreMode で上書き可）。
   */
  readonly profile: {
    /** `'insole'` / `'core'` などのプロファイル種別 */
    kind: string;
    /** insole の現在ストリーミングモード（復帰先） */
    streaming_mode?: number | null;
    /** insole の個体別圧力校正係数。あれば CSV の N 換算に使う */
    pressure_calibrations?: readonly (PressureCalibration | null)[] | null;
  };
  /** 接続中なら true。切断されたらループを止める */
  isConnected(): boolean;
  /**
   * 接続中の FW で使える取得モード。`FIFO` が含まれなければ start() は開始しない。
   * 省略時と空配列は FW による制限なしとして扱う。
   */
  readonly availableModes?: readonly {
    /** モード id（`FIFO` など） */
    id: string;
  }[];
  /** SENSOR_VALUES の notify を横取りする。戻り値を呼ぶと解除 */
  setNotifySink(uuid: string, sink: (value: DataView) => void): () => void;
  /** 収集中に起きた例外を上位へ通知する */
  reportError(error: unknown): void;
}

/** FIFO ポーリングループのタイミング設定（単位はすべて ms）。 */
export interface FifoTiming {
  /** ポーリング間隔。既定 200ms */
  pollingIntervalMs: number;
  /** 現在シリアル応答の待ち時間。既定 50ms */
  currentSerialTimeoutMs: number;
  /** 1要求の応答全体の待ち時間。既定 5000ms（200件/60per s ≒ 3.3s + 余裕） */
  oneShotTimeoutMs: number;
  /** バースト受信中に許容する無音。既定 400ms */
  oneShotIdleTimeoutMs: number;
  /** ACK コマンドの待ち時間。既定 300ms */
  commandAckTimeoutMs: number;
  /** 読み取りモード変更後の待ち。既定 100ms */
  modeSwitchDelayMs: number;
  /** FIFO モード切替後、直前のリアルタイムパケットを捨てるまでの待ち。既定 200ms */
  fifoModeSettleMs: number;
  /** ハンドシェイク再試行の間隔。既定 1000ms */
  retryIntervalMs: number;
}

const DEFAULT_TIMING: FifoTiming = {
  pollingIntervalMs: 200,
  currentSerialTimeoutMs: 50,
  oneShotTimeoutMs: 5000,
  oneShotIdleTimeoutMs: 400,
  commandAckTimeoutMs: 300,
  modeSwitchDelayMs: 100,
  fifoModeSettleMs: 200,
  retryIntervalMs: 1000,
};

/** {@link FifoRecorder.onProgress} へ渡る進捗情報。 */
export interface FifoProgressInfo {
  /** 回収済みパケット数 */
  collected: number;
  /** 直近のポーリングで受け取ったパケット数 */
  lastReceived: number;
  /** そのとき FW が持っていた最新シリアル番号（取得できなければ null） */
  currentSerial: number | null;
  /** 追従遅れ（未取得シリアル数）。FIFO_RING_BUFFER_CAPACITY に近づくと欠損の危険 */
  lag: number;
  /** 回復不能に失われた累計シリアル数 */
  dropped: number;
  /** stop() 後の回収フェーズ中は true */
  draining?: boolean;
  /** catch-up（未要求バックログ回収）中は true */
  catchup?: boolean;
}

/** 期待した件数と受信件数がズレたときに {@link FifoRecorder.onAnomaly} へ渡る内訳。 */
export interface FifoAnomalyInfo {
  /** 要求した先頭シリアル */
  startSerial: number;
  /** 要求した件数 */
  requestSize: number;
  /** そのとき FW が持っていた最新シリアル */
  currentSerial: number;
  /** 実際に受信した件数 */
  received: number;
  /** 受信できるはずだった件数 */
  expected: number;
  /** FW から no-data と返された件数 */
  noData: number;
  /** BLE で取りこぼした件数（次ループで再要求する） */
  bleLoss: number;
  /** 再要求しても取れず、回復不能と確定した件数 */
  confirmedLost: number;
  /** 今回新たに no-data になった件数 */
  newNoData: number;
}

/** {@link FifoRecorder.onDataLoss} へ渡る回復不能ロスの通知。 */
export interface FifoDataLossInfo extends FifoLossEvent {
  /** 収録開始からの累計ロス数 */
  cumulative: number;
  /** 検出時点の FW 最新シリアル */
  currentSerial: number | null;
}

/** {@link FifoRecorder.onStopped} へ渡る収録終了サマリ。 */
export interface FifoStoppedInfo {
  /** `'manual'` = stop() 呼び出し / `'loss'` = stopOnLoss による自動停止 */
  reason: 'manual' | 'loss';
  /** 回復不能に失われた累計シリアル数 */
  dropped: number;
  /** 回収できたパケット数 */
  collected: number;
  /** 停止後の drain フェーズで追加回収できた件数 */
  drainRecovered: number;
  /** 停止後の catch-up フェーズで追加回収できた件数 */
  catchupRecovered: number;
}

/** {@link FifoRecorder.createCheckpoint} が返す区間の起点。 */
export interface FifoCheckpoint {
  /** 収録セッションの通し番号。start() ごとに増え、またぐと集計は無効になる */
  captureId: number;
  /** 起点シリアル番号 */
  serial: number | null;
  /** 起点時点の累計ロス数 */
  dropped: number;
  /** 起点時点の回収済みパケット数 */
  collected: number;
}

/** {@link FifoRecorder.summarizeSince} が返す区間ごとの欠損集計。 */
export interface FifoSummary {
  /** 集計できたら true（checkpoint が別セッション由来などなら false） */
  available: boolean;
  /** 区間の先頭シリアル */
  first: number | null;
  /** 区間の末尾シリアル */
  last: number | null;
  /** 区間に含まれるはずのパケット数 */
  expected: number;
  /** 実際に回収できていたパケット数 */
  received: number;
  /** 欠損数（`expected - received`） */
  missing: number;
  /** 欠損率（0..1） */
  missingRate: number;
  /** 収録開始からの累計ロス数 */
  dropped: number;
  /** 区間内で新たに計上されたロス数 */
  reportedDroppedDelta?: number;
  /** 集計に使った checkpoint */
  checkpoint: FifoCheckpoint | null | undefined;
}

/** {@link FifoRecorder} の生成オプション。 */
export interface FifoRecorderOptions {
  /** モニタ開始後にバッファへ蓄積を待つ時間。既定 1000ms */
  startupDelayMs?: number;
  /** 回復不能な欠損が発生した時点で収録を自動停止する。既定 false */
  stopOnLoss?: boolean;
  /** stop() 後の回収フェーズ（catch-up + drain）の idle 予算。既定 3000ms、0 で無効 */
  drainTimeoutMs?: number;
  /** タイミングの上書き（テスト・チューニング用） */
  timing?: Partial<FifoTiming>;
  /**
   * stop() 後に書き戻す読み取りモード。既定は profile.streaming_mode ?? 4。
   * 0 も有効値として書く。null で復帰 write 自体を送らない（FIFO モードのまま）。
   */
  restoreMode?: number | null;
  /** テスト用注入点: 待機の実装。既定 setTimeout */
  wait?: (ms: number) => Promise<void>;
}

/**
 * FIFO（ロスレス）収集。begin() 済みの OrpheDevice（insole / core）を渡して使う。
 * core は FIFO 対応 FW でのみ動作する（未対応 FW では start() が false を返す）。
 * 収録中は SENSOR_VALUES の notify を setNotifySink で横取りするため、
 * リアルタイム配信（press/acc 等）は一時停止する。
 *
 *   const fifo = new FifoRecorder(ble);
 *   fifo.onSamples = (deviceId, samples) => { ... };
 *   await fifo.start();
 *   ...
 *   await fifo.stop();
 *   fifo.download('capture.csv');
 */
export class FifoRecorder {
  /** 収集対象のデバイス（begin() 済みの OrpheDevice） */
  readonly ble: FifoHost;
  /** 回復不能な欠損が出た時点で自動停止するか */
  stopOnLoss: boolean;
  /**
   * ポーリングループの内部状態（回収済みデータ・ロス計上）
   *
   * @internal
   */
  state = new FifoLoopState();
  /** 現在の追従遅れ（未取得シリアル数） */
  lag = 0;

  // コールバック（ユーザが上書き）
  /** パケットをデコードするたびに呼ばれる（ライブ可視化用） */
  onSamples: ((deviceId: number, samples: FifoSample[]) => void) | null = null;
  /** ポーリングごとの進捗通知 */
  onProgress: ((info: FifoProgressInfo) => void) | null = null;
  /** 期待件数と受信件数がズレたときの内訳通知 */
  onAnomaly: ((info: FifoAnomalyInfo) => void) | null = null;
  /** 回復不能な欠損が確定したときの通知 */
  onDataLoss: ((info: FifoDataLossInfo) => void) | null = null;
  /** 収録終了時のサマリ通知 */
  onStopped: ((info: FifoStoppedInfo) => void) | null = null;
  /** 収集中に起きた例外の通知 */
  onError: ((error: unknown) => void) | null = null;

  private readonly options: FifoRecorderOptions;
  private readonly timing: FifoTiming;
  private readonly wait: (ms: number) => Promise<void>;
  private queue = new NotifyQueue();
  private running = false;
  private starting = false;
  private loopPromise: Promise<void> | null = null;
  private restoreMode: number | null = null;
  private removeSink: (() => void) | null = null;
  private tornDown = false;
  private autoStopped = false;
  private lastCurrentSerial: number | null = null;
  private captureId = 0;

  constructor(ble: FifoHost, options: FifoRecorderOptions = {}) {
    this.ble = ble;
    this.options = options;
    this.stopOnLoss = options.stopOnLoss ?? false;
    this.timing = { ...DEFAULT_TIMING, ...options.timing };
    this.wait = options.wait ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /** デバイス識別子。 */
  get deviceId(): number {
    return this.ble.id;
  }

  /** 回収済みパケット数。 */
  get collectedCount(): number {
    return this.state.rawStore.size;
  }

  /** 回復不能に失われた累計シリアル数（0 なら欠損なし） */
  get droppedCount(): number {
    return this.state.dropped;
  }

  /** 収録中なら true。 */
  get isRunning(): boolean {
    return this.running;
  }

  /**
   * 収集済みデータと損失カウントを捨てて初期状態へ戻す。
   * 収録中は何も変更しない（stop() してから呼ぶこと）。
   * 直前までに発行した {@link FifoCheckpoint} は無効になる。
   */
  reset(): void {
    if (this.running) return;
    this.state = new FifoLoopState();
    this.captureId += 1;
    this.lag = 0;
    this.lastCurrentSerial = null;
  }

  /**
   * FIFO 内部の要求境界を記録する。到着時刻でなく device serial 範囲で
   * 後続区間の完全性を判定するため、preview 後の正式計測開始時に使う。
   */
  createCheckpoint(): FifoCheckpoint {
    return {
      captureId: this.captureId,
      serial: this.state.lastSerial,
      dropped: this.state.dropped,
      collected: this.state.rawStore.size,
    };
  }

  /**
   * checkpoint 直後から現在の要求済み serial までを rawStore で再集計する。
   * 遅延・再要求で到着順が前後しても、drain 後の最終欠損を正しく返す。
   */
  summarizeSince(checkpoint: FifoCheckpoint | null | undefined): FifoSummary {
    const start = checkpoint && Number.isInteger(checkpoint.serial) ? checkpoint.serial : null;
    const end = this.state.lastSerial;
    const sameCapture = checkpoint && checkpoint.captureId === this.captureId;
    if (!sameCapture || start === null || !Number.isInteger(end)) {
      return {
        available: false,
        first: null,
        last: null,
        expected: 0,
        received: 0,
        missing: 0,
        missingRate: 0,
        dropped: Math.max(0, this.state.dropped - Number(checkpoint?.dropped ?? 0)),
        checkpoint,
      };
    }

    const expected = serialDistance(start, end!);
    const received = this.serialsSince(checkpoint).length;
    const missing = Math.max(0, expected - received);
    return {
      available: true,
      first: expected > 0 ? (start + 1) % UINT16_MAX : null,
      last: end,
      expected,
      received,
      missing,
      missingRate: expected > 0 ? missing / expected : 0,
      // 正式区間の dropped は、この device serial 範囲で実際に未回収の件数を採用する
      dropped: missing,
      reportedDroppedDelta: Math.max(0, this.state.dropped - Number(checkpoint!.dropped ?? 0)),
      checkpoint,
    };
  }

  /** checkpoint 範囲に含まれる回収済み device serial を返す */
  serialsSince(checkpoint: FifoCheckpoint | null | undefined): number[] {
    const start = checkpoint && Number.isInteger(checkpoint.serial) ? checkpoint.serial : null;
    const end = this.state.lastSerial;
    if (!checkpoint || checkpoint.captureId !== this.captureId || start === null || !Number.isInteger(end)) return [];
    const expected = serialDistance(start, end!);
    const serials: number[] = [];
    for (const serial of this.state.rawStore.keys()) {
      const distance = serialDistance(start, serial);
      if (distance > 0 && distance <= expected) serials.push(serial);
    }
    return serials;
  }

  // ── 低レベルコマンド ───────────────────────────────────────────────
  private write(bytes: Uint8Array | number[]): Promise<unknown> {
    return this.ble.transport.write('DEVICE_INFORMATION', bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes));
  }

  private async setReadMode(mode: number): Promise<void> {
    await this.write([OP_READ_MODE, mode]);
    await this.wait(this.timing.modeSwitchDelayMs);
  }

  /** ACK 応答 (0x35 sub) を待つコマンド */
  private async commandExpectAck(sub: number): Promise<boolean> {
    this.queue.drain();
    await this.write([OP_INFO, sub]);
    const dv = await this.queue.wait(this.timing.commandAckTimeoutMs);
    return !!(dv && dv.byteLength >= 2 && dv.getUint8(0) === RESP_STATUS && dv.getUint8(1) === sub);
  }

  private async getCurrentSerial(): Promise<FifoCurrentSerial | null> {
    this.queue.drain();
    await this.write([OP_INFO, SUB_GET_SERIAL]);
    const dv = await this.queue.wait(this.timing.currentSerialTimeoutMs);
    return dv ? parseCurrentSerial(dv) : null;
  }

  private async retry(fn: () => Promise<boolean>, retries = 10): Promise<boolean> {
    for (let i = 0; i < retries; i++) {
      if (await fn()) return true;
      await this.wait(this.timing.retryIntervalMs);
    }
    return false;
  }

  private async retryValue<T>(fn: () => Promise<T | null>, retries = 10): Promise<T | null> {
    for (let i = 0; i < retries; i++) {
      const v = await fn();
      if (v !== null && v !== undefined) return v;
      await this.wait(1);
    }
    return null;
  }

  // ── 収集開始 ───────────────────────────────────────────────────────
  /**
   * FIFO 収集を開始する。SENSOR_VALUES 通知は begin() で開始済みであること。
   * @returns 準備に成功して収集を開始できたら true
   */
  async start(): Promise<boolean> {
    if (this.running || this.starting) return this.running;
    // 直前の stop()/自動停止のライフサイクル完了を待つ。待たずに再開すると
    // 旧ループと新ループが同じ NotifyQueue を奪い合う。
    this.starting = true;
    try {
      if (this.loopPromise) {
        try {
          await this.loopPromise;
        } catch {
          /* noop */
        }
      }
    } finally {
      this.starting = false;
    }
    if (!this.ble.isConnected()) {
      this.reportError(new Error('FifoRecorder.start(): insole is not connected'));
      return false;
    }
    const modes = this.ble.availableModes;
    if (modes && modes.length > 0 && !modes.some(mode => mode.id === 'FIFO')) {
      this.reportError(new TransportError('UNSUPPORTED_MODE', 'FifoRecorder.start(): FIFO is not available on this firmware'));
      return false;
    }

    // 収集直前の状態をクリア
    this.state = new FifoLoopState();
    this.captureId += 1;
    this.restoreMode =
      this.options.restoreMode !== undefined
        ? this.options.restoreMode
        : (this.ble.profile.streaming_mode ??
          (this.ble.profile.kind === 'core' ? CORE_REALTIME_READ_MODE : 4));

    // notify をこのモジュールの queue へ横取り（別モジュールが横取り中なら失敗する）
    try {
      this.removeSink = this.ble.setNotifySink('SENSOR_VALUES', (dv) => this.queue.push(dv));
    } catch (error) {
      this.reportError(error);
      return false;
    }

    try {
      await this.setReadMode(FIFO_READ_MODE);
      await this.wait(this.timing.fifoModeSettleMs);
      this.queue.drain(); // モード切替直前のリアルタイムパケットを捨てる

      const prepared = await this.prepare();
      if (!prepared) {
        this.reportError(new Error('FifoRecorder.start(): failed to prepare FIFO collection'));
        await this.teardown();
        return false;
      }
    } catch (error) {
      this.reportError(error);
      await this.teardown();
      return false;
    }

    this.running = true;
    this.tornDown = false;
    this.autoStopped = false;
    // ループがどんな理由で終わっても（stop() / stopOnLoss / 例外）必ず後片付けと
    // onStopped 通知を1回だけ行う
    this.loopPromise = this.runLoopWrapped();
    return true;
  }

  private async runLoopWrapped(): Promise<void> {
    let drainRecovered = 0;
    let catchupRecovered = 0;
    try {
      await this.runLoop();
      // 手動 stop() で終了した場合のみ回収フェーズを走らせる:
      //   1) catch-up: 停止時点で FW に溜まっていた「まだ要求していない」バックログを新規レンジで回収
      //   2) drain   : 未回収（carryOver）の再要求を続けて取りこぼしを回収
      // 未回収が無ければ即抜けるので、欠損のない正常系では stop() の遅延は実質ゼロ。
      const drainTimeoutMs = this.options.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS;
      if (!this.autoStopped && drainTimeoutMs > 0 && this.ble.isConnected()) {
        // catch-up と drain は同じ idle 予算を共有する
        const budget = new DrainBudget(drainTimeoutMs);
        catchupRecovered = await this.catchUpLoop(await this.resolveCatchUpTarget(), budget);
        drainRecovered = await this.drainLoop(budget);
      }
    } catch (error) {
      this.reportError(error);
    } finally {
      // 停止時の最終計上: 再要求が成功しないままループを抜けた分は、収録スパンとの
      // 差分をここで必ず dropped に反映する（「droppedCount === 0 なら CSV は完全」の
      // 保証を停止時にも成立させるセーフティネット）
      const pending = this.state.finalizePendingLoss();
      if (pending > 0 && this.onDataLoss) {
        this.safe(() => this.onDataLoss!({
          reason: 'stopped_pending',
          dropped: pending,
          cumulative: this.state.dropped,
          currentSerial: this.lastCurrentSerial,
        }));
      }
      this.state.lossEvents.length = 0; // finalize 分は上で通知済み
      await this.teardownOnce();
      if (this.onStopped) {
        this.safe(() => this.onStopped!({
          reason: this.autoStopped ? 'loss' : 'manual',
          dropped: this.state.dropped,
          collected: this.state.rawStore.size,
          drainRecovered,
          catchupRecovered,
        }));
      }
    }
  }

  // ── 停止時の catch-up 目標（frozen target） ────────────────────────
  // stop() 時点の FW 書き込み位置を1回だけ確定させる。以降この値で固定し、
  // 停止後に新しく生成されるシリアルは追いかけない。
  private async resolveCatchUpTarget(): Promise<number | null> {
    try {
      const current = await this.retryValue(() => this.getCurrentSerial(), 3);
      if (current && Number.isInteger(current.serial)) {
        this.lastCurrentSerial = current.serial;
        return current.serial;
      }
    } catch {
      /* 取得できなければ最後のポーリング値へフォールバック */
    }
    return Number.isInteger(this.lastCurrentSerial) ? this.lastCurrentSerial : null;
  }

  // ── 回収フェーズ その1: catch-up（未要求バックログの回収） ──────────
  // 追従が遅れていると stop() 時点で「FW には溜まっているのに一度も要求していない」
  // シリアルが残る。frozen target までの新規レンジを前方へ要求し続けて末尾を回収する。
  private async catchUpLoop(frozenTarget: number | null, budget: DrainBudget): Promise<number> {
    const state = this.state;
    if (!Number.isInteger(frozenTarget)) return 0;
    // 再同期中（lastSerial=null）は「どこまで要求済みか」が不明なので catch-up しない
    if (state.lastSerial === null) return 0;

    // 目標が要求済み境界より後方（＝追従済み or 異常値）なら何もしない。
    // wrap を挟むと数値の大小では判定できないので modular 距離で見る（半周超は異常値）。
    const backlog = serialDistance(state.lastSerial, frozenTarget!);
    if (backlog === 0 || backlog > UINT16_MAX / 2) return 0;

    // 収録スパンを frozen target まで延ばし、予算内に回収しきれなかった末尾を
    // finalizePendingLoss が stopped_pending として必ず計上できるようにする
    state.noteSpanTarget(frozenTarget!);

    let recovered = 0;
    while (!budget.expired) {
      const anchor: number = state.lastSerial!; // 冒頭で null を弾き、以降は前進のみ
      const remaining = serialDistance(anchor, frozenTarget!);
      if (remaining <= 0) break;
      const requestSize = Math.min(remaining, MAX_DATA_NUMBER_REQUESTED_AT_ONCE);
      const startSerial = (anchor + 1) % UINT16_MAX;
      const expectedSerials = new Set(calcExpectedSerials(startSerial, requestSize));

      this.queue.drain();
      await this.write(createGetSensorDataRequest([[startSerial, requestSize]]));

      const shotTimeout = Math.min(this.timing.oneShotTimeoutMs, budget.remainingMs());
      if (shotTimeout <= 0) break;
      const { received, noDataSerials } = await this.receiveResponses(expectedSerials, shotTimeout, this.timing.oneShotIdleTimeoutMs);

      // 要求済み境界は無条件に前進させる。target は固定なので resync は不要
      state.lastSerial = (startSerial + requestSize - 1) % UINT16_MAX;
      this.classifyMissed(expectedSerials, received, noDataSerials);

      const stored = this.absorbReceived(received);
      recovered += stored;
      if (stored > 0) budget.noteProgress(); // 届いている限り idle 予算を延長する
      this.flushLossEvents();
      if (this.onProgress) {
        this.safe(() => this.onProgress!({
          collected: state.rawStore.size,
          lastReceived: received.size,
          currentSerial: this.lastCurrentSerial,
          lag: serialDistance(state.lastSerial!, frozenTarget!) + state.carryOver.reduce((sum, [, c]) => sum + c, 0),
          dropped: state.dropped,
          draining: true,
          catchup: true,
        }));
      }
    }
    return recovered;
  }

  // ── 回収フェーズ その2: drain（未回収の再要求） ────────────────────
  // 新規レンジ要求は打ち切り、未回収（carryOver）の再要求だけを予算内で続ける。
  // FW から消えた分は no-data → fw_nodata として確定計上し carryOver から抜く。
  private async drainLoop(budget: DrainBudget): Promise<number> {
    const state = this.state;
    let recovered = 0;
    while (state.carryOver.length > 0 && !budget.expired) {
      const carryOverToSend = state.carryOver.slice(0, FIFO_RE_REQUEST_DATA_NUM);
      state.carryOver = state.carryOver.slice(carryOverToSend.length);
      const expectedSerials = new Set(expandRequestsToList(carryOverToSend));
      if (expectedSerials.size === 0) continue;

      this.queue.drain();
      await this.write(createGetSensorDataRequest(carryOverToSend));

      const shotTimeout = Math.min(this.timing.oneShotTimeoutMs, budget.remainingMs());
      const { received, noDataSerials } = await this.receiveResponses(expectedSerials, shotTimeout, this.timing.oneShotIdleTimeoutMs);

      this.classifyMissed(expectedSerials, received, noDataSerials);

      const stored = this.absorbReceived(received);
      recovered += stored;
      if (stored > 0) budget.noteProgress();
      this.flushLossEvents();
      if (this.onProgress) {
        this.safe(() => this.onProgress!({
          collected: state.rawStore.size,
          lastReceived: received.size,
          currentSerial: this.lastCurrentSerial,
          lag: state.carryOver.reduce((sum, [, c]) => sum + c, 0),
          dropped: state.dropped,
          draining: true,
        }));
      }
    }
    return recovered;
  }

  // 受信結果を「再要求へ戻す分（BLEロス）」と「FWから消えた分（回復不能）」に分類する。
  // catch-up / drain で共用（片方だけ直る事故を防ぐ）。
  private classifyMissed(expectedSerials: Set<number>, received: Map<number, DataView>, noDataSerials: Set<number>): void {
    const state = this.state;
    const missed = [...expectedSerials].filter((sn) => !received.has(sn));
    const bleLoss = new Set(missed.filter((sn) => !noDataSerials.has(sn))); // まだ届かない → 再要求へ
    const confirmedLost = missed.filter((sn) => noDataSerials.has(sn)); // FW から消失 → 回復不能
    if (confirmedLost.length > 0) {
      state.dropped += confirmedLost.length;
      state.lossEvents.push({ reason: 'fw_nodata', dropped: confirmedLost.length });
    }
    if (bleLoss.size > 0) state.carryOver.push(...buildRequestsFromSerials(bleLoss));
  }

  // 受信パケットを rawStore へ格納し、デコード結果を onSamples へ流す。新規格納数を返す。
  private absorbReceived(received: Map<number, DataView>): number {
    const state = this.state;
    const decodedSamples: FifoSample[] = [];
    let stored = 0;
    for (const [sn, dv] of received) {
      if (state.rawStore.has(sn)) continue;
      state.rawStore.set(sn, dv);
      state.noteStored(sn);
      stored += 1;
      for (const s of decodeFifoPacket(dv).samples) decodedSamples.push(s);
    }
    if (decodedSamples.length && this.onSamples) {
      this.safe(() => this.onSamples!(this.deviceId, decodedSamples));
    }
    return stored;
  }

  // 蓄積した回復不能ロスイベントを onDataLoss へ通知する（catch-up / drain で共用）
  private flushLossEvents(): void {
    const state = this.state;
    if (state.lossEvents.length === 0) return;
    const events = state.lossEvents.splice(0);
    if (!this.onDataLoss) return;
    for (const ev of events) {
      this.safe(() => this.onDataLoss!({ ...ev, cumulative: state.dropped, currentSerial: this.lastCurrentSerial }));
    }
  }

  private async prepare(): Promise<boolean> {
    if (!(await this.retry(() => this.commandExpectAck(SUB_STOP_MONITOR)))) return false;
    if (!(await this.retry(() => this.commandExpectAck(SUB_DELETE_ALL)))) return false;
    if (!(await this.retry(() => this.commandExpectAck(SUB_START_MONITOR)))) return false;
    // バッファへ少し蓄積されるのを待つ
    const delay = this.options.startupDelayMs ?? 1000;
    if (delay > 0) await this.wait(delay);
    return true;
  }

  // ── メインループ ───────────────────────────────────────────────────
  private async runLoop(): Promise<void> {
    const state = this.state;
    while (this.running) {
      const current = await this.retryValue(() => this.getCurrentSerial(), 10);
      if (!this.running) break;
      if (current === null) {
        await this.wait(this.timing.pollingIntervalMs);
        continue;
      }

      const { serial: currentSerial, accumulated: accumulatedCount } = current;
      this.lastCurrentSerial = currentSerial;

      // 追従遅れ（まだ取得していないシリアル数）
      this.lag = state.lastSerial === null ? accumulatedCount : serialDistance(state.lastSerial, currentSerial);

      let carryOverToSend = state.carryOver.slice(0, FIFO_RE_REQUEST_DATA_NUM);
      const carryOverSerialCount = carryOverToSend.reduce((sum, [, c]) => sum + c, 0);
      const maxNewRequest = Math.max(0, MAX_DATA_NUMBER_REQUESTED_AT_ONCE - carryOverSerialCount);

      const [startSerial, requestSize] = state.calcRequestRange(currentSerial, accumulatedCount, maxNewRequest);

      if (requestSize <= 0 && carryOverToSend.length === 0) {
        await this.wait(this.timing.pollingIntervalMs);
        continue;
      }

      // 新規レンジを送る場合は、固定 30 スロットを超えないよう carry-over を 29 組までに制限
      if (requestSize > 0 && carryOverToSend.length >= FIFO_RE_REQUEST_DATA_NUM) {
        carryOverToSend = carryOverToSend.slice(0, FIFO_RE_REQUEST_DATA_NUM - 1);
      }

      const requests: FifoRequestRange[] = [];
      if (requestSize > 0) requests.push([startSerial, requestSize]);
      for (const co of carryOverToSend) requests.push(co);
      state.carryOver = state.carryOver.slice(carryOverToSend.length);

      if (requests.length === 0) {
        await this.wait(this.timing.pollingIntervalMs);
        continue;
      }

      const expectedSerials = new Set(expandRequestsToList(requests));
      const newSerials = new Set(calcExpectedSerials(startSerial, requestSize));

      this.queue.drain();
      await this.write(createGetSensorDataRequest(requests));

      const { received, noDataSerials } = await this.receiveResponses(expectedSerials, this.timing.oneShotTimeoutMs, this.timing.oneShotIdleTimeoutMs);
      // stop() で running が落ちても、このサイクルで受信済みの分は捨てずに格納・計上する
      // （捨てると末尾サイクルが黙って欠損する）。未受信分は carryOver → drain が回収する。

      const allMissed = [...expectedSerials].filter((sn) => !received.has(sn));
      const bleLoss = new Set(allMissed.filter((sn) => !noDataSerials.has(sn))); // 通信ロス → 再要求で回復
      const confirmedLost = allMissed.filter((sn) => noDataSerials.has(sn)); // FW バッファから消失 → 回復不能
      const newNoData = new Set([...noDataSerials].filter((sn) => newSerials.has(sn))); // 新規要求への no-data → 再同期

      if (confirmedLost.length > 0) {
        state.dropped += confirmedLost.length;
        state.lossEvents.push({ reason: 'fw_nodata', dropped: confirmedLost.length });
      }

      if ((noDataSerials.size > 0 || allMissed.length > 0) && this.onAnomaly) {
        this.safe(() => this.onAnomaly!({
          startSerial,
          requestSize,
          currentSerial,
          received: received.size,
          expected: expectedSerials.size,
          noData: noDataSerials.size,
          bleLoss: bleLoss.size,
          confirmedLost: confirmedLost.length,
          newNoData: newNoData.size,
        }));
      }

      state.updateAfterResponse(bleLoss, newNoData, startSerial, requestSize);

      // 回復不能ロスの通知（気づかない欠損を防ぐ）。stopOnLoss なら収録を止める。
      if (state.lossEvents.length > 0) {
        const events = state.lossEvents.splice(0);
        if (this.onDataLoss) {
          for (const ev of events) {
            this.safe(() => this.onDataLoss!({ ...ev, cumulative: state.dropped, currentSerial }));
          }
        }
        if (this.stopOnLoss) {
          this.autoStopped = true;
          this.running = false;
        }
      }

      // raw 蓄積 + デコードして可視化コールバックへ
      const decodedSamples: FifoSample[] = [];
      for (const [sn, dv] of received) {
        state.rawStore.set(sn, dv);
        state.noteStored(sn);
        for (const s of decodeFifoPacket(dv).samples) decodedSamples.push(s);
      }
      if (decodedSamples.length && this.onSamples) {
        this.safe(() => this.onSamples!(this.deviceId, decodedSamples));
      }
      if (this.onProgress) {
        this.safe(() => this.onProgress!({
          collected: state.rawStore.size,
          lastReceived: received.size,
          currentSerial,
          lag: this.lag,
          dropped: state.dropped,
        }));
      }

      await this.wait(this.timing.pollingIntervalMs);
    }
  }

  // deadline まで notify を受信し、センサーデータと no-data を分類。
  // idleTimeoutMs: 受信開始後に許容する無音。受信が途切れたら「このバーストは終わり」と
  // 判断して早期に抜ける。未受信分は carryOver で再要求されるので取りこぼしにはならない。
  private async receiveResponses(expectedSerials: Set<number>, timeoutMs: number, idleTimeoutMs: number): Promise<{ received: Map<number, DataView>; noDataSerials: Set<number> }> {
    const received = new Map<number, DataView>();
    const noDataSerials = new Set<number>();
    const totalExpected = expectedSerials.size;
    const deadline = Date.now() + timeoutMs;
    const idleMs = idleTimeoutMs ?? timeoutMs;
    let gotAny = false;

    while (received.size + noDataSerials.size < totalExpected) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      // 最初の応答までは全 budget を待つ。受信し始めたら短い無音（idleMs）で
      // バーストの終わりと判断する。
      const waitMs = gotAny ? Math.min(remaining, idleMs) : remaining;
      const dv = await this.queue.wait(waitMs);
      if (dv === null) break;
      gotAny = true;

      const noData = parseNoDataResponse(dv);
      if (noData !== null) {
        const [ndStart, ndCount] = noData;
        for (let i = 0; i < ndCount; i++) noDataSerials.add((ndStart + i) % UINT16_MAX);
        continue;
      }
      const serial = extractSerialIfSensorPacket(dv);
      if (serial !== null && expectedSerials.has(serial) && dv.byteLength === DATA_PACKET_BYTE_LENGTH) {
        received.set(serial, dv);
      }
    }
    return { received, noDataSerials };
  }

  // ── 収集停止 ───────────────────────────────────────────────────────
  /**
   * 収集を停止し、リアルタイムモードへ復帰する。
   * @returns 収集した raw ストア（serial → 104byte DataView）
   */
  async stop(): Promise<Map<number, DataView>> {
    if (!this.loopPromise) return this.state.rawStore;
    this.running = false;
    // ループ終了時に runLoopWrapped の finally が teardown を1回だけ行う
    try {
      await this.loopPromise;
    } catch {
      /* noop */
    }
    this.loopPromise = null;
    return this.state.rawStore;
  }

  // teardown は「ループ終了時に1回だけ」実行する（stop と自動停止の二重実行を防ぐ）
  private async teardownOnce(): Promise<void> {
    if (this.tornDown) return;
    this.tornDown = true;
    await this.teardown();
  }

  // notify 横取りを解除し、直前のリアルタイムモードへ戻す
  private async teardown(): Promise<void> {
    try {
      if (this.ble.isConnected()) {
        // モニタ停止は FW 側の収録を止める要。ACK が確認できるまで数回再試行する
        await this.retry(() => this.commandExpectAck(SUB_STOP_MONITOR), 3).catch(() => false);
        if (this.restoreMode !== null) {
          await this.setReadMode(this.restoreMode).catch(() => {});
          this.ble.profile.streaming_mode = this.restoreMode;
        }
      }
    } catch {
      /* noop */
    } finally {
      this.removeSink?.();
      this.removeSink = null;
    }
  }

  // ── CSV 出力 ───────────────────────────────────────────────────────
  /** 収集データを CSV 文字列にする（timestamp 昇順） */
  toCSV(): string {
    return rawStoreToCSV(this.state.rawStore, this.ble.profile.pressure_calibrations ?? null);
  }

  /** ブラウザで CSV をダウンロードする */
  download(filename = 'orphe-insole-fifo.csv'): void {
    downloadCsv(this.toCSV(), filename);
  }

  // ── 内部ユーティリティ ─────────────────────────────────────────────
  private safe(fn: () => void): void {
    try {
      fn();
    } catch (error) {
      this.reportError(error);
    }
  }

  private reportError(error: unknown): void {
    if (this.onError) {
      try {
        this.onError(error);
        return;
      } catch {
        /* fallthrough */
      }
    }
    this.ble.reportError(error);
  }
}
