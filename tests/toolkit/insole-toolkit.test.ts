/**
 * InsoleToolkit: 生成した UI からセッション経由で接続・切断でき、状態が設定モーダルへ反映されること。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OrpheInsole } from '../../src/compat/orphe-insole.ts';
import { OrpheInsoleSimulator } from '../../src/compat/insole-simulator.ts';
import {
  buildInsoleToolkit,
  getInsoleToolkitSession,
  insoles,
  toggleInsoleModule,
  updateInsoleModalParameters,
} from '../../src/toolkit/insole-toolkit.ts';
import { installDom } from '../helpers/dom.ts';
import { MemoryStorage, MockBluetooth } from '../helpers/mock-bluetooth.ts';
import { mockInsoleDevice } from '../helpers/insole-device.ts';

installDom();

function setup(id = 0, options: Parameters<typeof buildInsoleToolkit>[3] = {}) {
  document.body.innerHTML = '<div id="toolkit"></div>';
  const bluetooth = new MockBluetooth();
  const insole = new OrpheInsole(id, { bluetooth, storage: new MemoryStorage(), wait: async () => {} });
  insole.onError = () => {};
  insoles[id] = insole;
  buildInsoleToolkit(document.getElementById('toolkit')!, `INSOLE ${id}`, id, { onError() {}, ...options });
  const input = document.getElementById(`switch_ble${id}`) as HTMLInputElement;
  const ui = document.getElementById(`ui${id}`)!;
  return { insole, bluetooth, input, ui, session: getInsoleToolkitSession(id)! };
}

test('buildInsoleToolkit: トグル・バッジ類と、body 直下の設定モーダルを生成する', () => {
  const { session } = setup();
  for (const id of ['switch_ble0', 'ui0', 'freq0', 'lr_badge0', 'icon_battery0', 'icon_fw0', 'icon_reconnect0', 'output_sensor_values0', 'output_step_analysis0', 'select_sensor_data_mode0', 'select_streaming_mode0']) {
    assert.ok(document.getElementById(id), id);
  }
  assert.equal(document.getElementById('settings_modal0')!.parentElement, document.body);
  assert.equal(session.supportsFifo, true);
  assert.equal(session.supportsStepAnalysis, true);
  assert.equal((document.getElementById('output_sensor_values0') as HTMLInputElement).checked, true);
  assert.equal((document.getElementById('select_streaming_mode0') as HTMLSelectElement).value, '4');
  assert.equal(document.getElementById('toolkit_mode_status0')!.innerText, 'Changes apply on the next connection.');
});

test('fifo: false / gait: false でその機能を設定画面から選べなくする', () => {
  const { session } = setup(0, { fifo: false, gait: false });
  assert.equal(session.supportsFifo, false);
  assert.equal(session.supportsStepAnalysis, false);
  const fifoOption = Array.from((document.getElementById('select_sensor_data_mode0') as HTMLSelectElement).options)
    .find(option => option.value === 'fifo')!;
  assert.equal(fifoOption.disabled, true);
  assert.equal((document.getElementById('output_step_analysis0') as HTMLInputElement).disabled, true);
  assert.equal(document.getElementById('toolkit_mode_note0')!.innerText, 'FIFO is not available. Step Analysis is not available.');
});

test('profile を渡すと初期設定がそのプロファイルになる', () => {
  const { session } = setup(0, { profile: 'realtime-pressure' });
  assert.equal(session.profileId, 'realtime-pressure');
  assert.equal((document.getElementById('select_streaming_mode0') as HTMLSelectElement).value, '3');
});

test('トグル ON でセッション経由で接続し、左右バッジと周波数を更新する。利用者の gotBLEFrequency も呼ぶ', async () => {
  const { insole, bluetooth, input, ui, session } = setup();
  const { device } = mockInsoleDevice();
  bluetooth.chooserQueue.push(device);
  const frequencies: number[] = [];
  insole.gotBLEFrequency = (freq) => { frequencies.push(freq); };

  input.checked = true;
  await toggleInsoleModule(input, { autoReconnect: false });
  assert.equal(session.connected, true);
  assert.equal(insole.isConnected(), true);
  assert.equal(ui.style.visibility, 'visible');
  assert.equal(document.getElementById('lr_badge0')!.innerText, 'R');
  assert.equal(document.getElementById('toolkit_mode_status0')!.innerText, 'Active: Realtime Raw Data');

  insole.gotBLEFrequency(50.4);
  assert.equal(document.getElementById('freq0')!.innerHTML, '50 Hz');
  assert.deepEqual(frequencies, [50.4]);

  await updateInsoleModalParameters(0);
  assert.equal(document.getElementById('info_acc_range0')!.innerText, '16');
  assert.equal(document.getElementById('info_mount_position0')!.innerText, 'RIGHT / plantar(足底)');

  input.checked = false;
  await toggleInsoleModule(input, {});
  assert.equal(session.connected, false);
  assert.equal(insole.isConnected(), false);
  assert.equal(ui.style.visibility, 'hidden');
});

test('chooser をキャンセルしたらトグルを戻す', async () => {
  const { input, session } = setup();
  input.checked = true;
  await toggleInsoleModule(input, {});
  assert.equal(input.checked, false);
  assert.equal(input.disabled, false);
  assert.equal(session.connected, false);
});

test('simulator: true でスロットをシミュレータに差し替え、実機なしで接続できる', async () => {
  document.body.innerHTML = '<div id="toolkit"></div>';
  insoles[1] = new OrpheInsole(1, { bluetooth: new MockBluetooth(), storage: new MemoryStorage() });
  buildInsoleToolkit(document.getElementById('toolkit')!, 'SIM', 1, { simulator: true, onError() {} });
  assert.ok(insoles[1] instanceof OrpheInsoleSimulator);
  const session = getInsoleToolkitSession(1)!;
  assert.equal(session.supportsFifo, false, 'シミュレータでは FIFO を選べない');

  const input = document.getElementById('switch_ble1') as HTMLInputElement;
  input.checked = true;
  await toggleInsoleModule(input, {});
  assert.equal(session.connected, true);
  assert.equal(document.getElementById('ui1')!.style.visibility, 'visible');

  input.checked = false;
  await toggleInsoleModule(input, {});
  assert.equal(session.connected, false);
});
