/**
 * CoreToolkit: 生成した UI から接続・切断・LED・設定変更ができること。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Orphe } from '../../src/compat/orphe-core.ts';
import {
  buildCoreToolkit,
  changeAccRange,
  cores,
  guardCoreToolkitBluetooth,
  resetCoreModule,
  toggleCoreModule,
  toggleLED,
  updateModalParameters,
} from '../../src/toolkit/core-toolkit.ts';
import { installDom } from '../helpers/dom.ts';
import { MemoryStorage, MockBluetooth } from '../helpers/mock-bluetooth.ts';
import { mockCoreDevice } from '../helpers/core-device.ts';

installDom();

// 実タブ間共有は BroadcastChannel とタイマーを使うため、共有を扱わないテストでは無効にする
const NO_SHARING = { useSharedBridge: false };

function setup(id = 0) {
  document.body.innerHTML = '<div id="toolkit"></div><div id="message"></div>';
  const bluetooth = new MockBluetooth();
  const core = new Orphe(id, {
    bluetooth,
    storage: new MemoryStorage(),
    wait: async () => {},
    profile: { settleMs: 0, timeSyncSamples: 1 },
  });
  const errors: unknown[] = [];
  core.onError = (error) => { errors.push(error); };
  cores[id] = core;
  buildCoreToolkit(document.getElementById('toolkit')!, `CORE ${id}`, id);
  const input = document.getElementById(`switch_ble${id}`) as HTMLInputElement;
  const ui = document.getElementById(`ui${id}`)!;
  return { core, bluetooth, errors, input, ui };
}

test('buildCoreToolkit: トグル・周波数・バッテリー・LED・設定モーダルを生成する', () => {
  setup();
  for (const id of ['switch_ble0', 'ui0', 'freq0', 'icon_battery0', 'icon_led0', 'settings_modal0', 'select_notify0', 'select_acc0', 'select_gyro0', 'select_lr0', 'range_brightness0', 'button_switch_device0']) {
    assert.ok(document.getElementById(id), id);
  }
  assert.equal(document.getElementById('ui0')!.style.visibility, 'hidden');
  assert.equal((document.getElementById('switch_ble0') as HTMLInputElement).getAttribute('notification'), 'STEP_ANALYSIS_AND_SENSOR_VALUES');
});

test('トグル ON で接続して UI を表示し、周波数を表示する。OFF で切断して隠す', async () => {
  const { core, bluetooth, input, ui } = setup();
  const { device } = mockCoreDevice();
  bluetooth.chooserQueue.push(device);

  input.checked = true;
  await toggleCoreModule(input, { autoReconnect: true, range: { acc: -1, gyro: -1 }, useSharedBridge: false });
  assert.equal(core.isConnected(), true);
  assert.equal(core.notification_type, 'STEP_ANALYSIS_AND_SENSOR_VALUES');
  assert.equal(ui.style.visibility, 'visible');
  assert.equal(input.disabled, false);

  core.gotBLEFrequency(49.7);
  assert.equal(document.getElementById('freq0')!.innerHTML, '49 Hz');

  input.checked = false;
  await toggleCoreModule(input, NO_SHARING);
  assert.equal(core.isConnected(), false);
  assert.equal(ui.style.visibility, 'hidden');
});

test('chooser をキャンセルしたらトグルを戻し、onError へ報告する', async () => {
  const { core, input, ui, errors } = setup();
  input.checked = true;
  await toggleCoreModule(input, NO_SHARING);
  assert.equal(input.checked, false);
  assert.equal(ui.style.visibility, 'hidden');
  assert.equal(core.isConnected(), false);
  assert.ok(errors.some(error => /cancelled/.test(String(error))));
});

test('tryRememberedBeforePicker: 記憶デバイスが見つからなければ chooser で選び、chooser は 1 回だけ出す', async () => {
  const { core, bluetooth, input } = setup();
  const remembered = mockCoreDevice();
  bluetooth.chooserQueue.push(remembered.device);
  input.checked = true;
  await toggleCoreModule(input, NO_SHARING);
  core.stop();
  assert.ok(core.getLastBluetoothDeviceInfo());

  // 記憶デバイスは getDevices() に無く、chooser では別のデバイスを選ぶ
  const other = mockCoreDevice();
  bluetooth.chooserQueue.push(other.device);
  const before = bluetooth.requestDeviceCalls.length;
  input.checked = true;
  await toggleCoreModule(input, { ...NO_SHARING, forceDeviceSelection: true, tryRememberedBeforePicker: true });
  assert.equal(core.bluetoothDevice, other.device);
  assert.equal(bluetooth.requestDeviceCalls.length, before + 1, 'chooser は選び直しの 1 回だけ');
});

test('LED パターンの切替、姿勢と解析のリセット', async () => {
  const { bluetooth, input } = setup();
  const { device, deviceInfo } = mockCoreDevice();
  bluetooth.chooserQueue.push(device);
  input.checked = true;
  await toggleCoreModule(input, NO_SHARING);

  const led = document.getElementById('icon_led0')!;
  toggleLED(led);
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(document.getElementById('led_number0')!.innerText, '1');
  assert.deepEqual([...deviceInfo.written.at(-1)!], [0x02, 1, 1]);

  resetCoreModule(0);
  await new Promise(resolve => setTimeout(resolve, 10));
  const tail = deviceInfo.written.slice(-2).map(bytes => bytes[0]);
  assert.deepEqual(tail, [0x03, 0x04]);
});

test('加速度レンジの変更は左右を 0xFF（維持）にして書き込み、モーダルは現在値を選択する', async () => {
  const { bluetooth, input } = setup();
  const { device, deviceInfo } = mockCoreDevice();
  bluetooth.chooserQueue.push(device);
  input.checked = true;
  await toggleCoreModule(input, NO_SHARING);

  const select = document.getElementById('select_acc0') as HTMLSelectElement;
  select.value = '1';
  await changeAccRange(0, select);
  const written = deviceInfo.written.at(-1)!;
  assert.equal(written[0], 0x01);
  assert.equal(written[1], 0xFF);
  assert.equal(written[7], 1);

  await updateModalParameters(0);
  assert.equal((document.getElementById('select_gyro0') as HTMLSelectElement).value, '3');
  assert.equal((document.getElementById('range_brightness0') as HTMLInputElement).value, '100');
});

test('guardCoreToolkitBluetooth: Web Bluetooth が無ければトグルを無効化して案内を出す', () => {
  setup();
  assert.equal(guardCoreToolkitBluetooth({ coreIds: [0], messageElement: '#message' }), false);
  const input = document.getElementById('switch_ble0') as HTMLInputElement;
  assert.equal(input.disabled, true);
  assert.match(document.getElementById('message')!.textContent ?? '', /Web Bluetooth is disabled/);
});
