/// <reference lib="dom" />
/**
 * CoreToolkit — ORPHE CORE の接続 GUI（Bootstrap 5 + bootstrap-icons 前提）。
 *
 * buildCoreToolkit() を呼ぶだけで、接続トグル・周波数・バッテリー・LED・設定モーダルを生成する。
 * 操作対象は cores（= bles）[0] / [1]。
 */
import { BleSharedBridge, Orphe } from '../index.ts';
import type { CoreBeginOptions } from '../index.ts';
import { buildElement, byId } from './dom.ts';

/** buildCoreToolkit() のオプション（残りのキーは begin() へ透過する） */
export interface CoreToolkitOptions extends Record<string, unknown> {
  /** 加速度・角速度のレンジ（物理値。-1 はデバイスの設定を維持） */
  range?: { acc: number; gyro: number };
  /** 切断時に自動再接続する。既定 true */
  autoReconnect?: boolean;
  /** 別タブと BLE 接続を共有する。既定 true */
  useSharedBridge?: boolean;
  /** 別スロットで使用中のデバイスを選んだら接続を拒否する。既定 true */
  rejectDuplicateDevices?: boolean;
  /** 記憶デバイスを使わず chooser を出す */
  forceDeviceSelection?: boolean;
  /** forceDeviceSelection でも、まず記憶デバイス（または別タブの接続）を試す */
  tryRememberedBeforePicker?: boolean;
}

/** guardCoreToolkitBluetooth() のオプション */
export interface CoreToolkitGuardOptions {
  coreIds?: number[];
  messageElement?: Element | string | null;
  message?: string;
  disabledTitle?: string;
}

/** 操作対象の ORPHE CORE（最大 2 台） */
export const cores: Orphe[] = [new Orphe(0), new Orphe(1)];

/** cores の別名 */
export const bles = cores;

const toolkitOptions = new Map<number, CoreToolkitOptions>();
const connecting = new Set<number>();

function beginOptionsFor(options: CoreToolkitOptions): CoreBeginOptions {
  return { ...options, useSharedBridge: options.useSharedBridge !== false } as CoreBeginOptions;
}

function core(no: number): Orphe {
  const target = cores[no];
  if (!target) throw new RangeError(`CoreToolkit: core_id ${no} is out of range.`);
  return target;
}

/**
 * コアモジュール操作 GUI を生成する。
 * @param parent_element CoreToolkit を追加する親要素
 * @param title トグルボタンの横に表示するタイトル
 * @param core_id 0 または 1
 * @param notification 開始する通知（STEP_ANALYSIS / SENSOR_VALUES / STEP_ANALYSIS_AND_SENSOR_VALUES）
 */
export function buildCoreToolkit(
  parent_element: Element,
  title: string,
  core_id = 0,
  notification = 'STEP_ANALYSIS_AND_SENSOR_VALUES',
  options: CoreToolkitOptions = {},
): void {
  options.range = options.range || { acc: -1, gyro: -1 };
  if (typeof options.autoReconnect === 'undefined') options.autoReconnect = true;
  toolkitOptions.set(core_id, options);

  if (!(options.range && options.range.acc != -1 && options.range.gyro != -1)) {
    if (options.range.acc == 16) options.range.acc = 3;
    else if (options.range.acc == 8) options.range.acc = 2;
    else if (options.range.acc == 4) options.range.acc = 1;
    else if (options.range.acc == 2) options.range.acc = 0;

    if (options.range.gyro == 2000) options.range.gyro = 3;
    else if (options.range.gyro == 1000) options.range.gyro = 2;
    else if (options.range.gyro == 500) options.range.gyro = 1;
    else if (options.range.gyro == 250) options.range.gyro = 0;
  }

  const div_form_check = buildElement('div', '', 'form-ckeck form-switch d-flex', '', parent_element);
  div_form_check.id = `core_toolkit${core_id}`;

  const input = buildElement('input', '', 'form-check-input position-relative', '', div_form_check) as HTMLInputElement;
  input.setAttribute('type', 'checkbox');
  input.setAttribute('role', 'switch');
  input.setAttribute('id', `switch_ble${core_id}`);
  input.setAttribute('notification', notification);
  input.setAttribute('value', `${core_id}`);
  input.addEventListener('change', function () {
    void toggleCoreModule(this, options);
  });
  buildElement('label', title, 'form-check-label ms-1', '', div_form_check);

  const span_group = buildElement('span', '', '', '', div_form_check);
  span_group.id = `ui${core_id}`;
  span_group.style.visibility = 'hidden';

  const span_activity = buildElement('span',
    `<i class="bi bi-activity position-relative">
        <span class="position-absolute top-0 start-50 translate-middle badge text-muted" style="font-size:0.2em;"
          id="freq${core_id}">
        </span>
      </i>`,
    'text-muted ms-1', '', span_group);
  span_activity.id = `icon_bluetooth${core_id}`;

  const span_battery = buildElement('span', `<i class="bi bi-battery"></i>`, 'text-muted ms-1', '', span_group);
  span_battery.id = `icon_battery${core_id}`;
  span_battery.setAttribute('core_id', `${core_id}`);
  span_battery.addEventListener('click', function () {
    void updateBatteryInfo(span_battery);
  });

  const span_led = buildElement('span', `<i class="bi bi-brightness-alt-high position-relative"><span class="position-absolute  top-0 start-50 tanslate-middle badge text-muted bg-light" style="font-size:0.2em;" id="led_number${core_id}">
          0
        </span>
      </i>`, 'text-muted ms-1', '', span_group);
  span_led.id = `icon_led${core_id}`;
  span_led.setAttribute('number', '0');
  span_led.setAttribute('value', `${core_id}`);
  span_led.addEventListener('click', function () {
    toggleLED(span_led);
  });

  const span_settings = buildElement('span', `<i
        class="bi bi-gear"></i>`, 'text-muted ms-1', '', span_group);
  span_settings.id = `icon_settings${core_id}`;
  span_settings.setAttribute('value', `${core_id}`);
  span_settings.setAttribute('title', `settings for notification, sensor ranges.`);
  span_settings.setAttribute('data-bs-toggle', 'modal');
  span_settings.setAttribute('data-bs-target', `#settings_modal${core_id}`);
  span_settings.addEventListener('click', function () {
    void updateModalParameters(core_id);
  });

  const div_modal = buildElement('div', '', 'modal fade', '', span_group);
  div_modal.id = `settings_modal${core_id}`;
  div_modal.setAttribute('tanindex', '-1');
  div_modal.setAttribute('aria-labelledby', 'exampleModalLabel');
  div_modal.setAttribute('aria-hidden', 'true');
  const div_modal_dialog = buildElement('div', '', 'modal-dialog text-dark', '', div_modal);
  const div_modal_content = buildElement('div', '', 'modal-content', '', div_modal_dialog);
  buildElement('div', `<h5 class="modal-title" id="exampleModalLabel"><i class="bi bi-gear"></i> CORE0${core_id} Settings</h5 >
        <button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="Close"></button>`, 'modal-header', '', div_modal_content);

  const div_modal_body = buildElement('div', `<div class="form-floating mt-2">
    <select class="form-select text-black" id="select_notify${core_id}" aria-label="Floating label select example"
      onchange="changeNotify(${core_id}, this);">
      <option value="STEP_ANALYSIS">STEP_ANALYSIS</option>
      <option value="SENSOR_VALUES">SENSOR_VALUES</option>
      <option value="STEP_ANALYSIS_AND_SENSOR_VALUES" selected>STEP_ANALYSIS_AND_SENSOR_VALUES</option>
    </select>
    <label for="select_notify${core_id}" class="small">Realtime data protocol[not available]</label>
  </div>
  <div class="form-floating mt-2">
    <select class="form-select text-black" id="select_acc${core_id}" aria-label="Floating label select example"
      onchange="changeAccRange(${core_id},this);">
      <option value="0" selected>2</option>
      <option value="1">4</option>
      <option value="2">8</option>
      <option value="3">16</option>
    </select>
    <label for="select_acc${core_id}" class="small">Accelerometer Range [g]</label>
  </div>
  <div class="form-floating mt-2">
    <select class="form-select text-black" id="select_gyro${core_id}" aria-label="Floating label select example"
      onchange="changeGryoRange(${core_id},this);">
      <option value="0" selected>250</option>
      <option value="1">500</option>
      <option value="2">1000</option>
      <option value="3">2000</option>
    </select>
    <label for="select_gyro${core_id}" class="small">Gryorscope Range [g]</label>
  </div>
  <div class="form-floating mt-2">
    <select class="form-select text-black" id="select_lr${core_id}" aria-label="lr"
    onchange="changeLR(${core_id},this);">
      <option value="0" selected>LEFT instep</option>
      <option value="1">RIGHT instep</option>
      <option value="2">LEFT plantar</option>
      <option value="3">RIGHT plantar</option>
    </select>
    <label for="select_gyro${core_id}" class="small">LEFT/RIGHT</label>
  </div>
  <div class="d-grid gap-2 col-12 mx-auto mt-4">
    <label for="range_brightness${core_id}" class="form-label small">LED Brightness</label>
    <input type="range" class="form-range" min="0" max="255" step="1" id="range_brightness${core_id}" onchange="changeLEDBrightness(${core_id},this);">
  </div>
  <div class="d-grid gap-2 col-10 mx-auto mt-4">
  <button class="btn btn-warning text-white" type="button" onclick="resetCoreModule(${core_id});">Reset
    Attitude & Gait Analysis</button>
  <button class="btn btn-outline-primary" type="button" id="button_switch_device${core_id}">Select another CORE</button>
	</div>`, 'modal-body', '', div_modal_content);

  const select_notify = div_modal_body.querySelector<HTMLSelectElement>(`#select_notify${core_id}`);
  if (select_notify) {
    if (notification == 'STEP_ANALYSIS') select_notify.options[0]!.selected = true;
    else if (notification == 'SENSOR_VALUES') select_notify.options[1]!.selected = true;
  }

  const switchDeviceButton = div_modal_body.querySelector(`#button_switch_device${core_id}`);
  if (switchDeviceButton) {
    switchDeviceButton.addEventListener('click', function () {
      void switchCoreBluetoothDevice(core_id, options);
    });
  }
}

/**
 * Web Bluetooth を使えないブラウザ（埋め込みブラウザなど）では接続 UI を無効化し、案内を表示する。
 * @returns Web Bluetooth を利用できる場合は true
 */
export function guardCoreToolkitBluetooth(options: CoreToolkitGuardOptions = {}): boolean {
  const coreIds = options.coreIds || [0, 1];
  const message = options.message || 'Web Bluetooth is disabled in this browser. Open this page in Chrome to connect ORPHE CORE.';
  const disabledTitle = options.disabledTitle || 'Open this page in Chrome to connect ORPHE CORE.';
  const isEmbeddedBrowser = /Electron|Codex/i.test(navigator.userAgent);
  const canUseWebBluetooth = window.isSecureContext && !!(navigator as { bluetooth?: unknown }).bluetooth && !isEmbeddedBrowser;

  if (canUseWebBluetooth) return true;

  coreIds.forEach(function (coreId) {
    const switchBle = byId<HTMLInputElement>(`switch_ble${coreId}`);
    if (!switchBle) return;
    switchBle.checked = false;
    switchBle.disabled = true;
    switchBle.title = disabledTitle;
  });

  let messageElement = options.messageElement;
  if (typeof messageElement === 'string') {
    messageElement = document.querySelector(messageElement);
  }
  if (messageElement instanceof HTMLElement) {
    if (!messageElement.textContent?.trim()) {
      messageElement.textContent = message;
    }
    messageElement.style.display = 'block';
  }

  return false;
}

/** 接続トグルが切り替わったときの処理 */
export async function toggleCoreModule(dom: HTMLInputElement, options: CoreToolkitOptions = {}): Promise<void> {
  const checked = dom.checked;
  const number = parseInt(dom.value);
  const ble = core(number);
  const notification = dom.getAttribute('notification') || 'STEP_ANALYSIS_AND_SENSOR_VALUES';
  if (connecting.has(number)) {
    dom.checked = ble.isConnected();
    return;
  }
  if (checked) {
    const connectOptions = beginOptionsFor(options);
    const hasRemotePrimary = connectOptions.useSharedBridge === true
      && new BleSharedBridge(number).isRemotePrimaryAvailable();
    const hasRememberedDevice = !!ble.getLastBluetoothDeviceInfo();
    const shouldTryRememberedFirst = !!options.forceDeviceSelection
      && options.tryRememberedBeforePicker === true
      && (hasRemotePrimary || hasRememberedDevice);
    const firstBeginOptions = shouldTryRememberedFirst
      ? { ...connectOptions, forceDeviceSelection: false }
      : connectOptions;
    ble.rejectDuplicateDevices = options.rejectDuplicateDevices !== false;

    connecting.add(number);
    dom.disabled = true;
    try {
      try {
        await ble.begin(notification, firstBeginOptions);
      } catch (error) {
        // 記憶デバイスを先に試して失敗したときだけ、記憶を捨てて chooser で選び直す
        if (!shouldTryRememberedFirst || !hasRememberedDevice || hasRemotePrimary) throw error;
        ble.forgetLastBluetoothDevice();
        await ble.begin(notification, connectOptions);
      }
    } catch (error) {
      const sw = byId<HTMLInputElement>(`switch_ble${number}`);
      if (sw) sw.checked = false;
      const ui = byId(`ui${number}`);
      if (ui) ui.style.visibility = 'hidden';
      ble.onError(error);
      return;
    } finally {
      connecting.delete(number);
      dom.disabled = false;
    }

    const ui = byId(`ui${number}`);
    if (ui) ui.style.visibility = 'visible';

    if (ble.isBridgeSecondary) {
      const freqEl = byId(`icon_bluetooth${number}`);
      if (freqEl) {
        freqEl.innerHTML = `<i class="bi bi-broadcast position-relative">
                  <span class="position-absolute top-0 start-50 translate-middle badge text-muted" style="font-size:0.2em;" id="freq${number}">
                    共有
                  </span>
                </i>`;
        freqEl.title = '別タブのBLE接続を共有中';
      }
      // Primary が切れたら UI を戻す（利用者の onDisconnect は残す）
      const userOnDisconnect = ble.onDisconnect;
      ble.onDisconnect = function (this: Orphe, ...args: Parameters<Orphe['onDisconnect']>) {
        if (typeof userOnDisconnect === 'function') userOnDisconnect.apply(this, args);
        const sw = byId<HTMLInputElement>(`switch_ble${number}`);
        if (sw) sw.checked = false;
        const uiEl = byId(`ui${number}`);
        if (uiEl) uiEl.style.visibility = 'hidden';
      };
    } else {
      ble.gotBLEFrequency = function (this: Orphe, freq: number) {
        const el = byId(`freq${this.id}`);
        if (el) el.innerHTML = `${Math.floor(freq)} Hz`;
      };
    }
  } else {
    ble.reset();
    const ui = byId(`ui${number}`);
    if (ui) ui.style.visibility = 'hidden';
  }
}

/** 別の Bluetooth デバイスを chooser で選び直して接続する */
export async function switchCoreBluetoothDevice(no: number, options: CoreToolkitOptions = {}): Promise<void> {
  const ble = core(no);
  const sw = byId<HTMLInputElement>(`switch_ble${no}`);
  const uiEl = byId(`ui${no}`);
  const notification = sw?.getAttribute('notification') || 'STEP_ANALYSIS_AND_SENSOR_VALUES';
  ble.rejectDuplicateDevices = options.rejectDuplicateDevices !== false;

  try {
    if (uiEl) uiEl.style.visibility = 'hidden';
    await ble.selectBluetoothDevice('DEVICE_INFORMATION');
    const ret = await ble.begin(notification, beginOptionsFor(options));
    if (sw) sw.checked = !!ret;
    if (ret && uiEl) uiEl.style.visibility = 'visible';
  } catch (error) {
    if (sw) sw.checked = false;
    if (uiEl) uiEl.style.visibility = 'hidden';
    ble.onError(error);
  }
}

/**
 * 接続したまま通知の種類を切り替える。
 * 同じ通知を二重に登録しないよう、登録済みの通知を止めてから begin し直す。
 */
export function changeNotify(no: number, dom: HTMLSelectElement): void {
  const ble = core(no);
  const options = beginOptionsFor(toolkitOptions.get(no) || {});
  const restart = () => {
    setTimeout(function () {
      ble.begin(dom.value, options).catch((error: unknown) => ble.onError(error));
    }, 500);
  };
  if (ble.notification_type == 'STEP_ANALYSIS') {
    void ble.stopNotify('STEP_ANALYSIS').then(restart);
  } else if (ble.notification_type == 'SENSOR_VALUES') {
    void ble.stopNotify('SENSOR_VALUES').then(restart);
  } else if (ble.notification_type == 'STEP_ANALYSIS_AND_SENSOR_VALUES') {
    void ble.stopNotify('STEP_ANALYSIS').then(() => ble.stopNotify('SENSOR_VALUES')).then(restart);
  }
}

/** 加速度センサのレンジを変更する */
export async function changeAccRange(no: number, dom: HTMLSelectElement): Promise<void> {
  const obj = await core(no).getDeviceInformation();
  obj.range.acc = parseInt(dom.value);
  obj.lr = 0xFF;
  await core(no).setDeviceInformation(obj);
}

/** ジャイロセンサのレンジを変更する */
export async function changeGryoRange(no: number, dom: HTMLSelectElement): Promise<void> {
  const obj = await core(no).getDeviceInformation();
  obj.range.gyro = parseInt(dom.value);
  obj.lr = 0xFF;
  await core(no).setDeviceInformation(obj);
}

/** LED の明るさを変更する */
export async function changeLEDBrightness(no: number, dom: HTMLInputElement): Promise<void> {
  const obj = await core(no).getDeviceInformation();
  obj.led_brightness = parseInt(dom.value);
  obj.lr = 0xFF;
  await core(no).setDeviceInformation(obj);
}

/** 取り付け位置（左右・足背/足底）を変更する */
export async function changeLR(no: number, dom: HTMLSelectElement): Promise<void> {
  const obj = await core(no).getDeviceInformation();
  obj.lr = parseInt(dom.value);
  await core(no).setDeviceInformation(obj);
}

/** 設定モーダルの表示をデバイスの現在値に合わせる */
export async function updateModalParameters(no: number): Promise<void> {
  const obj = await core(no).getDeviceInformation();

  const acc = byId<HTMLSelectElement>(`select_acc${no}`);
  const accOption = acc?.options[obj.range.acc];
  if (accOption) accOption.selected = true;

  const gyro = byId<HTMLSelectElement>(`select_gyro${no}`);
  const gyroOption = gyro?.options[obj.range.gyro];
  if (gyroOption) gyroOption.selected = true;

  const brightness = byId<HTMLInputElement>(`range_brightness${no}`);
  if (brightness) brightness.value = String(obj.led_brightness);

  const lr = byId<HTMLSelectElement>(`select_lr${no}`);
  const lrOption = lr?.options[obj.lr];
  if (lrOption) lrOption.selected = true;
}

/** 姿勢と歩行解析をリセットする */
export function resetCoreModule(id: number): void {
  void core(id).resetMotionSensorAttitude();
  void core(id).resetAnalysisLogs();
}

/** バッテリー残量（3 段階）に合わせてアイコンを更新する */
export async function updateBatteryInfo(dom: Element): Promise<void> {
  const number = parseInt(dom.getAttribute('core_id') || '0');
  const obj = await core(number).getDeviceInformation();
  let str_battery_status: string | undefined;
  if (obj.battery == 0) str_battery_status = 'empty';
  else if (obj.battery == 1) str_battery_status = 'normal';
  else if (obj.battery == 2) str_battery_status = 'full';
  const icon = byId(`icon_battery${number}`);
  if (!icon) return;
  icon.setAttribute('title', `${str_battery_status} `);

  if (obj.battery == 0) {
    icon.innerHTML = '<i class="bi bi-battery"></i>';
    icon.className = 'text-warning';
  } else if (obj.battery == 1) {
    icon.innerHTML = '<i class="bi bi-battery-half"></i>';
  } else if (obj.battery == 2) {
    icon.innerHTML = '<i class="bi bi-battery-full"></i>';
  }
}

/** LED の発光パターンを 1〜6 → 消灯 の順に切り替える */
export function toggleLED(dom: Element): void {
  let number = parseInt(dom.getAttribute('number') || '0');
  const id = parseInt(dom.getAttribute('value') || '0');
  number++;
  if (number > 6) number = 0;
  const label = byId(`led_number${id}`);
  if (label) label.innerText = String(number);
  if (number == 0) {
    void core(id).setLED(0, 0);
  } else {
    void core(id).setLED(1, number);
  }
  dom.setAttribute('number', String(number));
}

/** 接続トグルをオフ表示にする */
export function setHeaderStatusOffline(id: number): void {
  const sw = byId<HTMLInputElement>(`switch_ble${id}`);
  if (sw) sw.checked = false;
}

/** buildElement の別名 */
export const CTbuildElement = buildElement;
