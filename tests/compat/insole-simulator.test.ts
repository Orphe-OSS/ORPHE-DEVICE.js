/**
 * OrpheInsoleSimulator: 実機なしで got* コールバック / addSensorDataListener が
 * ストリーミングモードどおりに届くこと。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type {
  InsoleSimulatorBeginOptions,
  InsoleSimulatorSensorDataEvent,
  InsoleSimulatorStampedEuler,
} from '../../src/compat/insole-simulator.ts';
import { OrpheInsoleSimulator } from '../../src/compat/insole-simulator.ts';
import type { InsolePress, InsoleStampedQuat, InsoleStampedVec3 } from '../../src/profiles/insole.ts';
import { parseInsoleSensorValues } from '../../src/profiles/insole.ts';

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function collectFor(options: InsoleSimulatorBeginOptions, ms = 300) {
  const simulator = new OrpheInsoleSimulator(0);
  const calls = {
    press: [] as InsolePress[],
    acc: [] as InsoleStampedVec3[],
    gyro: [] as InsoleStampedVec3[],
    quat: [] as InsoleStampedQuat[],
    euler: [] as InsoleSimulatorStampedEuler[],
    convertedAcc: [] as InsoleStampedVec3[],
    convertedGyro: [] as InsoleStampedVec3[],
    frequency: [] as number[],
  };
  simulator.gotPress = (value) => calls.press.push(value);
  simulator.gotAcc = (value) => calls.acc.push(value);
  simulator.gotGyro = (value) => calls.gyro.push(value);
  simulator.gotQuat = (value) => calls.quat.push(value);
  simulator.gotEuler = (value) => calls.euler.push(value);
  simulator.gotConvertedAcc = (value) => calls.convertedAcc.push(value);
  simulator.gotConvertedGyro = (value) => calls.convertedGyro.push(value);
  simulator.gotBLEFrequency = (value) => calls.frequency.push(value);
  await simulator.begin(options);
  await wait(ms);
  return { simulator, calls };
}

test('mode 4 (stand): press / quat / euler が届き、stop() で切断される', async () => {
  const { simulator, calls } = await collectFor({ preset: 'stand', streamingMode: 4 }, 300);
  simulator.stop();

  assert.equal(simulator.isConnected(), false);
  assert.ok(simulator.device_information);
  assert.deepEqual(simulator.device_information.range, { acc: 3, gyro: 3 });
  assert.ok(calls.press.length >= 21 && calls.press.length <= 39, `mode 4 sample count: ${calls.press.length}`);
  assert.ok(calls.press.every((sample) => sample.values.length === 6));
  assert.ok(calls.press.every((sample) => sample.values.every((value) => value >= 0 && value <= 65535)));
  assert.ok(calls.quat.length > 0);
  assert.ok(calls.euler.length > 0);
  assert.ok(calls.frequency.every((value) => value === 50));
});

test('addSensorDataListener: パケット単位のイベントが届き、解除関数を返す', async () => {
  const simulator = new OrpheInsoleSimulator(0);
  const events: InsoleSimulatorSensorDataEvent[] = [];
  const unsubscribe = simulator.addSensorDataListener((event) => events.push(event));
  await simulator.begin({ preset: 'stand', streamingMode: 4 });
  await wait(80);
  simulator.stop();
  assert.ok(events.length >= 2);
  assert.equal(events[0]!.packet.header, 56);
  assert.equal(events[0]!.packet.samples.length, 2);
  assert.equal(events[0]!.packet.samples[0]!.press!.values.length, 6);
  assert.equal(unsubscribe(), true);
  assert.throws(
    () => simulator.addSensorDataListener(null as never),
    /expects a function/,
  );
});

test('mode 3 (walk): press のみで quat / euler は届かない', async () => {
  const { simulator, calls } = await collectFor({ preset: 'walk', streamingMode: 3 }, 120);
  simulator.stop();
  assert.ok(calls.press.length > 0);
  assert.equal(calls.quat.length, 0);
  assert.equal(calls.euler.length, 0);
});

test('mode 1 (walk): quat のみで press は届かない', async () => {
  const { simulator, calls } = await collectFor({ preset: 'walk', streamingMode: 1 }, 120);
  simulator.stop();
  assert.ok(calls.quat.length > 0);
  assert.equal(calls.press.length, 0);
});

test('stop() 後はコールバックが止まる', async () => {
  const { simulator, calls } = await collectFor({ preset: 'sway', streamingMode: 4 }, 120);
  assert.ok(calls.press.length > 0);
  const pressCount = calls.press.length;
  const accCount = calls.acc.length;
  simulator.stop();
  await wait(100);
  assert.equal(calls.press.length, pressCount);
  assert.equal(calls.acc.length, accCount);
});

test('frames 再生: 値・メタ情報がそのまま届き、loop: false なら末尾で停止する', async () => {
  const frame = {
    device: 0,
    t: 123,
    serial: 42,
    press: [1, 2, 3, 4, 5, 6],
    acc: { x: 8, y: -4, z: 16 },
    gyro: { x: 200, y: -400, z: 1000 },
    quat: { w: 1, x: 0, y: 0.1, z: 0 },
    euler: { pitch: 0.2, roll: -0.1, yaw: 0.05 },
  };
  const simulator = new OrpheInsoleSimulator(0);
  const calls = {
    press: [] as InsolePress[],
    acc: [] as InsoleStampedVec3[],
    gyro: [] as InsoleStampedVec3[],
    convertedAcc: [] as InsoleStampedVec3[],
    convertedGyro: [] as InsoleStampedVec3[],
    quat: [] as InsoleStampedQuat[],
    euler: [] as InsoleSimulatorStampedEuler[],
  };
  simulator.gotPress = (value) => calls.press.push(value);
  simulator.gotAcc = (value) => calls.acc.push(value);
  simulator.gotGyro = (value) => calls.gyro.push(value);
  simulator.gotConvertedAcc = (value) => calls.convertedAcc.push(value);
  simulator.gotConvertedGyro = (value) => calls.convertedGyro.push(value);
  simulator.gotQuat = (value) => calls.quat.push(value);
  simulator.gotEuler = (value) => calls.euler.push(value);

  await simulator.begin({ frames: [frame], loop: false, streamingMode: 4 });
  await wait(50);

  assert.equal(simulator.isConnected(), false);
  assert.deepEqual(calls.press[0]!.values, frame.press);
  assert.equal(calls.press[0]!.timestamp, frame.t);
  assert.equal(calls.press[0]!.serial_number, frame.serial);
  assert.equal(calls.acc[0]!.x, frame.acc.x / 16);
  assert.equal(calls.acc[0]!.y, frame.acc.y / 16);
  assert.equal(calls.acc[0]!.z, frame.acc.z / 16);
  assert.deepEqual(
    {
      x: calls.convertedAcc[0]!.x,
      y: calls.convertedAcc[0]!.y,
      z: calls.convertedAcc[0]!.z,
    },
    frame.acc,
  );
  assert.deepEqual(
    {
      x: calls.convertedGyro[0]!.x,
      y: calls.convertedGyro[0]!.y,
      z: calls.convertedGyro[0]!.z,
    },
    frame.gyro,
  );
  // 正規化値と物理値の関係は実機パケットと同じ規則:
  // gotGyro = raw/32768, gotConvertedGyro = raw × 0.07 dps/LSB（±2000dps）
  // → 正規化値 = 物理値 / (32768 × 0.07)。物理値 / 2000 ではない。
  for (const axis of ['x', 'y', 'z'] as const) {
    const expected = frame.gyro[axis] / (32768 * 0.07);
    assert.ok(
      Math.abs(calls.gyro[0]![axis] - expected) < 1e-12,
      `normalized gyro ${axis}: expected ${expected}, got ${calls.gyro[0]![axis]}`,
    );
  }
  assert.equal(calls.quat[0]!.w, frame.quat.w);
  assert.equal(calls.euler[0]!.pitch, frame.euler.pitch);
});

test('gyro の正規化値 ↔ 物理値の換算が parseInsoleSensorValues（±2000dps）と一致する', async () => {
  // header 55 (mode 3): 各フレームの gyro は offset 8 + 24*i から int16 x/y/z
  const data = new DataView(new ArrayBuffer(104));
  data.setUint8(0, 55);
  for (let i = 0; i < 4; i++) {
    data.setInt16(8 + 24 * i, 1000);
    data.setInt16(10 + 24 * i, -12345);
    data.setInt16(12 + 24 * i, 32767);
  }
  const parsed = parseInsoleSensorValues(data, { gyroRange: 2000 })!.samples[0]!;
  const parsedGyro = parsed.gyro!;
  const parsedConverted = parsed.converted_gyro!;

  const simulator = new OrpheInsoleSimulator(0);
  const gyro: InsoleStampedVec3[] = [];
  const convertedGyro: InsoleStampedVec3[] = [];
  simulator.gotGyro = (value) => gyro.push(value);
  simulator.gotConvertedGyro = (value) => convertedGyro.push(value);
  const frameGyro = { x: parsedConverted.x, y: parsedConverted.y, z: parsedConverted.z };
  await simulator.begin({ frames: [{ gyro: frameGyro }], loop: false, streamingMode: 3 });

  assert.equal(simulator.isConnected(), false);
  for (const axis of ['x', 'y', 'z'] as const) {
    assert.equal(convertedGyro[0]![axis], parsedConverted[axis]);
    assert.ok(
      Math.abs(gyro[0]![axis] - parsedGyro[axis]) < 1e-12,
      `normalized gyro ${axis}: parser ${parsedGyro[axis]}, simulator ${gyro[0]![axis]}`,
    );
  }
});

test('begin 前の getDeviceInformation / 実行中の setDataStreamingMode / resetAnalysisLogs', async () => {
  const simulator = new OrpheInsoleSimulator(1);

  // getDeviceInformation は begin 前でも既定値を返す
  const info = await simulator.getDeviceInformation();
  assert.equal(info.mount_position, 1, 'id=1 → RIGHT');
  assert.deepEqual(info.range, { acc: 3, gyro: 3 });

  // setDataStreamingMode: 実行中のモード切替が次 tick から反映される
  const calls = { press: [] as InsolePress[], quat: [] as InsoleStampedQuat[] };
  simulator.gotPress = (value) => calls.press.push(value);
  simulator.gotQuat = (value) => calls.quat.push(value);
  await simulator.begin({ preset: 'stand', streamingMode: 4 });
  assert.equal(simulator.streaming_mode, 4);
  await wait(100);
  assert.ok(calls.quat.length > 0, 'mode 4 emits quat');

  await simulator.setDataStreamingMode(3);
  assert.equal(simulator.streaming_mode, 3);
  const quatCountAtSwitch = calls.quat.length;
  const pressCountAtSwitch = calls.press.length;
  await wait(120);
  assert.equal(calls.quat.length, quatCountAtSwitch, 'mode 3 stops quat');
  assert.ok(calls.press.length > pressCountAtSwitch, 'press keeps flowing after switch');

  // OrpheInsole と同じエラーメッセージで不正モードを拒否
  await assert.rejects(() => simulator.setDataStreamingMode(2), /Invalid ORPHE INSOLE data streaming mode/);
  assert.equal(simulator.streaming_mode, 3, 'invalid mode does not change state');

  // resetAnalysisLogs は no-op（例外を投げない）
  simulator.resetAnalysisLogs();
  simulator.stop();
});
