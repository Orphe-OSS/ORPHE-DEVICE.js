/**
 * InsoleGait — 歩容解析のリアルタイム取得（opt-in）。
 *
 * INSOLE の FW（GaitAnalysisCore / StrideAnalyzer）は歩行中の歩容パラメーター
 * （ストライド・立脚期/遊脚期・接地パターン・プロネーション等）を計算し、
 * STEP_ANALYSIS characteristic で公開する。アクティブ状態になると 50Hz で
 * 自動 notify されるため、subscribe するだけでよい（read モード変更は不要）。
 *
 * 使い方:
 *   const gait = new InsoleGait(ble);            // ble は begin() 済み
 *   gait.onGait = (deviceId, row) => { ... };
 *   await gait.start();
 *   ...
 *   await gait.stop();
 */
import { downloadCsv } from '../csv.ts';
import { decodeGaitPacket } from './packet.ts';
import type { GaitMotionPacket, GaitPacket } from './packet.ts';
import { GAIT_CSV_HEADER, GaitAggregator, gaitRowToCsv } from './aggregator.ts';
import type { GaitRow, GaitStepLossInfo, GaitStepLossStats } from './aggregator.ts';


/**
 * InsoleGait が必要とする OrpheCoreInsole の構造的サブセット。
 * OrpheCoreInsole<InsoleSensorFields> をそのまま渡せる（疎結合のための境界）。
 */
export interface GaitHost {
  /** デバイス識別子。コールバックの deviceId に載る */
  readonly id: number;
  /** STEP_ANALYSIS の購読と再接続フックに使う */
  readonly transport: {
    /** 指定キャラクタリスティックの notify を開始する */
    startNotify(uuid: string): Promise<unknown>;
    /** 指定キャラクタリスティックの notify を停止する */
    stopNotify(uuid: string): Promise<unknown>;
    /** 自動再接続の成功後に呼ばれるフックを登録する（戻り値を呼ぶと解除） */
    addAfterReconnectSuccessHook(hook: () => unknown): () => void;
    /** 切断時に呼ばれるフックを登録する（戻り値を呼ぶと解除） */
    addDisconnectHook(hook: (event: unknown) => void): () => void;
  };
  /** 接続中なら true */
  isConnected(): boolean;
  /** STEP_ANALYSIS の notify を横取りする。戻り値を呼ぶと解除 */
  setNotifySink(uuid: string, sink: (value: DataView) => void): () => void;
  /** 解析中に起きた例外を上位へ通知する */
  reportError(error: unknown): void;
}


// ── メインクラス ─────────────────────────────────────────────────────
/** notify を 1 件受け取るたびに {@link InsoleGait.onTransport} へ渡る観測値。 */
export interface GaitTransportInfo {
  /** 受信時刻（`Date.now()`） */
  receivedAt: number;
  /** 受信バイト数 */
  byteLength: number;
  /** 先頭バイト（歩容解析パケットなら 51） */
  header: number | null;
  /** サブヘッダー */
  subheader: number | null;
  /** 歩容解析パケットとしてデコードできたか */
  valid: boolean;
  /** ここまでの notify 総数 */
  transportNotifications: number;
  /** ここまでの有効パケット数 */
  validPackets: number;
  /** ここまでの無効パケット数 */
  invalidPackets: number;
}

/** {@link InsoleGait.diagnostics} が返す観測状態の snapshot。 */
export interface GaitDiagnostics {
  /** start() 済みか */
  running: boolean;
  /** STEP_ANALYSIS を購読できているか */
  subscribed: boolean;
  /** 受け取った notify の総数 */
  transportNotifications: number;
  /** 有効パケット数 */
  validPackets: number;
  /** 無効パケット数 */
  invalidPackets: number;
  /** 最後に notify を受けた時刻 */
  lastTransportAt: number | null;
  /** 最後に有効パケットを受けた時刻 */
  lastValidPacketAt: number | null;
  /** 最後の notify の観測値 */
  lastTransport: GaitTransportInfo | null;
  /** 歩の損失統計 */
  stepLoss: GaitStepLossStats;
}

/**
 * 歩容解析のリアルタイム取得。begin() 済みの OrpheCoreInsole（insoleProfile）を渡して使う。
 * STEP_ANALYSIS の notify は setNotifySink で横取りし、通常のセンサー配送
 * （周波数計測・parse）には流さない。1つの OrpheCoreInsole に対して active な
 * InsoleGait は同時に1つ（多重 start は失敗する）。
 */
export class InsoleGait {
  /** 解析対象のデバイス（begin() 済みの OrpheCoreInsole） */
  readonly ble: GaitHost;
  /**
   * サブパケットを歩単位にまとめる集約器
   *
   * @internal
   */
  aggregator = new GaitAggregator();
  /** 完成した歩容パラメーター（CSV 出力用） */
  rows: GaitRow[] = [];

  // コールバック（ユーザが上書き）
  /** 1歩ぶんが揃うたびに呼ばれる */
  onGait: ((deviceId: number, row: GaitRow) => void) | null = null;
  /** motion パケット（姿勢・変位の連続ストリーム）が届くたびに呼ばれる */
  onMotion: ((deviceId: number, motion: GaitMotionPacket) => void) | null = null;
  /** デコードできたサブパケットをそのまま流す（種別を問わない） */
  onRaw: ((deviceId: number, packet: GaitPacket) => void) | null = null;
  /** notify を受け取るたびの観測値（購読の生死を診断する用） */
  onTransport: ((deviceId: number, info: GaitTransportInfo) => void) | null = null;
  /** 購読の再開・タイムアウトなど内部イベントの通知 */
  onDiagnostic: ((deviceId: number, info: { type: string } & Record<string, unknown>) => void) | null = null;
  /** 歩の損失が確定したときの通知 */
  onStepLoss: ((deviceId: number, info: GaitStepLossInfo) => void) | null = null;
  /** 解析中に起きた例外の通知 */
  onError: ((error: unknown) => void) | null = null;

  private running = false;
  private subscribed = false;
  private lifecycle: Promise<unknown> = Promise.resolve();
  private removeSink: (() => void) | null = null;
  private removeReconnectHook: (() => void) | null = null;
  private removeDisconnectHook: (() => void) | null = null;

  private transportNotifications = 0;
  private validPackets = 0;
  private invalidPackets = 0;
  private lastTransportAt: number | null = null;
  private lastValidPacketAt: number | null = null;
  private lastTransport: GaitTransportInfo | null = null;
  private packetWaiters = new Set<{ afterCount: number; resolve: (v: boolean) => void; timer: ReturnType<typeof setTimeout> | null }>();
  private reportedInvalidSignatures = new Set<string>();

  constructor(ble: GaitHost) {
    this.ble = ble;
    this.attachAggregatorHooks();
  }

  /** デバイス識別子。 */
  get deviceId(): number {
    return this.ble.id;
  }

  /** これまでに完成した歩数（{@link rows} の件数）。 */
  get stepCount(): number {
    return this.rows.length;
  }

  /** 解析中なら true。 */
  get isRunning(): boolean {
    return this.running;
  }

  /**
   * 集約結果と診断カウンタを捨てて初期状態へ戻す。
   * 解析中は何も変更しない（stop() してから呼ぶこと）。
   */
  reset(): void {
    if (this.running) return;
    this.aggregator = new GaitAggregator();
    this.attachAggregatorHooks();
    this.rows = [];
    this.transportNotifications = 0;
    this.validPackets = 0;
    this.invalidPackets = 0;
    this.lastTransportAt = null;
    this.lastValidPacketAt = null;
    this.lastTransport = null;
    this.reportedInvalidSignatures.clear();
  }

  /** STEP_ANALYSIS transport の観測状態（購読成功と実データ到着を分けて診断する） */
  diagnostics(): GaitDiagnostics {
    return {
      running: this.running,
      subscribed: this.subscribed,
      transportNotifications: this.transportNotifications,
      validPackets: this.validPackets,
      invalidPackets: this.invalidPackets,
      lastTransportAt: this.lastTransportAt,
      lastValidPacketAt: this.lastValidPacketAt,
      lastTransport: this.lastTransport ? { ...this.lastTransport } : null,
      stepLoss: this.aggregator.stats(),
    };
  }

  /**
   * 指定時点より後の有効 packet を待つ。「購読開始＝受信成功」と誤認しないために使う。
   * @returns timeout 前に有効 packet が到着したら true
   */
  waitForPacket(options: { afterCount?: number; timeoutMs?: number } = {}): Promise<boolean> {
    const afterCount = Number.isFinite(Number(options.afterCount)) ? Number(options.afterCount) : this.validPackets;
    const timeoutMs = Number.isFinite(Number(options.timeoutMs)) ? Math.max(0, Number(options.timeoutMs)) : 1200;
    if (this.validPackets > afterCount) return Promise.resolve(true);
    if (!this.running || !this.subscribed || timeoutMs === 0) return Promise.resolve(false);
    return new Promise((resolve) => {
      const waiter = { afterCount, resolve, timer: null as ReturnType<typeof setTimeout> | null };
      waiter.timer = setTimeout(() => {
        if (!this.packetWaiters.delete(waiter)) return;
        this.emitDiagnostic('packet-timeout', { afterCount, timeoutMs });
        resolve(false);
      }, timeoutMs);
      this.packetWaiters.add(waiter);
      // waiter 登録直前に packet が到着した競合を閉じる
      if (this.validPackets > afterCount) this.resolvePacketWaiters(true);
    });
  }

  /**
   * 歩容解析の notify を開始する（begin() 済みであること）。
   * start()/stop() は直列化され、交錯しても最終状態が確定する。
   * @returns 開始できたら true
   */
  start(): Promise<boolean> {
    return this.enqueue(() => this.doStart());
  }

  /** 歩容解析の notify を停止する */
  stop(): Promise<void> {
    return this.enqueue(() => this.doStop());
  }

  /**
   * STEP_ANALYSIS をいったん停止して再購読する。FIFO の読み取りモード切替で
   * FW 側の通知が止まった場合に使う。aggregator / rows は維持する。
   */
  refreshSubscription(): Promise<boolean> {
    return this.enqueue(() => this.doRefresh());
  }

  // ── CSV 出力 ───────────────────────────────────────────────────────
  /** これまでの {@link rows} をヘッダー行付きの CSV 文字列にする。 */
  toCSV(): string {
    const lines = [GAIT_CSV_HEADER];
    for (const row of this.rows) lines.push(gaitRowToCsv(row));
    return lines.join('\n') + '\n';
  }

  /** ブラウザで CSV をダウンロードする */
  download(filename = 'orphe-insole-gait.csv'): void {
    downloadCsv(this.toCSV(), filename);
  }

  // ── 内部 ───────────────────────────────────────────────────────────
  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.lifecycle.then(operation, operation);
    this.lifecycle = next.catch(() => {});
    return next;
  }

  private async doStart(): Promise<boolean> {
    if (this.running && this.subscribed) return true;
    if (!this.ble.isConnected()) {
      this.reportError(new Error('InsoleGait.start(): insole is not connected'));
      return false;
    }
    if (!this.running) {
      this.aggregator = new GaitAggregator();
      this.attachAggregatorHooks();
      this.rows = [];
    }
    if (!this.removeSink) {
      try {
        // 同じ OrpheCoreInsole に別の InsoleGait が active な場合はここで失敗する
        this.removeSink = this.ble.setNotifySink('STEP_ANALYSIS', (value) => this.onPacket(value));
      } catch (error) {
        this.reportError(error);
        return false;
      }
    }
    this.running = true;
    this.removeReconnectHook ??= this.ble.transport.addAfterReconnectSuccessHook(() => this.onReconnected());
    this.removeDisconnectHook ??= this.ble.transport.addDisconnectHook(() => this.onPhysicalDisconnect());

    const ok = await this.subscribe();
    if (!ok && !this.subscribed) {
      this.running = false;
      this.removeHooks();
    }
    return ok;
  }

  private async doStop(): Promise<void> {
    const wasSubscribed = this.subscribed;
    const wasRunning = this.running || wasSubscribed;
    this.running = false;
    this.subscribed = false;
    this.removeHooks();
    this.resolvePacketWaiters(false);
    if (!wasRunning) return;
    if (wasSubscribed && this.ble.isConnected()) {
      try {
        await this.ble.transport.stopNotify('STEP_ANALYSIS');
      } catch {
        /* noop */
      }
    }
  }

  private async doRefresh(): Promise<boolean> {
    if (!this.running) return false;
    const wasSubscribed = this.subscribed;
    this.subscribed = false;
    if (wasSubscribed && this.ble.isConnected()) {
      try {
        await this.ble.transport.stopNotify('STEP_ANALYSIS');
      } catch (error) {
        this.reportError(error);
      }
    }
    if (!this.running) return false;
    return this.subscribe();
  }

  private async subscribe(): Promise<boolean> {
    try {
      await this.ble.transport.startNotify('STEP_ANALYSIS');
      if (!this.running) return false;
      this.subscribed = true;
      this.emitDiagnostic('subscription-started');
      return true;
    } catch (error) {
      if (this.running) this.reportError(error);
      return false;
    }
  }

  // 再接続成功（begin 再実行）後、STEP_ANALYSIS は再購読が必要
  private async onReconnected(): Promise<void> {
    if (!this.running || this.subscribed) return;
    await this.enqueue(async () => {
      if (!this.running || this.subscribed) return;
      await this.subscribe();
    });
  }

  private onPhysicalDisconnect(): void {
    this.subscribed = false;
    this.resolvePacketWaiters(false);
    this.emitDiagnostic('physical-disconnect');
  }

  private removeHooks(): void {
    this.removeSink?.();
    this.removeSink = null;
    this.removeReconnectHook?.();
    this.removeReconnectHook = null;
    this.removeDisconnectHook?.();
    this.removeDisconnectHook = null;
  }

  private onPacket(dv: DataView): void {
    const receivedAt = Date.now();
    const byteLength = dv.byteLength;
    const header = byteLength > 0 ? dv.getUint8(0) : null;
    const subheader = byteLength > 1 ? dv.getUint8(1) : null;
    this.transportNotifications++;
    this.lastTransportAt = receivedAt;
    let packet: GaitPacket | null = null;
    try {
      packet = decodeGaitPacket(dv);
    } catch (error) {
      this.reportError(error);
    }
    const info: GaitTransportInfo = {
      receivedAt,
      byteLength,
      header,
      subheader,
      valid: !!packet,
      transportNotifications: this.transportNotifications,
      validPackets: this.validPackets + (packet ? 1 : 0),
      invalidPackets: this.invalidPackets + (packet ? 0 : 1),
    };
    this.lastTransport = info;
    if (this.onTransport) this.safe(() => this.onTransport!(this.deviceId, { ...info }));
    if (!packet) {
      this.invalidPackets++;
      const signature = `${byteLength}:${header}:${subheader}`;
      if (!this.reportedInvalidSignatures.has(signature)) {
        this.reportedInvalidSignatures.add(signature);
        this.emitDiagnostic('invalid-packet', { byteLength, header, subheader });
      }
      return;
    }
    this.validPackets++;
    this.lastValidPacketAt = receivedAt;
    if (this.validPackets === 1) {
      this.emitDiagnostic('first-valid-packet', { byteLength, header, subheader, packetType: packet.type });
    }
    this.resolvePacketWaiters(true);
    if (this.onRaw) this.safe(() => this.onRaw!(this.deviceId, packet!));
    if (packet.type === 'motion') {
      if (this.onMotion) this.safe(() => this.onMotion!(this.deviceId, packet as GaitMotionPacket));
      return;
    }
    const row = this.aggregator.add(packet);
    if (row) {
      this.rows.push(row);
      if (this.onGait) this.safe(() => this.onGait!(this.deviceId, row));
    }
  }

  // aggregator の損失通知を onStepLoss / onDiagnostic('step-loss') へ配線する。
  // aggregator は start() のリセットで作り直されるため、そのたびに呼ぶ。
  private attachAggregatorHooks(): void {
    this.aggregator.onStepLoss = (info) => {
      if (this.onStepLoss) this.safe(() => this.onStepLoss!(this.deviceId, { ...info }));
      this.emitDiagnostic('step-loss', info);
    };
  }

  private resolvePacketWaiters(packetArrived: boolean): void {
    for (const waiter of [...this.packetWaiters]) {
      if (packetArrived && this.validPackets <= waiter.afterCount) continue;
      this.packetWaiters.delete(waiter);
      if (waiter.timer) clearTimeout(waiter.timer);
      waiter.resolve(packetArrived);
    }
  }

  private emitDiagnostic(type: string, detail: Record<string, unknown> = {}): void {
    if (!this.onDiagnostic) return;
    this.safe(() => this.onDiagnostic!(this.deviceId, { type, ...detail, diagnostics: this.diagnostics() }));
  }

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
