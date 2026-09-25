/// <reference lib="dom" />
/**
 * InsoleToolkit — ORPHE INSOLE の接続 GUI（Bootstrap 5 + bootstrap-icons 前提）。
 *
 * buildInsoleToolkit() を呼ぶだけで、接続トグル・周波数・左右バッジ・バッテリー・FW バージョン・
 * 再接続ステータス・設定モーダル（出力選択 / Realtime・FIFO / ストリーミング形式）を生成する。
 * 計測の状態管理は InsoleToolkitSession が持ち、getInsoleToolkitSession() で取り出せる。
 */
import {
  InsoleToolkitSession,
  INSOLE_TOOLKIT_STEP_UNSUPPORTED_FW,
  OrpheInsole,
  OrpheInsoleFifo,
  OrpheInsoleGait,
  OrpheInsoleSimulator,
  resolveInsoleToolkitProfile,
} from '../index.ts';
import type { InsoleSessionAdapters, InsoleSessionDevice, InsoleToolkitSessionOptions } from '../index.ts';
import { buildElement, byId } from './dom.ts';

/** buildInsoleToolkit() のオプション */
export interface InsoleToolkitOptions extends InsoleToolkitSessionOptions {
  /** 切断時に自動再接続する。既定 true */
  autoReconnect?: boolean;
}

type ToolkitInsole = OrpheInsole | OrpheInsoleSimulator;
type Callbacks = Record<string, unknown> & { id: number };

/** 操作対象の ORPHE INSOLE（最大 2 足） */
export const insoles: ToolkitInsole[] = [new OrpheInsole(0), new OrpheInsole(1)];

/** buildInsoleToolkit() が生成したデバイス別セッション */
export const insoleToolkitSessions: Array<InsoleToolkitSession | null> = [null, null];

const MODE_NOTE = 'Realtime Raw and Step Analysis can run together. FIFO is lossless Raw recording and runs alone.';

const sessionsByInsole = new WeakMap<object, InsoleToolkitSession>();
const callbacksInstalled = new WeakSet<object>();

function insole(no: number): ToolkitInsole {
  const target = insoles[no];
  if (!target) throw new RangeError(`InsoleToolkit: insole_id ${no} is out of range.`);
  return target;
}

/**
 * インソール操作 GUI を生成する。
 * @param parent_element InsoleToolkit を追加する親要素
 * @param title トグルボタンの横に表示するタイトル
 * @param insole_id 0 または 1
 * @param options sensorDataMode / outputs / profile / fifo / gait / simulator と begin() のオプション。
 *   fifo: false / gait: false でその機能を設定画面から選べなくする。
 *   simulator: true で実機の代わりに OrpheInsoleSimulator を使う。
 */
export function buildInsoleToolkit(
  parent_element: Element,
  title: string,
  insole_id = 0,
  options: InsoleToolkitOptions = {},
): void {
  if (options.profile !== undefined) {
    const initialProfile = resolveInsoleToolkitProfile(options.profile);
    options.streamingMode = initialProfile.streamingMode;
    options.sensorDataMode = initialProfile.sensorDataMode;
    options.outputs = { ...initialProfile.outputs };
  }
  if (typeof options.streamingMode === 'undefined') options.streamingMode = 4;
  if (typeof options.autoReconnect === 'undefined') options.autoReconnect = true;
  if (typeof options.sensorDataMode === 'undefined') options.sensorDataMode = 'realtime';
  if (typeof options.outputs === 'undefined') {
    options.outputs = { sensorValues: true, stepAnalysis: false };
  }

  if (options.simulator === true && !(insoles[insole_id] instanceof OrpheInsoleSimulator)) {
    const simulator = new OrpheInsoleSimulator(insole_id);
    simulator.setup();
    insoles[insole_id] = simulator;
  }
  const adapters: InsoleSessionAdapters = {
    FifoClass: options.fifo === false ? null : OrpheInsoleFifo,
    GaitClass: options.gait === false ? null : OrpheInsoleGait,
  };
  const session = new InsoleToolkitSession(insole(insole_id) as unknown as InsoleSessionDevice, options, adapters);
  session.addStateListener(() => syncInsoleToolkitControls(insole_id));
  insoleToolkitSessions[insole_id] = session;
  sessionsByInsole.set(insole(insole_id), session);

  const div_form_check = buildElement('div', '', 'form-check form-switch d-flex', '', parent_element);
  div_form_check.id = `insole_toolkit${insole_id}`;

  const input = buildElement('input', '', 'form-check-input position-relative', '', div_form_check) as HTMLInputElement;
  input.setAttribute('type', 'checkbox');
  input.setAttribute('role', 'switch');
  input.setAttribute('id', `switch_ble${insole_id}`);
  input.setAttribute('value', `${insole_id}`);
  input.setAttribute('aria-label', `Connect ${title}`);
  input.addEventListener('change', function () {
    void toggleInsoleModule(this, options);
  });
  buildElement('label', title, 'form-check-label ms-1', '', div_form_check);

  const span_group = buildElement('span', '', '', '', div_form_check);
  span_group.id = `ui${insole_id}`;
  span_group.style.visibility = 'hidden';

  const span_activity = buildElement('span',
    `<i class="bi bi-activity position-relative">
        <span class="position-absolute top-0 start-50 translate-middle badge text-muted" style="font-size:0.2em;"
          id="freq${insole_id}">
        </span>
      </i>`,
    'text-muted ms-1', '', span_group);
  span_activity.id = `icon_bluetooth${insole_id}`;

  const span_lr = buildElement('span', `<span class="badge bg-secondary" id="lr_badge${insole_id}">-</span>`, 'ms-1', '', span_group);
  span_lr.id = `icon_lr${insole_id}`;
  span_lr.setAttribute('title', 'mount position (L/R)');

  const span_battery = buildElement('span', `<i class="bi bi-battery"></i>`, 'text-muted ms-1', '', span_group);
  span_battery.id = `icon_battery${insole_id}`;
  span_battery.setAttribute('insole_id', `${insole_id}`);
  span_battery.addEventListener('click', function () {
    void updateInsoleBatteryInfo(span_battery);
  });

  const span_fw = buildElement('span',
    `<span class="badge bg-light text-secondary border" id="fw_badge${insole_id}"></span>`,
    'ms-1', '', span_group);
  span_fw.id = `icon_fw${insole_id}`;
  span_fw.style.display = 'none';
  span_fw.setAttribute('title', 'firmware version');

  const span_reconnect = buildElement('span',
    `<i class="bi bi-arrow-repeat"></i><span class="small" id="reconnect_text${insole_id}"></span>`,
    'text-warning ms-1', '', span_group);
  span_reconnect.id = `icon_reconnect${insole_id}`;
  span_reconnect.style.display = 'none';
  span_reconnect.setAttribute('title', 'auto reconnecting...');

  const span_settings = buildElement('span', `<i class="bi bi-gear"></i>`, 'text-muted ms-1', '', span_group);
  span_settings.id = `icon_settings${insole_id}`;
  span_settings.setAttribute('value', `${insole_id}`);
  span_settings.setAttribute('title', `settings for streaming mode.`);
  span_settings.setAttribute('data-bs-toggle', 'modal');
  span_settings.setAttribute('data-bs-target', `#settings_modal${insole_id}`);
  span_settings.addEventListener('click', function () {
    void updateInsoleModalParameters(insole_id);
  });

  // 設定モーダルは body 直下に置く。position:sticky / transform などで stacking context を作る要素の
  // 内側に置くと、Bootstrap が body に挿す backdrop がモーダルより前面に来て操作できなくなる。
  const existingModal = byId(`settings_modal${insole_id}`);
  if (existingModal) existingModal.remove();
  const div_modal = buildElement('div', '', 'modal fade', '', document.body);
  div_modal.id = `settings_modal${insole_id}`;
  div_modal.setAttribute('tabindex', '-1');
  div_modal.setAttribute('aria-hidden', 'true');
  const div_modal_dialog = buildElement('div', '', 'modal-dialog text-dark', '', div_modal);
  const div_modal_content = buildElement('div', '', 'modal-content', '', div_modal_dialog);
  buildElement('div', `<h5 class="modal-title"><i class="bi bi-gear"></i> INSOLE0${insole_id} Settings</h5>
        <button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="Close"></button>`, 'modal-header', '', div_modal_content);

  buildElement('div', `<fieldset class="border rounded p-2 mt-2">
    <legend class="float-none w-auto px-1 mb-1 small">Data Outputs</legend>
    <div class="form-check form-check-inline mb-0">
      <input class="form-check-input" type="checkbox" id="output_sensor_values${insole_id}">
      <label class="form-check-label small" for="output_sensor_values${insole_id}">Raw Sensor Data</label>
    </div>
    <div class="form-check form-check-inline mb-0">
      <input class="form-check-input" type="checkbox" id="output_step_analysis${insole_id}">
      <label class="form-check-label small" for="output_step_analysis${insole_id}">Step Analysis</label>
    </div>
  </fieldset>
  <div class="form-floating mt-2">
    <select class="form-select text-black" id="select_sensor_data_mode${insole_id}">
      <option value="realtime">Realtime</option>
      <option value="fifo">FIFO (gyro + acc + press, no quat)</option>
    </select>
    <label for="select_sensor_data_mode${insole_id}" class="small">Raw Data Acquisition</label>
  </div>
  <div class="form-floating mt-2">
    <select class="form-select text-black" id="select_streaming_mode${insole_id}"
      onchange="changeInsoleStreamingMode(${insole_id}, this);">
      <option value="1">1: quat + gyro + acc (200Hz)</option>
      <option value="3">3: gyro + acc + press (200Hz)</option>
      <option value="4" selected>4: gyro + acc + press + quat (100Hz)</option>
    </select>
    <label for="select_streaming_mode${insole_id}" class="small">Realtime Streaming Format</label>
  </div>
  <div id="toolkit_mode_status${insole_id}" class="small text-muted mt-2" role="status"></div>
  <div id="toolkit_mode_note${insole_id}" class="small text-muted mt-1">
    ${MODE_NOTE}
  </div>
  <div class="row mt-3 small text-muted">
    <div class="col-6">Accelerometer Range: <span id="info_acc_range${insole_id}">-</span> g</div>
    <div class="col-6">Gyroscope Range: <span id="info_gyro_range${insole_id}">-</span> °/s</div>
  </div>
  <div class="row mt-1 small text-muted">
    <div class="col-12">Mount Position: <span id="info_mount_position${insole_id}">-</span></div>
  </div>
  <div class="row mt-1 small text-muted">
    <div class="col-12">Firmware: <span id="info_firmware${insole_id}">-</span></div>
  </div>
  <div class="d-grid gap-2 col-10 mx-auto mt-4">
    <button class="btn btn-warning text-white" type="button" onclick="resetInsoleModule(${insole_id});">Reset
      Analysis Logs</button>
  </div>`, 'modal-body', '', div_modal_content);

  const select_mode = div_modal_content.querySelector<HTMLSelectElement>(`#select_streaming_mode${insole_id}`)!;
  for (const opt of Array.from(select_mode.options)) {
    opt.selected = (parseInt(opt.value) === options.streamingMode);
  }
  const select_sensor_data_mode = div_modal_content.querySelector<HTMLSelectElement>(`#select_sensor_data_mode${insole_id}`)!;
  select_sensor_data_mode.value = session.sensorDataMode;
  const output_sensor_values = div_modal_content.querySelector<HTMLInputElement>(`#output_sensor_values${insole_id}`)!;
  const output_step_analysis = div_modal_content.querySelector<HTMLInputElement>(`#output_step_analysis${insole_id}`)!;
  output_sensor_values.checked = session.outputs.sensorValues;
  output_step_analysis.checked = session.outputs.stepAnalysis;
  output_sensor_values.addEventListener('change', () => { void changeInsoleDataOutputs(insole_id); });
  output_step_analysis.addEventListener('change', () => { void changeInsoleDataOutputs(insole_id); });
  select_sensor_data_mode.addEventListener('change', function () {
    void changeInsoleSensorDataMode(insole_id, this);
  });
  syncInsoleToolkitControls(insole_id);
}

/** 接続トグルが切り替わったときの処理 */
export async function toggleInsoleModule(dom: HTMLInputElement, options: InsoleToolkitOptions = {}): Promise<void> {
  const checked = dom.checked;
  const number = parseInt(dom.value);
  const target = insole(number);
  const session = getInsoleToolkitSession(number);
  if (!session) return;
  dom.disabled = true;
  if (checked) {
    let ret: unknown;
    try {
      ret = await session.connect({ ...options, forceDeviceSelection: true });
    } catch (error) {
      if (!isInsoleToolkitUserCancel(error)) {
        console.error('toggleInsoleModule connect failed:', error);
      }
      ret = null;
    }
    if (!ret) {
      const sw = byId<HTMLInputElement>(`switch_ble${number}`);
      if (sw) sw.checked = false;
      dom.disabled = false;
      syncInsoleToolkitControls(number);
      return;
    }

    const ui = byId(`ui${number}`);
    if (ui) ui.style.visibility = 'visible';
    updateInsoleLRBadge(number);
    void updateInsoleFirmwareBadge(number);

    installInsoleToolkitCallbacks(target, session);
  } else {
    try {
      await session.disconnect();
    } catch (error) {
      console.error('toggleInsoleModule disconnect failed:', error);
    } finally {
      const ui = byId(`ui${number}`);
      if (ui) ui.style.visibility = 'hidden';
    }
  }
  dom.disabled = false;
  syncInsoleToolkitControls(number);
}

/** 利用者のコールバックを保ったまま、Toolkit の表示更新をコールバックへ差し込む（1 デバイス 1 回） */
export function installInsoleToolkitCallbacks(target: ToolkitInsole, session: InsoleToolkitSession): void {
  sessionsByInsole.set(target, session);
  if (callbacksInstalled.has(target)) return;
  callbacksInstalled.add(target);
  const device = target as unknown as Callbacks;

  const userGotBLEFrequency = device.gotBLEFrequency as ((this: unknown, freq: number) => void) | undefined;
  device.gotBLEFrequency = function (this: Callbacks, freq: number) {
    const el = byId(`freq${this.id}`);
    if (el) el.innerHTML = `${Math.floor(freq)} Hz`;
    if (typeof userGotBLEFrequency === 'function') userGotBLEFrequency.call(this, freq);
  };

  const userOnDisconnect = device.onDisconnect as ((this: unknown, ...args: unknown[]) => void) | undefined;
  device.onDisconnect = function (this: Callbacks, ...args: unknown[]) {
    sessionsByInsole.get(this)?.markDisconnected();
    if (typeof userOnDisconnect === 'function') userOnDisconnect.apply(this, args);
  };

  const userOnReconnectAttempt = device.onReconnectAttempt as ((this: unknown, info: unknown) => void) | undefined;
  device.onReconnectAttempt = function (this: Callbacks, info: { attempt: number; maxAttempts: number }) {
    const icon = byId(`icon_reconnect${this.id}`);
    const text = byId(`reconnect_text${this.id}`);
    if (icon) icon.style.display = '';
    if (text) text.innerText = `${info.attempt}/${info.maxAttempts}`;
    if (typeof userOnReconnectAttempt === 'function') userOnReconnectAttempt.call(this, info);
  };
  const userOnReconnectSuccess = device.onReconnectSuccess as ((this: unknown, info: unknown) => void) | undefined;
  device.onReconnectSuccess = function (this: Callbacks, info: unknown) {
    const icon = byId(`icon_reconnect${this.id}`);
    if (icon) icon.style.display = 'none';
    updateInsoleLRBadge(this.id);
    void updateInsoleFirmwareBadge(this.id);
    if (typeof userOnReconnectSuccess === 'function') userOnReconnectSuccess.call(this, info);
  };
  const userOnReconnectFailed = device.onReconnectFailed as ((this: unknown, info: unknown) => void) | undefined;
  device.onReconnectFailed = function (this: Callbacks, info: unknown) {
    const icon = byId(`icon_reconnect${this.id}`);
    if (icon) icon.style.display = 'none';
    sessionsByInsole.get(this)?.markDisconnected();
    setInsoleHeaderStatusOffline(this.id);
    const ui = byId(`ui${this.id}`);
    if (ui) ui.style.visibility = 'hidden';
    if (typeof userOnReconnectFailed === 'function') userOnReconnectFailed.call(this, info);
  };
}

/** chooser のキャンセルかどうか */
export function isInsoleToolkitUserCancel(error: unknown): boolean {
  const message = error && (error as Error).message ? (error as Error).message : String(error || '');
  return Boolean(error && (error as Error).name === 'NotFoundError') || /cancelled|canceled|chooser/i.test(message);
}

/** device_information.mount_position（bit0: 0=LEFT, 1=RIGHT）から左右バッジを更新する */
export function updateInsoleLRBadge(no: number): void {
  const badge = byId(`lr_badge${no}`);
  if (!badge) return;
  const info = insole(no).device_information as { mount_position?: number } | '' | null;
  if (!info || typeof info.mount_position === 'undefined') {
    badge.innerText = '-';
    return;
  }
  const isRight = (info.mount_position & 0b1) === 1;
  badge.innerText = isRight ? 'R' : 'L';
  badge.classList.remove('bg-secondary');
  badge.classList.add(isRight ? 'bg-primary' : 'bg-success');
}

/**
 * FW バージョンバッジを更新する。取得できない FW・環境では非表示のまま。
 * Step Analysis 未確認の既知 FW は警告色で表示する。
 */
export async function updateInsoleFirmwareBadge(no: number): Promise<void> {
  const badge = byId(`fw_badge${no}`);
  const wrap = byId(`icon_fw${no}`);
  if (!badge || !wrap) return;
  let version: string | null = null;
  try {
    version = await insole(no).getFirmwareVersion();
  } catch {
    version = null;
  }
  if (!version) {
    badge.innerText = '';
    wrap.style.display = 'none';
    return;
  }
  badge.innerText = `FW ${version}`;
  wrap.style.display = '';
  if (INSOLE_TOOLKIT_STEP_UNSUPPORTED_FW.includes(version)) {
    badge.classList.remove('bg-light', 'text-secondary');
    badge.classList.add('bg-warning', 'text-dark');
    wrap.setAttribute('title',
      `firmware ${version}: Step Analysis通知が確認できていないFWです（FW更新を検討してください）`);
  } else {
    badge.classList.remove('bg-warning', 'text-dark');
    badge.classList.add('bg-light', 'text-secondary');
    wrap.setAttribute('title', 'firmware version');
  }
}

/**
 * buildInsoleToolkit() が生成したデバイス別セッションを返す。
 * 独自の記録 UI もこのセッション経由で操作すると、設定モーダルと通知の所有状態を共有できる。
 */
export function getInsoleToolkitSession(no: number): InsoleToolkitSession | null {
  return insoleToolkitSessions[no] || null;
}

/** 設定モーダルの出力選択（Raw / Step Analysis）が変わったときの処理 */
export async function changeInsoleDataOutputs(no: number): Promise<void> {
  const session = getInsoleToolkitSession(no);
  if (!session) return;
  const sensorValues = byId<HTMLInputElement>(`output_sensor_values${no}`);
  const stepAnalysis = byId<HTMLInputElement>(`output_step_analysis${no}`);
  try {
    await session.setOutputs({
      sensorValues: !!(sensorValues && sensorValues.checked),
      stepAnalysis: !!(stepAnalysis && stepAnalysis.checked),
    });
  } catch (error) {
    if (error && (error as { code?: string }).code !== 'NO_DATA_OUTPUT') {
      console.error('changeInsoleDataOutputs failed:', error);
    }
  } finally {
    syncInsoleToolkitControls(no);
  }
}

/** 設定モーダルの取得経路（Realtime / FIFO）が変わったときの処理 */
export async function changeInsoleSensorDataMode(no: number, dom: HTMLSelectElement): Promise<void> {
  const session = getInsoleToolkitSession(no);
  if (!session) return;
  try {
    await session.setSensorDataMode(dom.value);
  } catch (error) {
    console.error('changeInsoleSensorDataMode failed:', error);
  } finally {
    syncInsoleToolkitControls(no);
  }
}

/** 設定モーダルのストリーミング形式が変わったときの処理 */
export async function changeInsoleStreamingMode(no: number, dom: HTMLSelectElement): Promise<void> {
  const mode = parseInt(dom.value);
  const session = getInsoleToolkitSession(no);
  if (!session) return;
  try {
    await session.setStreamingMode(mode);
  } catch (error) {
    console.error('changeInsoleStreamingMode failed:', error);
  } finally {
    syncInsoleToolkitControls(no);
  }
}

/** 設定モーダルの各コントロールをセッションの状態に合わせる */
export function syncInsoleToolkitControls(no: number): void {
  const session = getInsoleToolkitSession(no);
  if (!session || typeof document === 'undefined') return;
  const state = session.snapshot();
  const sensorValues = byId<HTMLInputElement>(`output_sensor_values${no}`);
  const stepAnalysis = byId<HTMLInputElement>(`output_step_analysis${no}`);
  const sensorDataMode = byId<HTMLSelectElement>(`select_sensor_data_mode${no}`);
  const streamingMode = byId<HTMLSelectElement>(`select_streaming_mode${no}`);
  const status = byId(`toolkit_mode_status${no}`);
  const note = byId(`toolkit_mode_note${no}`);

  if (sensorValues) {
    if (!state.transitioning) sensorValues.checked = state.outputs.sensorValues;
    sensorValues.disabled = state.transitioning || state.measurementPhase !== 'idle';
  }
  if (stepAnalysis) {
    if (!state.transitioning) stepAnalysis.checked = state.outputs.stepAnalysis;
    const fifoSelected = state.outputs.sensorValues && state.sensorDataMode === 'fifo';
    stepAnalysis.disabled = state.transitioning
      || state.measurementPhase !== 'idle'
      || !state.supportsStepAnalysis
      || fifoSelected;
    stepAnalysis.title = !state.supportsStepAnalysis
      ? 'Step Analysis is not available for this device.'
      : fifoSelected
        ? 'Step Analysis is available with Realtime Raw, not FIFO.'
        : '';
  }
  if (sensorDataMode) {
    if (!state.transitioning) sensorDataMode.value = state.sensorDataMode;
    sensorDataMode.disabled = state.transitioning
      || state.measurementPhase !== 'idle'
      || !state.outputs.sensorValues;
    const fifoOption = Array.from(sensorDataMode.options).find((option) => option.value === 'fifo');
    if (fifoOption) {
      fifoOption.disabled = !state.supportsFifo || state.outputs.stepAnalysis;
      fifoOption.title = state.outputs.stepAnalysis
        ? 'Turn off Step Analysis before selecting FIFO.'
        : '';
    }
  }
  if (streamingMode) {
    if (!state.transitioning) streamingMode.value = String(state.streamingMode);
    streamingMode.disabled = state.transitioning
      || state.measurementPhase !== 'idle'
      || !state.outputs.sensorValues
      || state.sensorDataMode === 'fifo';
  }

  if (status) {
    status.classList.toggle('text-danger', !!state.lastError);
    status.classList.toggle('text-muted', !state.lastError);
    if (state.measurementPhase === 'draining') {
      status.innerText = 'Recording stopped. Recovering the remaining FIFO samples…';
    } else if (state.measurementPhase === 'recording') {
      status.innerText = `Recording: ${state.profile?.label || state.profileId}`;
    } else if (state.transitioning) {
      status.innerText = 'Switching data mode…';
    } else if (state.lastError) {
      status.innerText = (state.lastError as Error).message || String(state.lastError);
    } else if (!state.connected) {
      status.innerText = 'Changes apply on the next connection.';
    } else if (!state.outputs.sensorValues) {
      status.innerText = 'Active: Step Analysis only';
    } else if (state.sensorDataMode === 'fifo' && !state.fifoActive) {
      status.innerText = 'FIFO stopped. Select Realtime, then FIFO, to restart.';
    } else {
      const raw = state.sensorDataMode === 'fifo' ? 'FIFO Raw Data' : 'Realtime Raw Data';
      status.innerText = `Active: ${raw}${state.outputs.stepAnalysis ? ' + Step Analysis' : ''}`;
    }
  }
  if (note) {
    const unavailable: string[] = [];
    if (!state.supportsFifo) unavailable.push('FIFO is not available.');
    if (!state.supportsStepAnalysis) unavailable.push('Step Analysis is not available.');
    note.innerText = unavailable.length ? unavailable.join(' ') : MODE_NOTE;
  }
}

/** 設定モーダルのレンジ・取り付け位置・FW 表示を更新する */
export async function updateInsoleModalParameters(no: number): Promise<void> {
  const obj = await insole(no).getDeviceInformation() as { range: { acc: number; gyro: number }; mount_position: number };

  const ACC_RANGE: Record<number, number> = { 0: 2, 1: 4, 2: 8, 3: 16 };
  const GYRO_RANGE: Record<number, number> = { 0: 250, 1: 500, 2: 1000, 3: 2000 };
  const acc_el = byId(`info_acc_range${no}`);
  const gyro_el = byId(`info_gyro_range${no}`);
  const mount_el = byId(`info_mount_position${no}`);
  if (acc_el) acc_el.innerText = String(ACC_RANGE[obj.range.acc] ?? obj.range.acc);
  if (gyro_el) gyro_el.innerText = String(GYRO_RANGE[obj.range.gyro] ?? obj.range.gyro);
  if (mount_el) {
    const isRight = (obj.mount_position & 0b1) === 1;
    const isInstep = (obj.mount_position & 0b10) === 0b10;
    mount_el.innerText = `${isRight ? 'RIGHT' : 'LEFT'} / ${isInstep ? 'instep(足背)' : 'plantar(足底)'}`;
  }

  const fw_el = byId(`info_firmware${no}`);
  if (fw_el) {
    let version: string | null = null;
    try {
      version = await insole(no).getFirmwareVersion();
    } catch {
      version = null;
    }
    fw_el.innerText = version || 'unknown';
  }

  syncInsoleToolkitControls(no);
  updateInsoleLRBadge(no);
  void updateInsoleFirmwareBadge(no);
}

/** インソールの解析ログをリセットする */
export function resetInsoleModule(id: number): void {
  void insole(id).resetAnalysisLogs();
}

/** バッテリー残量（3 段階）に合わせてアイコンを更新する */
export async function updateInsoleBatteryInfo(dom: Element): Promise<void> {
  const number = parseInt(dom.getAttribute('insole_id') || '0');
  const obj = await insole(number).getDeviceInformation() as { battery: number };
  let str_battery_status: string | undefined;
  if (obj.battery == 0) str_battery_status = 'empty';
  else if (obj.battery == 1) str_battery_status = 'normal';
  else if (obj.battery == 2) str_battery_status = 'full';
  const el = byId(`icon_battery${number}`);
  if (!el) return;
  el.setAttribute('title', `${str_battery_status}`);

  if (obj.battery == 0) {
    el.innerHTML = '<i class="bi bi-battery"></i>';
    el.classList.add('text-warning');
  } else if (obj.battery == 1) {
    el.innerHTML = '<i class="bi bi-battery-half"></i>';
  } else if (obj.battery == 2) {
    el.innerHTML = '<i class="bi bi-battery-full"></i>';
  }
}

/** 接続トグルをオフ表示にする */
export function setInsoleHeaderStatusOffline(id: number): void {
  const el = byId<HTMLInputElement>(`switch_ble${id}`);
  if (el) el.checked = false;
}

/** buildElement の別名 */
export const ITbuildElement = buildElement;
