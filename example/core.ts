/**
 * ORPHE CORE Sensor Viewer — OrpheDevice + coreProfile() のサンプル。
 *
 *   1. 接続ボタン    … chooser でデバイスを選び、GATT 接続して FW 情報を読む
 *   2. モードが出る  … ble.availableModes（FW のリリース日で絞り込み済み）で作る
 *   3. モードを選ぶ  … begin() で計測開始。接続中の変更は notify の付け替えで即時反映
 *
 * 複数台つなぎたい場合はこのページを台数ぶん開く（SDK 側は 1 インスタンス 1 台）。
 */
import { FifoRecorder, OrpheDevice, coreProfile } from '../src/index.ts';
import type { CoreSensorFields } from '../src/index.ts';

const RAD_TO_DEG = 180 / Math.PI;

/** モード id → 画面に出す名前（SDK の mode.label は英語。ここで日本語に差し替える） */
const MODE_LABELS: Record<string, string> = {
  STEP_ANALYSIS_AND_SENSOR_VALUES: '歩行解析 + センサー値',
  STEP_ANALYSIS: '歩行解析',
  SENSOR_VALUES: 'センサー値',
  FIFO: 'FIFO 収録（ロスレス）',
};

/** モード id → 表示するセクション（要素側は data-modes="all step sensor fifo" で指定） */
const MODE_VIEWS: Record<string, string> = {
  STEP_ANALYSIS_AND_SENSOR_VALUES: 'all',
  STEP_ANALYSIS: 'step',
  SENSOR_VALUES: 'sensor',
  FIFO: 'fifo',
};

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
// 名前が 'CR-' で始まるデバイスも chooser に出す
const profile = coreProfile({ namePrefix: 'CR-' });

const ble = new OrpheDevice({
  profile,
  events: {
    onScan: (deviceName) => { q('[data-device]').textContent = deviceName ?? '(no name)'; },
    onStartNotify: (uuid) => log(`startNotify: ${uuid}`),
    onDisconnect: () => log('切断されました'),
    onReconnectAttempt: (info) => log(`再接続中... ${info.attempt}/${info.maxAttempts}`),
    onReconnectSuccess: (info) => log(`再接続成功 (attempt ${info.attempt})`),
    onReconnectFailed: () => log('自動再接続を諦めました', true),
    onError: (error) => log(`エラー: ${error}`, true),
  },
  log: (message, detail) => {
    console.debug('[CORE]', message, detail ?? '');
    if (debugLogInput.checked) log(`⚙ ${message}${detail !== undefined ? ' ' + JSON.stringify(detail) : ''}`);
  },
});

const latest: Partial<CoreSensorFields> = {};
let lostCount = 0;
ble.on('*', (sample) => Object.assign(latest, sample));
ble.on('lost_data', () => { lostCount += 1; });

// ── FIFO 収録（対応 FW でのみモードに出る） ──
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
    log('FIFO 収録を開始します（リアルタイム表示は停止します）');
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
  fifo.download('orphe-core-fifo.csv');
});

// ── 取得モード ──────────────────────────────────────────────────────
const modeSelect = q<HTMLSelectElement>('[data-mode]');
const modeWrap = q<HTMLElement>('[data-mode-wrap]');
let begun = false;
let sensorNotifyOn = false;
let stepNotifyOn = false;
let switching = false;

/** 接続後に呼ぶ。この FW で使えるモードだけをセレクタに並べる */
function buildModeOptions(): void {
  modeSelect.replaceChildren();
  for (const mode of ble.availableModes) {
    const option = document.createElement('option');
    option.value = mode.id;
    option.textContent = MODE_LABELS[mode.id] ?? mode.label;
    modeSelect.appendChild(option);
  }
  modeWrap.hidden = modeSelect.options.length === 0;
}

modeSelect.addEventListener('change', () => void applyMode());

async function applyMode(): Promise<void> {
  if (switching || ble.connectionState === 'disconnected') return;
  const mode = modeSelect.value;
  switching = true;
  try {
    if (fifo.isRunning && mode !== 'FIFO') await stopFifo();

    // FIFO の応答は SENSOR_VALUES の notify で届くので、begin の type は同じ
    const type = mode === 'FIFO' ? 'SENSOR_VALUES' : mode;
    if (!begun) {
      await ble.begin(type, { autoReconnect: autoReconnectInput.checked });
      begun = true;
      sensorNotifyOn = type !== 'STEP_ANALYSIS';
      stepNotifyOn = type !== 'SENSOR_VALUES';
      log(`begin('${type}') 完了`);
      return;
    }

    // 接続したまま通知の購読を増減する（開始してから不要分を止め、途切れを作らない）
    const wantStep = type === 'STEP_ANALYSIS' || type === 'STEP_ANALYSIS_AND_SENSOR_VALUES';
    const wantSensor = type !== 'STEP_ANALYSIS';
    if (wantSensor && !sensorNotifyOn) { await ble.transport.startNotify('SENSOR_VALUES'); sensorNotifyOn = true; }
    if (wantStep && !stepNotifyOn) { await ble.transport.startNotify('STEP_ANALYSIS'); stepNotifyOn = true; }
    if (!wantSensor && sensorNotifyOn) { await ble.transport.stopNotify('SENSOR_VALUES'); sensorNotifyOn = false; }
    if (!wantStep && stepNotifyOn) { await ble.transport.stopNotify('STEP_ANALYSIS'); stepNotifyOn = false; }
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
    if (fifo.isRunning) await stopFifo(); // モード復帰の write は接続中に済ませる
    ble.stop();
    log('stop()');
    begun = false;
    sensorNotifyOn = false;
    stepNotifyOn = false;
    modeWrap.hidden = true;
    fwEl.textContent = '';
    clearReadings();
  } finally {
    connectButton.disabled = false;
  }
}

/** 接続前と同じ見た目へ戻す（収録データ・表示値をすべて捨てる） */
function clearReadings(): void {
  if (fifo.collectedCount > 0) log(`FIFO 収録データ ${fifo.collectedCount} 件を破棄しました`);
  fifo.reset();
  fifoLag = 0;
  lostCount = 0;
  for (const key of Object.keys(latest)) delete (latest as Record<string, unknown>)[key];
  q('[data-device]').textContent = '';
  cube.style.transform = '';
}

connectButton.addEventListener('click', () => {
  void (ble.connectionState === 'disconnected' ? connect() : disconnect());
});

// ── 描画 ────────────────────────────────────────────────────────────
const cells = [...document.querySelectorAll<HTMLElement>('[data-v]')].map((el) => ({
  el,
  path: (el.dataset['v'] ?? '').split('.'),
}));
const modeEls = [...document.querySelectorAll<HTMLElement>('[data-modes]')];
const stateEl = q<HTMLElement>('[data-state]');
const cube = q<HTMLElement>('[data-cube]');
const acquisitionEl = q<HTMLElement>('[data-acquisition]');
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
              : 'リアルタイム計測中';

  // FIFO パネル（FIFO モード選択中は常時表示。他モードでも収録結果が残る間は表示）
  fifoModule.hidden = view !== 'fifo' && !fifo.isRunning && !fifoStopping && fifo.collectedCount === 0;
  // 切断後は収録の操作ができないので、結果と CSV だけを残す
  q('[data-fifo-title]').textContent = begun ? 'FIFO 収録（ロスレス・収録中はリアルタイム表示が停止）' : 'FIFO 収録結果';
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

  q('[data-freq]').textContent = latest.ble_frequency ? latest.ble_frequency.toFixed(0) : '-';
  q('[data-serial]').textContent = latest.serial_number?.toString() ?? '-';
  q('[data-lost]').textContent = String(lostCount);
  q('[data-steps]').textContent = latest.steps_number?.value.toString() ?? '-';

  for (const { el, path } of cells) {
    let value: unknown = latest;
    for (const key of path) value = (value as Record<string, unknown> | undefined)?.[key];
    el.textContent =
      typeof value !== 'number' ? '' : Number.isInteger(value) ? String(value) : value.toFixed(3);
  }

  if (latest.euler) {
    const { pitch, roll, yaw } = latest.euler;
    cube.style.transform =
      `rotateX(${(-pitch * RAD_TO_DEG).toFixed(1)}deg) ` +
      `rotateY(${(yaw * RAD_TO_DEG).toFixed(1)}deg) ` +
      `rotateZ(${(roll * RAD_TO_DEG).toFixed(1)}deg)`;
  }
}

(function loop() {
  render();
  requestAnimationFrame(loop);
})();
