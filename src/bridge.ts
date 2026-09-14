/**
 * BleSharedBridge — 複数のブラウザタブ間で BLE 接続を共有するブリッジ。
 *
 * 仕組み:
 *   - Primary tab   : BLE接続を保持し、センサーデータを BroadcastChannel で配信
 *   - Secondary tab : BLE接続不要。チャネルを購読してデータを受信し、通常の
 *                     got* コールバックをそのまま利用できる
 *
 * Primary検出:
 *   - storage にハートビートを書き込む
 *   - `storage` イベントで他タブの変更を即時検知（ポーリング不要）
 *   - `pagehide` でタブ閉じ時にクリーン通知
 *   - 上記が抜けたケースに備えてポーリングでフォールバック
 */
import type { StorageLike } from './ble/web-bluetooth.ts';

/** BroadcastChannel 相当 */
export interface BridgeChannel {
  /** 他タブからのメッセージ受信ハンドラ */
  onmessage: ((event: { data: unknown }) => void) | null;
  /** 他タブへメッセージを送る */
  postMessage(message: unknown): void;
  /** チャネルを閉じる */
  close(): void;
}

/** ブリッジが依存するブラウザ環境（テストではモックを注入する） */
export interface BridgeEnvironment {
  /** ハートビートの保存先（既定 localStorage） */
  storage: StorageLike;
  /** BroadcastChannel が使えない環境では null を返す */
  createChannel(name: string): BridgeChannel | null;
  /** window の storage / pagehide などを購読する */
  addWindowListener(type: string, listener: (event: unknown) => void): void;
  /** 購読を解除する */
  removeWindowListener(type: string, listener: (event: unknown) => void): void;
}

/**
 * Secondary タブ側の受信ハンドラ。フィールド名（`'acc'` など）をキーにする。
 * 配送されるデータは Primary タブがパースしたサンプルそのもの。
 */
export interface BridgeCallbacks {
  /** Primary タブが消えたときに呼ばれる（リーダー選出のトリガー） */
  onPrimaryLost?: () => void;
  /** フィールド名ごとの受信ハンドラ */
  [callbackName: string]: ((data: unknown) => void) | (() => void) | undefined;
}

/** ハートビートと Primary 検出のタイミング設定。 */
export interface BridgeTimingOptions {
  /** ハートビート書き込み間隔。既定 1000ms */
  heartbeatIntervalMs?: number;
  /** この時間ハートビートが無ければ Primary 喪失。既定 5000ms */
  heartbeatTimeoutMs?: number;
  /** フォールバックポーリング間隔。既定 2000ms */
  watchIntervalMs?: number;
  /** Primary 喪失時のリーダー選出の最大ランダム遅延。既定 1500ms */
  electionMaxDelayMs?: number;
}

// バックグラウンドタブで setInterval が throttle されても誤検知しないよう
// タイムアウトには十分な余裕を持たせる。
const DEFAULT_HEARTBEAT_INTERVAL_MS = 1000;
const DEFAULT_HEARTBEAT_TIMEOUT_MS = 5000;
const DEFAULT_WATCH_INTERVAL_MS = 2000;
const DEFAULT_ELECTION_MAX_DELAY_MS = 1500;

interface BridgeMessage {
  type: 'batch' | 'disconnected';
  deviceId: number;
  batch?: Record<string, unknown>;
}

/** ブラウザのグローバルをそのまま使う既定環境 */
export function defaultBridgeEnvironment(): BridgeEnvironment {
  return {
    storage: localStorage,
    createChannel(name: string): BridgeChannel | null {
      try {
        return new BroadcastChannel(name) as unknown as BridgeChannel;
      } catch (error) {
        console.warn('[BleSharedBridge] BroadcastChannel unavailable:', error);
        return null;
      }
    },
    addWindowListener(type, listener) {
      (globalThis as unknown as { addEventListener(t: string, l: unknown): void }).addEventListener(type, listener);
    },
    removeWindowListener(type, listener) {
      (globalThis as unknown as { removeEventListener(t: string, l: unknown): void }).removeEventListener(type, listener);
    },
  };
}

/**
 * タブ間で BLE 接続を共有するブリッジ。
 * Primary タブが接続を保持し、パース済みサンプルを BroadcastChannel で配る。
 */
export class BleSharedBridge {
  /** 共有対象のデバイス識別子（storage キーとチャネル名に使う） */
  readonly deviceId: number;
  /** このタブが Primary（BLE 接続を保持する側）なら true */
  isPrimary = false;

  /** Primary 喪失時のリーダー選出用最大遅延（SDK 層が利用する） */
  readonly electionMaxDelayMs: number;

  private readonly env: BridgeEnvironment;
  private readonly storageKey: string;
  private readonly channelName: string;
  private readonly tabId: string;
  private readonly heartbeatIntervalMs: number;
  private readonly heartbeatTimeoutMs: number;
  private readonly watchIntervalMs: number;

  private channel: BridgeChannel | null = null;
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private watchInterval: ReturnType<typeof setInterval> | null = null;
  private storageListener: ((event: unknown) => void) | null = null;
  private pagehideListener: ((event: unknown) => void) | null = null;
  private callbacks: BridgeCallbacks = {};
  private primaryLostFired = false;

  constructor(deviceId: number, env: BridgeEnvironment = defaultBridgeEnvironment(), timing: BridgeTimingOptions = {}) {
    this.deviceId = deviceId;
    this.env = env;
    this.storageKey = `orphe_bridge_primary_${deviceId}`;
    this.channelName = `orphe-device-bridge-${deviceId}`;
    this.tabId = `tab_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    this.heartbeatIntervalMs = timing.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
    this.heartbeatTimeoutMs = timing.heartbeatTimeoutMs ?? DEFAULT_HEARTBEAT_TIMEOUT_MS;
    this.watchIntervalMs = timing.watchIntervalMs ?? DEFAULT_WATCH_INTERVAL_MS;
    this.electionMaxDelayMs = timing.electionMaxDelayMs ?? DEFAULT_ELECTION_MAX_DELAY_MS;
  }

  // ─── Primary 検出 ───────────────────────────────────────────

  /** 別タブに有効な Primary が存在するか */
  isRemotePrimaryAvailable(): boolean {
    try {
      const raw = this.env.storage.getItem(this.storageKey);
      if (!raw) return false;
      const { timestamp, tabId } = JSON.parse(raw) as { timestamp: number; tabId: string };
      return tabId !== this.tabId && Date.now() - timestamp < this.heartbeatTimeoutMs;
    } catch {
      return false;
    }
  }

  // ─── Primary モード ──────────────────────────────────────────

  /** このタブを Primary として登録し、BroadcastChannel を開く */
  claimPrimary(): void {
    this.isPrimary = true;
    this.openChannel();
    this.updateHeartbeat();
    this.heartbeatInterval = setInterval(() => this.updateHeartbeat(), this.heartbeatIntervalMs);

    // タブが閉じられたときに自分のエントリを即時除去する
    this.pagehideListener = () => {
      this.cleanupOwnPrimaryEntry();
      this.send({ type: 'disconnected', deviceId: this.deviceId });
    };
    this.env.addWindowListener('pagehide', this.pagehideListener);
  }

  /** 複数のコールバック呼び出しを1メッセージにまとめてブロードキャストする */
  broadcastBatch(batch: Record<string, unknown>): void {
    if (!this.isPrimary || !this.channel) return;
    this.send({ type: 'batch', deviceId: this.deviceId, batch });
  }

  /** 単一コールバックをブロードキャストする（broadcastBatch の単一キー版） */
  broadcast(callbackName: string, data: unknown): void {
    this.broadcastBatch({ [callbackName]: data });
  }

  /** 切断を全タブへ通知し、Primary リソースを解放する */
  broadcastDisconnect(): void {
    this.send({ type: 'disconnected', deviceId: this.deviceId });
    this.release();
  }

  // ─── Secondary モード ────────────────────────────────────────

  /** このタブを Secondary として BroadcastChannel を購読する */
  subscribeAsSecondary(callbacks: BridgeCallbacks): void {
    this.isPrimary = false;
    this.callbacks = callbacks;
    this.openChannel();
    if (this.channel) {
      this.channel.onmessage = (event) => this.handleMessage(event.data);
    }

    // storage イベントは同一オリジンの他タブの storage 変更を即時検知する
    this.storageListener = (event) => {
      const e = event as { key?: string; newValue?: string | null };
      if (e.key !== this.storageKey) return;
      if (e.newValue === null) this.firePrimaryLost();
    };
    this.env.addWindowListener('storage', this.storageListener);

    // フォールバックポーリング（heartbeat タイムアウト用）
    this.watchInterval = setInterval(() => {
      if (!this.isRemotePrimaryAvailable()) this.firePrimaryLost();
    }, this.watchIntervalMs);
  }

  // ─── 共通 ────────────────────────────────────────────────────

  /** すべてのリソースを解放する */
  release(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
    if (this.watchInterval) {
      clearInterval(this.watchInterval);
      this.watchInterval = null;
    }
    if (this.storageListener) {
      this.env.removeWindowListener('storage', this.storageListener);
      this.storageListener = null;
    }
    if (this.pagehideListener) {
      this.env.removeWindowListener('pagehide', this.pagehideListener);
      this.pagehideListener = null;
    }
    if (this.isPrimary) this.cleanupOwnPrimaryEntry();
    if (this.channel) {
      try { this.channel.close(); } catch { /* noop */ }
      this.channel = null;
    }
    this.isPrimary = false;
  }

  // ─── 内部メソッド ─────────────────────────────────────────────

  private openChannel(): void {
    if (this.channel) return;
    this.channel = this.env.createChannel(this.channelName);
  }

  private send(message: BridgeMessage): void {
    try { this.channel?.postMessage(message); } catch { /* noop */ }
  }

  private updateHeartbeat(): void {
    try {
      this.env.storage.setItem(this.storageKey, JSON.stringify({
        timestamp: Date.now(),
        tabId: this.tabId,
      }));
    } catch { /* noop */ }
  }

  /**
   * storage から自分の Primary エントリのみを削除する
   * （他タブが既に Primary を奪取している場合は何もしない）
   */
  private cleanupOwnPrimaryEntry(): void {
    try {
      const raw = this.env.storage.getItem(this.storageKey);
      if (!raw) return;
      const { tabId } = JSON.parse(raw) as { tabId: string };
      if (tabId === this.tabId) this.env.storage.removeItem(this.storageKey);
    } catch { /* noop */ }
  }

  private handleMessage(message: unknown): void {
    const msg = message as BridgeMessage | null;
    if (!msg || msg.deviceId !== this.deviceId) return;

    if (msg.type === 'batch' && msg.batch) {
      for (const name in msg.batch) {
        const callback = this.callbacks[name];
        if (typeof callback === 'function') (callback as (data: unknown) => void)(msg.batch[name]);
      }
    } else if (msg.type === 'disconnected') {
      this.firePrimaryLost();
    }
  }

  /** onPrimaryLost を1回だけ発火する（重複検知してもループしない） */
  private firePrimaryLost(): void {
    if (this.primaryLostFired) return;
    this.primaryLostFired = true;

    // Secondary の監視はもう不要
    if (this.watchInterval) {
      clearInterval(this.watchInterval);
      this.watchInterval = null;
    }

    const callback = this.callbacks.onPrimaryLost;
    if (typeof callback === 'function') callback();
  }
}
