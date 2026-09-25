/**
 * CoreCompanionToolkit: INSOLE ページに同居する ORPHE CORE 1 台の接続 GUI。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Orphe } from '../../src/compat/orphe-core.ts';
import { ORPHE_UUID } from '../../src/protocol/uuids.ts';
import {
  buildCoreCompanionToolkit,
  changeCoreCompanionNotification,
  isOrpheCoreSdkLoaded,
  orpheCore,
  setOrpheCore,
  toggleCoreCompanion,
} from '../../src/toolkit/core-companion-toolkit.ts';
import { installDom } from '../helpers/dom.ts';
import { MemoryStorage, MockBluetooth } from '../helpers/mock-bluetooth.ts';
import { mockCoreDevice } from '../helpers/core-device.ts';

installDom();

function setup(options: Parameters<typeof buildCoreCompanionToolkit>[2] = {}) {
  document.body.innerHTML = '<div id="toolkit"></div>';
  const bluetooth = new MockBluetooth();
  const core = new Orphe(0, {
    bluetooth,
    storage: new MemoryStorage(),
    wait: async () => {},
    profile: { settleMs: 0, timeSyncSamples: 1, acceptExtendedSensorValues: true },
  });
  core.onError = () => {};
  setOrpheCore(core);
  buildCoreCompanionToolkit(document.getElementById('toolkit')!, 'CORE', options);
  const input = document.getElementById('switch_core0') as HTMLInputElement;
  const ui = document.getElementById('ui_core0')!;
  return { core, bluetooth, input, ui };
}

test('CORE の SDK は常に使える', () => {
  assert.equal(isOrpheCoreSdkLoaded(), true);
});

test('トグル ON で指定の通知・レンジで接続し、OFF で切断する。通知の変更は次回接続で使う', async () => {
  const { core, bluetooth, input, ui } = setup({ notification: 'SENSOR_VALUES', range: { acc: 8, gyro: 1000 } });
  assert.equal(orpheCore, core);
  const first = mockCoreDevice();
  bluetooth.chooserQueue.push(first.device);

  input.checked = true;
  await toggleCoreCompanion(input);
  assert.equal(core.isConnected(), true);
  assert.equal(core.notification_type, 'SENSOR_VALUES');
  assert.equal(ui.style.visibility, 'visible');
  const written = first.deviceInfo.written[0]!;
  assert.deepEqual([written[7], written[8]], [2, 2], 'range は index に変換して書き込む');

  input.checked = false;
  await toggleCoreCompanion(input);
  assert.equal(core.isConnected(), false);
  assert.equal(ui.style.visibility, 'hidden');

  changeCoreCompanionNotification({ value: 'STEP_ANALYSIS' });
  const second = mockCoreDevice();
  bluetooth.chooserQueue.push(second.device);
  input.checked = true;
  await toggleCoreCompanion(input);
  assert.equal(core.notification_type, 'STEP_ANALYSIS');
  assert.equal(bluetooth.requestDeviceCalls.length, 2, '毎回 chooser を出す');
  core.stop();
});

test('chooser は既定で CR- の名前でも拾い、chooserNamePrefix で差し替えられる', async () => {
  const { bluetooth, input } = setup();
  input.checked = true;
  await toggleCoreCompanion(input);
  assert.deepEqual(bluetooth.requestDeviceCalls[0]?.filters, [
    { namePrefix: 'CR-' },
    { services: [ORPHE_UUID.INFORMATION_SERVICE] },
  ]);

  buildCoreCompanionToolkit(document.getElementById('toolkit')!, 'CORE', { chooserNamePrefix: 'ORPHE' });
  input.checked = true;
  await toggleCoreCompanion(input);
  assert.deepEqual(bluetooth.requestDeviceCalls[1]?.filters?.[0], { namePrefix: 'ORPHE' });
});

test('header 50 の 104 バイト版パケットも受け取る', async () => {
  const { core, bluetooth, input } = setup({ notification: 'SENSOR_VALUES' });
  const { device, sensor } = mockCoreDevice();
  bluetooth.chooserQueue.push(device);
  input.checked = true;
  await toggleCoreCompanion(input);

  let accs = 0;
  core.gotAcc = () => { accs++; };
  const packet = new DataView(new ArrayBuffer(104));
  packet.setUint8(0, 50);
  packet.setUint16(1, 1);
  sensor.emit(packet);
  assert.equal(accs, 4, '1 パケット 4 フレーム');
  core.stop();
});

test('begin() が終わらなければ connectTimeoutMs でトグルを戻す', async () => {
  const { core, input, ui } = setup({ connectTimeoutMs: 50 });
  core.begin = () => new Promise(() => {});
  const warn = console.warn;
  console.warn = () => {};
  try {
    input.checked = true;
    await toggleCoreCompanion(input);
  } finally {
    console.warn = warn;
  }
  assert.equal(input.checked, false);
  assert.equal(ui.style.visibility, 'hidden');
});
