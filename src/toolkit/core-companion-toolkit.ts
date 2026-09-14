/// <reference lib="dom" />
/**
 * CoreCompanionToolkit — INSOLE のページに ORPHE CORE を 1 台だけ同居させる接続 GUI。
 *
 * 生成する CORE は orpheCore（insoles / cores とは独立したインスタンス）。
 * chooser は名前（既定 'CR-'）とサービス UUID のどちらでも CORE を拾い、
 * header 50 の 104 バイト版パケットも受け付ける。
 */
import { Orphe } from '../index.ts';
import { buildElement, byId } from './dom.ts';

/** buildCoreCompanionToolkit() のオプション */
export interface CoreCompanionToolkitOptions {
  /** 開始する通知。既定 'STEP_ANALYSIS_AND_SENSOR_VALUES' */
  notification?: string;
  /** 加速度・角速度のレンジ（物理値）。既定 { acc: 16, gyro: 2000 } */
  range?: { acc: number; gyro: number };
  /** 切断時に自動再接続する。既定 false */
  autoReconnect?: boolean;
  /** begin() がこの時間 [ms] 内に終わらなければ接続失敗として扱う。既定 20000（0 で無効） */
  connectTimeoutMs?: number;
  /** chooser の名前フィルタ。既定 'CR-' */
  chooserNamePrefix?: string;
}

/** buildCoreCompanionToolkit() が生成した ORPHE CORE（未生成なら null） */
export let orpheCore: Orphe | null = null;

let companionOptions: CoreCompanionToolkitOptions = {};
let ledOn = false;

/** CORE の SDK が使える状態か */
export function isOrpheCoreSdkLoaded(): boolean {
  return typeof Orphe === 'function';
}

/**
 * ORPHE CORE 1 台分の接続 GUI を生成する。
 * @returns 生成した ORPHE CORE インスタンス（orpheCore と同一）
 */
export function buildCoreCompanionToolkit(
  parent_element: Element,
  title: string,
  options: CoreCompanionToolkitOptions = {},
): Orphe {
  if (typeof options.notification === 'undefined') options.notification = 'STEP_ANALYSIS_AND_SENSOR_VALUES';
  if (typeof options.range === 'undefined') options.range = { acc: 16, gyro: 2000 };
  if (typeof options.autoReconnect === 'undefined') options.autoReconnect = false;
  if (typeof options.connectTimeoutMs === 'undefined') options.connectTimeoutMs = 20000;
  if (typeof options.chooserNamePrefix === 'undefined') options.chooserNamePrefix = 'CR-';

  if (!orpheCore) {
    orpheCore = new Orphe(0, {
      profile: { namePrefix: options.chooserNamePrefix, acceptExtendedSensorValues: true },
    });
    orpheCore.setup();
  } else {
    orpheCore.profile.setNamePrefix(options.chooserNamePrefix);
  }
  companionOptions = options;

  const div_form_check = buildElement('div', '', 'form-check form-switch d-flex', '', parent_element);
  div_form_check.id = 'core_toolkit0';

  const input = buildElement('input', '', 'form-check-input position-relative', '', div_form_check) as HTMLInputElement;
  input.setAttribute('type', 'checkbox');
  input.setAttribute('role', 'switch');
  input.setAttribute('id', 'switch_core0');
  input.addEventListener('change', function () {
    void toggleCoreCompanion(this);
  });
  buildElement('label', title, 'form-check-label ms-1', '', div_form_check);

  const span_group = buildElement('span', '', '', '', div_form_check);
  span_group.id = 'ui_core0';
  span_group.style.visibility = 'hidden';

  const span_activity = buildElement('span',
    `<i class="bi bi-activity position-relative">
        <span class="position-absolute top-0 start-50 translate-middle badge text-muted" style="font-size:0.2em;"
          id="freq_core0">
        </span>
      </i>`,
    'text-muted ms-1', '', span_group);
  span_activity.id = 'icon_bluetooth_core0';

  const span_battery = buildElement('span', `<i class="bi bi-battery"></i>`, 'text-muted ms-1', '', span_group);
  span_battery.id = 'icon_battery_core0';
  span_battery.addEventListener('click', function () {
    void updateCoreCompanionBatteryInfo();
  });

  const span_led = buildElement('span', `<i class="bi bi-lightbulb"></i>`, 'text-muted ms-1', '', span_group);
  span_led.id = 'icon_led_core0';
  span_led.setAttribute('title', 'toggle LED');
  span_led.addEventListener('click', function () {
    toggleCoreCompanionLED();
  });

  const span_settings = buildElement('span', `<i class="bi bi-gear"></i>`, 'text-muted ms-1', '', span_group);
  span_settings.id = 'icon_settings_core0';
  span_settings.setAttribute('title', 'settings for ORPHE CORE');
  span_settings.setAttribute('data-bs-toggle', 'modal');
  span_settings.setAttribute('data-bs-target', '#settings_modal_core0');
  span_settings.addEventListener('click', function () {
    void updateCoreCompanionModalParameters();
  });

  const div_modal = buildElement('div', '', 'modal fade', '', span_group);
  div_modal.id = 'settings_modal_core0';
  div_modal.setAttribute('tabindex', '-1');
  div_modal.setAttribute('aria-hidden', 'true');
  const div_modal_dialog = buildElement('div', '', 'modal-dialog text-dark', '', div_modal);
  const div_modal_content = buildElement('div', '', 'modal-content', '', div_modal_dialog);
  buildElement('div', `<h5 class="modal-title"><i class="bi bi-gear"></i> ORPHE CORE Settings</h5>
        <button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="Close"></button>`, 'modal-header', '', div_modal_content);

  buildElement('div', `<div class="form-floating mt-2">
    <select class="form-select text-black" id="select_core_notification0"
      onchange="changeCoreCompanionNotification(this);">
      <option value="STEP_ANALYSIS">STEP_ANALYSIS (gait/stride, ~30Hz)</option>
      <option value="SENSOR_VALUES">SENSOR_VALUES (acc/gyro/quat, 50-200Hz)</option>
      <option value="STEP_ANALYSIS_AND_SENSOR_VALUES">STEP_ANALYSIS + SENSOR_VALUES</option>
    </select>
    <label for="select_core_notification0" class="small">Notification Type (次回接続時に反映)</label>
  </div>
  <div class="row mt-3 small text-muted">
    <div class="col-6">Accelerometer Range: <span id="info_core_acc_range0">-</span> g</div>
    <div class="col-6">Gyroscope Range: <span id="info_core_gyro_range0">-</span> °/s</div>
  </div>
  <div class="d-grid gap-2 col-10 mx-auto mt-4">
    <button class="btn btn-secondary" type="button" onclick="resetCoreCompanionAttitude();">Reset Attitude</button>
    <button class="btn btn-warning text-white" type="button" onclick="resetCoreCompanionAnalysisLogs();">Reset
      Analysis Logs</button>
  </div>`, 'modal-body', '', div_modal_content);

  const select_notify = div_modal_content.querySelector<HTMLSelectElement>('#select_core_notification0');
  if (select_notify) {
    for (const opt of Array.from(select_notify.options)) {
      opt.selected = (opt.value === options.notification);
    }
  }

  return orpheCore;
}

/** 接続トグルが切り替わったときの処理 */
export async function toggleCoreCompanion(dom: HTMLInputElement): Promise<void> {
  const core = orpheCore;
  if (!core) return;
  const options = companionOptions;
  if (dom.checked) {
    let ret: unknown = null;
    try {
      const beginPromise = core.begin(options.notification, {
        range: options.range,
        autoReconnect: options.autoReconnect,
        forceDeviceSelection: true,
      });
      ret = await coreCompanionPromiseWithTimeout(beginPromise, options.connectTimeoutMs);
    } catch (error) {
      if (!isCoreCompanionUserCancel(error)) {
        console.error('toggleCoreCompanion connect failed:', error);
      }
      ret = null;
    }
    if (!ret) {
      const sw = byId<HTMLInputElement>('switch_core0');
      if (sw) sw.checked = false;
      return;
    }

    const ui = byId('ui_core0');
    if (ui) ui.style.visibility = 'visible';

    // 利用者のコールバックを保ったまま、Toolkit の表示更新を差し込む
    const userGotBLEFrequency = core.gotBLEFrequency;
    core.gotBLEFrequency = function (this: Orphe, freq: number) {
      const el = byId('freq_core0');
      if (el) el.innerHTML = `${Math.floor(freq)} Hz`;
      if (typeof userGotBLEFrequency === 'function') userGotBLEFrequency.call(this, freq);
    };

    const userOnDisconnect = core.onDisconnect;
    core.onDisconnect = function (this: Orphe, ...args: Parameters<Orphe['onDisconnect']>) {
      setCoreCompanionStatusOffline();
      if (typeof userOnDisconnect === 'function') userOnDisconnect.apply(this, args);
    };
  } else {
    core.reset();
    const ui = byId('ui_core0');
    if (ui) ui.style.visibility = 'hidden';
  }
}

/** timeoutMs 経過で null に解決する begin() 用のガード（0 以下なら待つだけ） */
export function coreCompanionPromiseWithTimeout<T>(promise: Promise<T>, timeoutMs: number | undefined): Promise<T | null> {
  if (!timeoutMs || timeoutMs <= 0) return promise;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      console.warn(`CoreCompanionToolkit: begin() が ${timeoutMs}ms 以内に完了しませんでした。接続失敗として扱います。`);
      resolve(null);
    }, timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function isCoreCompanionUserCancel(error: unknown): boolean {
  const message = error && (error as Error).message ? (error as Error).message : String(error || '');
  return Boolean(error && (error as Error).name === 'NotFoundError') || /cancelled|canceled|chooser|User cancel/i.test(message);
}

/** 通知の種類を変える（接続中の通知は切り替えず、次回接続時に反映する） */
export function changeCoreCompanionNotification(dom: { value: string }): void {
  if (!orpheCore) return;
  companionOptions.notification = dom.value;
}

/** 設定モーダルのレンジ表示を更新する */
export async function updateCoreCompanionModalParameters(): Promise<void> {
  if (!orpheCore) return;
  try {
    const obj = await orpheCore.getDeviceInformation();
    const ACC_RANGE: Record<number, number> = { 0: 2, 1: 4, 2: 8, 3: 16 };
    const GYRO_RANGE: Record<number, number> = { 0: 250, 1: 500, 2: 1000, 3: 2000 };
    const acc_el = byId('info_core_acc_range0');
    const gyro_el = byId('info_core_gyro_range0');
    if (acc_el) acc_el.innerText = String(ACC_RANGE[obj.range.acc] ?? obj.range.acc);
    if (gyro_el) gyro_el.innerText = String(GYRO_RANGE[obj.range.gyro] ?? obj.range.gyro);
  } catch (error) {
    console.error('updateCoreCompanionModalParameters failed:', error);
  }
}

/** バッテリー残量（3 段階）に合わせてアイコンを更新する */
export async function updateCoreCompanionBatteryInfo(): Promise<void> {
  if (!orpheCore) return;
  try {
    const obj = await orpheCore.getDeviceInformation();
    let str_battery_status: string | undefined;
    if (obj.battery == 0) str_battery_status = 'empty';
    else if (obj.battery == 1) str_battery_status = 'normal';
    else if (obj.battery == 2) str_battery_status = 'full';
    const el = byId('icon_battery_core0');
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
  } catch (error) {
    console.error('updateCoreCompanionBatteryInfo failed:', error);
  }
}

/** LED のオン・オフを切り替える（pattern 0 固定） */
export function toggleCoreCompanionLED(): void {
  if (!orpheCore) return;
  ledOn = !ledOn;
  void orpheCore.setLED(ledOn ? 1 : 0, 0);
  const el = byId('icon_led_core0');
  if (el) {
    el.innerHTML = ledOn ? '<i class="bi bi-lightbulb-fill"></i>' : '<i class="bi bi-lightbulb"></i>';
  }
}

/** 姿勢（quaternion）の基準をリセットする */
export function resetCoreCompanionAttitude(): void {
  if (!orpheCore) return;
  void orpheCore.resetMotionSensorAttitude();
}

/** CORE の解析ログをリセットする */
export function resetCoreCompanionAnalysisLogs(): void {
  if (!orpheCore) return;
  void orpheCore.resetAnalysisLogs();
}

/** トグルをオフにして UI を隠す */
export function setCoreCompanionStatusOffline(): void {
  const sw = byId<HTMLInputElement>('switch_core0');
  if (sw) sw.checked = false;
  const ui = byId('ui_core0');
  if (ui) ui.style.visibility = 'hidden';
}

/** テスト用: 生成済みの orpheCore を差し替える */
export function setOrpheCore(core: Orphe | null): void {
  orpheCore = core;
  ledOn = false;
}

/** buildElement の別名 */
export const CCTbuildElement = buildElement;
