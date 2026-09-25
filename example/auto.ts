/**
 * ORPHE CORE / INSOLE Auto Profile — OrpheCoreInsole + autoProfile() のサンプル。
 *
 *   1. 接続ボタン    … chooser に CORE と INSOLE の両方が出る。readFirmwareInfo() で
 *                      選んだデバイスの名前から CORE / INSOLE を判別し、FW 情報を読む
 *   2. モードが出る  … ble.availableModes（判別した種別のモードを FW で絞り込み済み）で作る
 *   3. モードを選ぶ  … begin() で計測開始。接続中の変更はその場で切り替わる
 *
 * 表示は共通の IMU に加えて、INSOLE なら圧力、CORE なら歩数を出す。
 * FIFO 収録と歩容解析は core.html / insole.html を参照（ここではリアルタイム計測だけを扱う）。
 *
 * 複数台つなぎたい場合はこのページを台数ぶん開く（SDK 側は 1 インスタンス 1 台）。
 */
import { OrpheCoreInsole, autoProfile, insoleStreamingModeOf } from '../src/index.ts';
import type { AutoSensorFields } from '../src/index.ts';

/** モード id → 画面に出す名前。ここに無いモード（FIFO・歩容解析）はセレクタに出さない */
const MODE_LABELS: Record<string, string> = {
  // CORE
  STEP_ANALYSIS_AND_SENSOR_VALUES: '歩行解析 + センサー値',
  STEP_ANALYSIS: '歩行解析',
  SENSOR_VALUES: 'センサー値',
  // INSOLE
  STREAMING_4: 'リアルタイム — 圧力 + IMU + 姿勢',
  STREAMING_3: 'リアルタイム高速 — 圧力 + IMU（姿勢なし）',
  STREAMING_1: 'リアルタイム高速 — IMU + 姿勢（圧力なし）',
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
// 名前が 'CR-' で始まる CORE も chooser に出す（INSOLE は 'INS' の名前で出る）
const profile = autoProfile({ core: { namePrefix: 'CR-' } });

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
    console.debug('[AUTO]', message, detail ?? '');
    if (debugLogInput.checked) log(`⚙ ${message}${detail !== undefined ? ' ' + JSON.stringify(detail) : ''}`);
  },
});

const latest: Partial<AutoSensorFields> = {};
let lostCount = 0;
let pressScale = 2000; // 圧力バーのピークホールド自動スケール
let begun = false;
ble.on('*', (sample) => Object.assign(latest, sample));
ble.on('lost_data', () => { lostCount += 1; });

// ── 取得モード ──────────────────────────────────────────────────────
const modeSelect = q<HTMLSelectElement>('[data-mode]');
const modeWrap = q<HTMLElement>('[data-mode-wrap]');
let begunType = ''; // CORE の最初の begin() の type。SDK は自動再接続でこれを再実行する
let sensorNotifyOn = false;
let stepNotifyOn = false;
let switching = false;

/** 切断されたら計測前の状態に戻す（手動で再接続したときは begin() からやり直す） */
function markDisconnected(): void {
  begun = false;
  sensorNotifyOn = false;
  stepNotifyOn = false;
}

/** 自動再接続は最初の begin() を再実行するので、その状態に戻してから選択中のモードを当て直す */
async function resumeAfterReconnect(): Promise<void> {
  begun = true;
  if (profile.kind === 'core') {
    sensorNotifyOn = begunType !== 'STEP_ANALYSIS';
    stepNotifyOn = begunType !== 'SENSOR_VALUES';
  }
  await applyMode();
}

/** 接続後に呼ぶ。判別した種別・FW で使えるモードだけをセレクタに並べる */
function buildModeOptions(): void {
  const selected = modeSelect.value; // 手動で再接続したときは前回のモードを引き継ぐ
  modeSelect.replaceChildren();
  for (const mode of ble.availableModes) {
    const label = MODE_LABELS[mode.id];
    if (!label) continue;
    const option = document.createElement('option');
    option.value = mode.id;
    option.textContent = label;
    modeSelect.appendChild(option);
  }
  if ([...modeSelect.options].some((option) => option.value === selected)) modeSelect.value = selected;
  modeWrap.hidden = modeSelect.options.length === 0;
}

modeSelect.addEventListener('change', () => void applyMode());

async function applyMode(): Promise<void> {
  if (switching || ble.connectionState !== 'connected') return;
  switching = true;
  try {
    if (profile.kind === 'insole') await applyInsoleMode(modeSelect.value);
    else await applyCoreMode(modeSelect.value);
  } catch (error) {
    log(`モード切替失敗: ${error}`, true);
  } finally {
    switching = false;
  }
}

/** CORE: モード id がそのまま begin() の type。接続中は notify の付け替えで切り替える */
async function applyCoreMode(type: string): Promise<void> {
  const autoReconnect = autoReconnectInput.checked;
  if (!begun) {
    await ble.begin(type, { autoReconnect });
    begun = true;
    begunType = type;
    sensorNotifyOn = type !== 'STEP_ANALYSIS';
    stepNotifyOn = type !== 'SENSOR_VALUES';
    log(`begin('${type}') 完了`);
    return;
  }
  // 開始してから不要分を止め、途切れを作らない
  const wantStep = type !== 'SENSOR_VALUES';
  const wantSensor = type !== 'STEP_ANALYSIS';
  if (wantSensor && !sensorNotifyOn) { await ble.transport.startNotify('SENSOR_VALUES'); sensorNotifyOn = true; }
  if (wantStep && !stepNotifyOn) { await ble.transport.startNotify('STEP_ANALYSIS'); stepNotifyOn = true; }
  if (!wantSensor && sensorNotifyOn) { await ble.transport.stopNotify('SENSOR_VALUES'); sensorNotifyOn = false; }
  if (!wantStep && stepNotifyOn) { await ble.transport.stopNotify('STEP_ANALYSIS'); stepNotifyOn = false; }
}

/** INSOLE: begin() の type は SENSOR_VALUES 固定で、モード id から streamingMode を決める */
async function applyInsoleMode(mode: string): Promise<void> {
  const streamingMode = insoleStreamingModeOf(mode) ?? 4;
  if (!begun) {
    await ble.begin('SENSOR_VALUES', { streamingMode, autoReconnect: autoReconnectInput.checked });
    begun = true;
    log(`begin('SENSOR_VALUES', { streamingMode: ${streamingMode} }) 完了`);
    return;
  }
  await profile.insole.setDataStreamingMode(ble.transport, streamingMode);
  log(`streamingMode ${streamingMode} に切替`);
}

// ── 接続 ────────────────────────────────────────────────────────────
const connectButton = q<HTMLButtonElement>('[data-connect]');
const fwEl = q<HTMLElement>('[data-fw]');

async function connect(): Promise<void> {
  connectButton.disabled = true;
  try {
    // begin() より先に FW を読む。ここで CORE / INSOLE が判別され、使えるモードが確定する
    const firmware = await ble.readFirmwareInfo();
    // readFirmwareInfo() は失敗しても null を返すだけなので、接続の成否は別に見る
    if (!ble.isConnected()) throw new Error('デバイスに接続できませんでした');
    log(`${profile.kind} と判別`);
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

function disconnect(): void {
  ble.stop();
  log('stop()');
  markDisconnected();
  modeWrap.hidden = true;
  fwEl.textContent = '';
  clearReadings();
}

/** 接続前と同じ見た目へ戻す */
function clearReadings(): void {
  lostCount = 0;
  pressScale = 2000;
  for (const key of Object.keys(latest)) delete (latest as Record<string, unknown>)[key];
  for (const bar of bars) bar.style.height = '0%';
  for (const val of vals) val.textContent = '-';
  q('[data-device]').textContent = '';
}

connectButton.addEventListener('click', () => {
  if (ble.connectionState === 'disconnected') void connect();
  else disconnect();
});

// ── 描画 ────────────────────────────────────────────────────────────
const bars = [...document.querySelectorAll<HTMLElement>('[data-bar]')];
const vals = [...document.querySelectorAll<HTMLElement>('[data-val]')];
const cells = [...document.querySelectorAll<HTMLElement>('[data-v]')].map((el) => ({
  el,
  path: (el.dataset['v'] ?? '').split('.'),
}));
const kindEls = [...document.querySelectorAll<HTMLElement>('[data-kinds]')];
const stateEl = q<HTMLElement>('[data-state]');
const kindEl = q<HTMLElement>('[data-kind]');
const acquisitionEl = q<HTMLElement>('[data-acquisition]');
let appliedKind = '';

function render(): void {
  const state = ble.connectionState;
  stateEl.textContent = state;
  stateEl.className = `badge ${state}`;
  connectButton.textContent = state === 'disconnected' ? '接続' : '切断';

  // 判別結果に合わせて出すセクションを切り替える（要素側は data-kinds="core insole" で指定）
  const kind = begun ? profile.kind : '';
  if (kind !== appliedKind) {
    appliedKind = kind;
    for (const el of kindEls) el.hidden = !(el.dataset['kinds'] ?? '').split(' ').includes(kind);
    kindEl.textContent = kind === 'core' ? 'ORPHE CORE' : kind === 'insole' ? 'ORPHE INSOLE' : 'CORE / INSOLE';
  }
  acquisitionEl.textContent = !begun ? '' : switching ? '切替中…' : 'リアルタイム計測中';

  q('[data-freq]').textContent = latest.ble_frequency ? latest.ble_frequency.toFixed(0) : '-';
  q('[data-serial]').textContent = latest.serial_number?.toString() ?? '-';
  q('[data-lost]').textContent = String(lostCount);
  q('[data-steps]').textContent = latest.steps_number?.value.toString() ?? '-';

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
}

(function loop() {
  render();
  requestAnimationFrame(loop);
})();
