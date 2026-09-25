/**
 * ORPHE INSOLE Sensor Viewer — OrpheCoreInsole + insoleProfile() のサンプル。
 *
 *   1. 接続ボタン    … chooser でデバイスを選び、GATT 接続して FW 情報を読む
 *   2. モードが出る  … ble.availableModes（FW のリリース日で絞り込み済み）で作る
 *   3. モードを選ぶ  … begin() で計測開始。接続中の変更はその場で切り替わる
 *
 * 複数台つなぎたい場合はこのページを台数ぶん開く（SDK 側は 1 インスタンス 1 台）。
 */
import { FifoRecorder, InsoleGait, OrpheCoreInsole, insoleProfile, insoleStreamingModeOf } from '../src/index.ts';
import type { GaitRow, InsoleSensorFields } from '../src/index.ts';

/** モード id → 画面に出す名前（SDK の mode.label は英語。ここで日本語に差し替える） */
const MODE_LABELS: Record<string, string> = {
  STREAMING_4: 'リアルタイム — 圧力 + IMU + 姿勢',
  STREAMING_3: 'リアルタイム高速 — 圧力 + IMU（姿勢なし）',
  STREAMING_1: 'リアルタイム高速 — IMU + 姿勢（圧力なし）',
  STEP_ANALYSIS: 'リアルタイム + 歩容解析',
  FIFO: 'FIFO 収録 — ロスレス（姿勢なし）',
};

/** モード id → 表示するセクション（要素側は data-modes="full press imu gait fifo" で指定） */
const MODE_VIEWS: Record<string, string> = {
  STREAMING_4: 'full',
  STREAMING_3: 'press',
  STREAMING_1: 'imu',
  STEP_ANALYSIS: 'gait',
  FIFO: 'fifo',
};

/** 歩容解析と FIFO は圧力・IMU・姿勢がすべて要るので mode 4 をベースにする */
const BASE_STREAMING_MODE = 4;

const q = <T extends Element>(selector: string): T => {
  const el = document.querySelector<T>(selector);
  if (!el) throw new Error(`element not found: ${selector}`);
  return el;
};

const logEl = q<HTMLDivElement>('[data-log]');
const log = (message: string, isWarn = false) => {
  const line = document.createElement('div');
  if (isWarn) line.className = 'warn';
  line.textContent = `${new Date().toLocaleTimeString()}  ${message}`;
  logEl.appendChild(line);
  while (logEl.childElementCount > 100) logEl.firstElementChild?.remove();
  logEl.scrollTop = logEl.scrollHeight;
};

const debugLogInput = document.getElementById('shared-debug') as HTMLInputElement;
const autoReconnectInput = document.getElementById('shared-reconnect') as HTMLInputElement;

// ── デバイス ────────────────────────────────────────────────────────
const profile = insoleProfile();

const ble = new OrpheCoreInsole({
  profile,
  events: {
    onScan: (deviceName) => { q('[data-device]').textContent = deviceName ?? '(no name)'; },
    onStartNotify: (uuid) => log(`startNotify: ${uuid}`),
    onDisconnect: () => { log('切断されました'); markDisconnected(); },
    onReconnectAttempt: (info) => log(`再接続中... ${info.attempt}/${info.maxAttempts}`),
    onReconnectSuccess: (info) => { log(`再接続成功 (attempt ${info.attempt})`); void resumeAfterReconnect(); },
    onReconnectFailed: () => log('自動再接続を諦めました', true),
    onError: (error) => log(`エラー: ${error}`, true),
  },
  log: (message, detail) => {
    console.debug('[INSOLE]', message, detail ?? '');
    if (debugLogInput.checked) log(`⚙ ${message}${detail !== undefined ? ' ' + JSON.stringify(detail) : ''}`);
  },
});

const latest: Partial<InsoleSensorFields> = {};
let lostCount = 0;
let pressScale = 2000; // 圧力バーのピークホールド自動スケール
ble.on('*', (sample) => Object.assign(latest, sample));
ble.on('lost_data', () => { lostCount += 1; });

const mountEl = q<HTMLElement>('[data-mount]');
function showDeviceInformation(): void {
  const info = profile.device_information;
  if (!info) return;
  q('[data-battery]').textContent = ['low', 'mid', 'full'][info.battery] ?? String(info.battery);
  mountEl.textContent = (info.mount_position & 1) === 0 ? 'L' : 'R';
  mountEl.hidden = false;
}

// ── 歩容解析（InsoleGait: STEP_ANALYSIS を購読し1歩ごとに集約） ──
const gait = new InsoleGait(ble);
let lastGaitRow: GaitRow | null = null;
gait.onGait = (_id, row) => { lastGaitRow = row; };
gait.onError = (error) => log(`歩容解析エラー: ${error}`, true);
q<HTMLButtonElement>('[data-gait-csv]').addEventListener('click', () => {
  gait.download('orphe-insole-gait.csv');
});

// ── FIFO 収録（FifoRecorder: ロスレス回収） ──
const fifo = new FifoRecorder(ble);
let fifoLag = 0;
let fifoStarting = false;
let fifoStopping = false;
fifo.onProgress = (info) => { fifoLag = info.lag; };
fifo.onDataLoss = (info) => log(`FIFO 欠損 ${info.dropped}（累計 ${info.cumulative}・${info.reason}）`, true);
fifo.onStopped = (info) => log(`FIFO 停止（${info.reason}）: collected ${info.collected} / dropped ${info.dropped}`);
fifo.onError = (error) => log(`FIFO エラー: ${error}`, true);

async function startFifo(): Promise<void> {
  if (!begun || fifo.isRunning || fifoStarting || fifoStopping) return;
  fifoStarting = true;
  try {
    log('FIFO 収録を開始します（リアルタイム配信は停止します）');
    if (!(await fifo.start())) log('FIFO 収録を開始できませんでした', true);
  } catch (error) {
    log(`FIFO 操作失敗: ${error}`, true);
  } finally {
    fifoStarting = false;
  }
}

async function stopFifo(): Promise<void> {
  if (!fifo.isRunning || fifoStopping) return;
  fifoStopping = true;
  try {
    log('FIFO 収録を停止して回収中…');
    await fifo.stop();
    log('リアルタイム計測に復帰');
  } catch (error) {
    log(`FIFO 操作失敗: ${error}`, true);
  } finally {
    fifoStopping = false;
  }
}

q<HTMLButtonElement>('[data-fifo-toggle]').addEventListener('click', () => {
  void (fifo.isRunning ? stopFifo() : startFifo());
});
q<HTMLButtonElement>('[data-fifo-csv]').addEventListener('click', () => {
  fifo.download('orphe-insole-fifo.csv');
});

// ── 取得モード ──────────────────────────────────────────────────────
const modeSelect = q<HTMLSelectElement>('[data-mode]');
const modeWrap = q<HTMLElement>('[data-mode-wrap]');
let begun = false;
let switching = false;

/** 切断されたら計測前の状態に戻す（手動で再接続したときは begin() からやり直す） */
function markDisconnected(): void {
  begun = false;
}

/** 自動再接続は最初の begin() の streamingMode に戻るので、選択中のモードを当て直す */
async function resumeAfterReconnect(): Promise<void> {
  begun = true;
  await applyMode();
}

/** 接続後に呼ぶ。この FW で使えるモードだけをセレクタに並べる */
function buildModeOptions(): void {
  const selected = modeSelect.value; // 手動で再接続したときは前回のモードを引き継ぐ
  modeSelect.replaceChildren();
  for (const mode of ble.availableModes) {
    const option = document.createElement('option');
    option.value = mode.id;
    option.textContent = MODE_LABELS[mode.id] ?? mode.label;
    modeSelect.appendChild(option);
  }
  if ([...modeSelect.options].some((option) => option.value === selected)) modeSelect.value = selected;
  modeWrap.hidden = modeSelect.options.length === 0;
}

modeSelect.addEventListener('change', () => void applyMode());

async function applyMode(): Promise<void> {
  if (switching || ble.connectionState !== 'connected') return;
  const mode = modeSelect.value;
  const streamingMode = insoleStreamingModeOf(mode) ?? BASE_STREAMING_MODE;
  switching = true;
  try {
    // 排他: 選択から外れたものを先に止める
    if (fifo.isRunning && mode !== 'FIFO') await stopFifo();
    if (gait.isRunning && mode !== 'STEP_ANALYSIS') {
      await gait.stop();
      log('歩容解析を停止しました');
    }

    if (!begun) {
      await ble.begin('SENSOR_VALUES', { streamingMode, autoReconnect: autoReconnectInput.checked });
      begun = true;
      log('begin() 完了');
      showDeviceInformation();
    } else if (!fifo.isRunning) {
      await profile.setDataStreamingMode(ble.transport, streamingMode);
      log('リアルタイム計測に切替');
    }

    if (mode === 'STEP_ANALYSIS' && !gait.isRunning) {
      lastGaitRow = null;
      if (await gait.start()) {
        log('歩容解析を開始しました（歩くと1歩ごとに集約されます）');
        if (!(await gait.waitForPacket({ timeoutMs: 1500 }))) {
          log('STEP_ANALYSIS の通知が届いていません（FW 未対応の可能性）', true);
        }
      } else {
        log('歩容解析を開始できませんでした', true);
      }
    }
    // FIFO の収録開始はパネルの「収録開始」ボタンで行う（モード選択は準備まで）
  } catch (error) {
    log(`モード切替失敗: ${error}`, true);
  } finally {
    switching = false;
  }
}

// ── 接続 ────────────────────────────────────────────────────────────
const connectButton = q<HTMLButtonElement>('[data-connect]');
const fwEl = q<HTMLElement>('[data-fw]');

async function connect(): Promise<void> {
  connectButton.disabled = true;
  try {
    // begin() より先に FW を読む。使えるモードがこの時点で確定する
    const firmware = await ble.readFirmwareInfo();
    // readFirmwareInfo() は失敗しても null を返すだけなので、接続の成否は別に見る
    if (!ble.isConnected()) throw new Error('デバイスに接続できませんでした');
    fwEl.textContent = firmware
      ? `FW リリース日 ${firmware.releasedAt.toLocaleDateString()}`
      : 'FW 情報を取得できませんでした（モードは絞り込みません）';
    buildModeOptions();
    await applyMode();
  } catch (error) {
    log(`接続失敗: ${error}`, true);
  } finally {
    connectButton.disabled = false;
  }
}

async function disconnect(): Promise<void> {
  connectButton.disabled = true;
  try {
    // 収録・解析を後始末してから切断する（teardown は接続が必要）
    if (fifo.isRunning) await stopFifo();
    if (gait.isRunning) await gait.stop();
    ble.stop();
    log('stop()');
    markDisconnected();
    modeWrap.hidden = true;
    fwEl.textContent = '';
    clearReadings();
  } finally {
    connectButton.disabled = false;
  }
}

/** 接続前と同じ見た目へ戻す（収録データ・解析結果・表示値をすべて捨てる） */
function clearReadings(): void {
  if (fifo.collectedCount > 0) log(`FIFO 収録データ ${fifo.collectedCount} 件を破棄しました`);
  if (gait.stepCount > 0) log(`歩容解析 ${gait.stepCount} 歩ぶんを破棄しました`);
  fifo.reset();
  gait.reset();
  fifoLag = 0;
  lostCount = 0;
  lastGaitRow = null;
  pressScale = 2000;
  for (const key of Object.keys(latest)) delete (latest as Record<string, unknown>)[key];
  for (const bar of bars) bar.style.height = '0%';
  for (const val of vals) val.textContent = '-';
  q('[data-device]').textContent = '';
  mountEl.hidden = true;
  q('[data-battery]').textContent = '-';
}

connectButton.addEventListener('click', () => {
  void (ble.connectionState === 'disconnected' ? connect() : disconnect());
});

// ── 描画 ────────────────────────────────────────────────────────────
const bars = [...document.querySelectorAll<HTMLElement>('[data-bar]')];
const vals = [...document.querySelectorAll<HTMLElement>('[data-val]')];
const cells = [...document.querySelectorAll<HTMLElement>('[data-v]')].map((el) => ({
  el,
  path: (el.dataset['v'] ?? '').split('.'),
}));
const modeEls = [...document.querySelectorAll<HTMLElement>('[data-modes]')];
const stateEl = q<HTMLElement>('[data-state]');
const acquisitionEl = q<HTMLElement>('[data-acquisition]');
const gaitModule = q<HTMLElement>('[data-gait-module]');
const fifoModule = q<HTMLElement>('[data-fifo-module]');
let appliedView = '';

function render(): void {
  const state = ble.connectionState;
  stateEl.textContent = state;
  stateEl.className = `badge ${state}`;
  connectButton.textContent = state === 'disconnected' ? '接続' : '切断';

  const view = !begun ? '' : fifo.isRunning || fifoStopping ? 'fifo' : (MODE_VIEWS[modeSelect.value] ?? '');
  if (view !== appliedView) {
    appliedView = view;
    for (const el of modeEls) el.hidden = !(el.dataset['modes'] ?? '').split(' ').includes(view);
  }

  acquisitionEl.textContent =
    !begun ? ''
      : switching ? '切替中…'
        : fifo.isRunning ? 'FIFO 収録中'
          : fifoStopping ? 'FIFO 回収中…'
            : modeSelect.value === 'FIFO' ? 'FIFO 待機中'
              : gait.isRunning ? 'リアルタイム + 歩容解析'
                : 'リアルタイム計測中';

  q('[data-freq]').textContent = latest.ble_frequency ? latest.ble_frequency.toFixed(0) : '-';
  q('[data-serial]').textContent = latest.serial_number?.toString() ?? '-';
  q('[data-lost]').textContent = String(lostCount);

  const press = latest.press?.values;
  const newton = latest.converted_press?.values;
  if (press) {
    pressScale = Math.max(pressScale, ...press);
    press.forEach((value, i) => {
      const bar = bars[i];
      const val = vals[i];
      if (bar) bar.style.height = `${Math.min(100, (value / pressScale) * 100).toFixed(1)}%`;
      if (val) val.textContent = newton ? `${value} / ${newton[i]!.toFixed(1)} N` : String(value);
    });
  }

  for (const { el, path } of cells) {
    let value: unknown = latest;
    for (const key of path) value = (value as Record<string, unknown> | undefined)?.[key];
    el.textContent = typeof value === 'number' ? value.toFixed(3) : '';
  }

  // 歩容解析パネル（動作中か、結果が残っている間だけ表示）
  gaitModule.hidden = !gait.isRunning && gait.stepCount === 0;
  q<HTMLButtonElement>('[data-gait-csv]').disabled = gait.stepCount === 0;
  q('[data-gait-steps]').textContent = String(gait.stepCount);
  if (lastGaitRow) {
    q('[data-gait-type]').textContent = lastGaitRow.gait_type;
    q('[data-gait-stride]').textContent = lastGaitRow.stride_norm_m?.toFixed(2) ?? '-';
    q('[data-gait-strike]').textContent = lastGaitRow.foot_strike;
    q('[data-gait-pronation]').textContent = lastGaitRow.pronation_type;
  }
  const stepLoss = gait.diagnostics().stepLoss;
  q('[data-gait-loss]').textContent = String(stepLoss.incompleteSteps + stepLoss.gapSteps);

  // FIFO パネル（FIFO モード選択中は常時表示。他モードでも収録結果が残る間は表示）
  fifoModule.hidden = view !== 'fifo' && !fifo.isRunning && !fifoStopping && fifo.collectedCount === 0;
  // 切断後は収録の操作ができないので、結果と CSV だけを残す
  q('[data-fifo-title]').textContent = begun ? 'FIFO 収録（ロスレス・収録中はリアルタイム配信が停止）' : 'FIFO 収録結果';
  const fifoToggle = q<HTMLButtonElement>('[data-fifo-toggle]');
  fifoToggle.hidden = !begun;
  fifoToggle.textContent = fifo.isRunning ? '停止' : '収録開始';
  fifoToggle.disabled = fifoStarting || fifoStopping;
  q<HTMLButtonElement>('[data-fifo-csv]').disabled = fifo.collectedCount === 0;
  q('[data-fifo-collected]').textContent = String(fifo.collectedCount);
  q('[data-fifo-lag]').textContent = String(fifoLag);
  q('[data-fifo-dropped]').textContent = String(fifo.droppedCount);
  q('[data-fifo-phase]').textContent =
    fifoStopping ? '回収中…' : fifo.isRunning ? '収録中' : fifo.collectedCount > 0 ? '収録済み' : '待機中';
}

(function loop() {
  render();
  requestAnimationFrame(loop);
})();
