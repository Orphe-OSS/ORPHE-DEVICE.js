/**
 * FifoRecorder — プロトコルの純関数・ループ状態機械・開始可否の単体テスト。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DrainBudget, FifoLoopState } from '../../src/fifo/state.ts';
import {
  FIFO_CSV_HEADER,
  FIFO_FRAME_INTERVAL_MS,
  accToG,
  buildRequestsFromSerials,
  calcExpectedSerials,
  createGetSensorDataRequest,
  decodeFifoPacket,
  expandRequestsToList,
  extractSerialIfSensorPacket,
  extractTimestampMs,
  gyroToDps,
  packetToCsvRows,
  parseCurrentSerial,
  parseNoDataResponse,
  pressureToN,
  rawStoreToCSV,
  serialDistance,
  timestampToStr,
} from '../../src/fifo/protocol.ts';
import { FifoRecorder } from '../../src/fifo/recorder.ts';
import { legacyPressureToNewton } from '../../src/protocol/pressure-calibration.ts';
import type { PressureCalibration } from '../../src/protocol/pressure-calibration.ts';
import type { FifoRequestRange } from '../../src/fifo/protocol.ts';

function view(bytes: number[]): DataView {
  return new DataView(Uint8Array.from(bytes).buffer);
}

function assertClose(actual: number, expected: number, message?: string): void {
  assert.ok(Math.abs(actual - expected) < 1e-9, message ?? `${actual} ≈ ${expected}`);
}

// ── 単位変換 ─────────────────────────────────────────────────────────

test('accToG: int16 を ±16G に換算する', () => {
  assert.equal(accToG(0x08, 0x00), 1); // 2048
  assert.equal(accToG(0x40, 0x00), 8); // 16384
  assert.equal(accToG(0x80, 0x00), -16); // -32768
  assert.equal(accToG(0xff, 0xff), -16 / 32768); // -1
});

test('gyroToDps: int16 × 0.07 dps', () => {
  assert.equal(gyroToDps(0x03, 0xe8), 70); // 1000
  assertClose(gyroToDps(0xff, 0x9c), -7); // -100
  assertClose(gyroToDps(0x7f, 0xff), 2293.69); // 32767
});

test('pressureToN: ch ごとの多項式。負値は 0、範囲外の ch は 0', () => {
  // x = 0 では定数項（ch6 は負なので 0）
  assert.deepEqual([1, 2, 3, 4, 5, 6].map((n) => pressureToN(0, n)), [22.5012, 6.97927, 31.8015, 3.10811, 3.71484, 0]);
  assertClose(pressureToN(1000, 1), 16.988);
  assert.equal(pressureToN(1000, 0), 0);
  assert.equal(pressureToN(1000, 7), 0);
});

// ── シリアル番号 ─────────────────────────────────────────────────────

test('serialDistance / calcExpectedSerials: uint16 の巻き戻りをまたぐ', () => {
  assert.equal(serialDistance(65534, 2), 4);
  assert.equal(serialDistance(2, 65534), 65532);
  assert.equal(serialDistance(5, 5), 0);
  assert.deepEqual(calcExpectedSerials(65534, 4), [65534, 65535, 0, 1]);
  assert.deepEqual(calcExpectedSerials(10, 0), []);
});

test('buildRequestsFromSerials: 連番の塊にまとめる（数値順に並べる）', () => {
  assert.deepEqual(buildRequestsFromSerials([]), []);
  assert.deepEqual(buildRequestsFromSerials(new Set([42, 10, 12, 40, 41])), [[10, 1], [12, 1], [40, 3]]);
  // 巻き戻りをまたぐ集合は数値順のため 65535 と 0 はつながらない
  assert.deepEqual(buildRequestsFromSerials(new Set([65534, 65535, 0, 1, 5])), [[0, 2], [5, 1], [65534, 2]]);
});

test('expandRequestsToList: (start, count) を要求順のシリアル列に展開する', () => {
  assert.deepEqual(expandRequestsToList([]), []);
  assert.deepEqual(expandRequestsToList([[65534, 3], [7, 2]]), [65534, 65535, 0, 7, 8]);
});

// ── コマンド・応答 ───────────────────────────────────────────────────

test('createGetSensorDataRequest: 0x0B 0x02 + 30 組ぶん（不足は 0 埋め）の 122 バイト', () => {
  const request = createGetSensorDataRequest([[0x1234, 0x0102], [65535, 300]]);
  assert.equal(request.length, 122);
  assert.deepEqual([...request.slice(0, 10)], [0x0b, 0x02, 0x12, 0x34, 0x01, 0x02, 0xff, 0xff, 0x01, 0x2c]);
  assert.ok(request.slice(10).every((byte) => byte === 0));

  const empty = createGetSensorDataRequest([]);
  assert.equal(empty.length, 122);
  assert.deepEqual([...empty.slice(0, 2)], [0x0b, 0x02]);
  assert.ok(empty.slice(2).every((byte) => byte === 0));
});

test('createGetSensorDataRequest: 31 組以上は RangeError', () => {
  const tooMany: FifoRequestRange[] = Array.from({ length: 31 }, (_, i) => [i, 1]);
  assert.throws(() => createGetSensorDataRequest(tooMany), RangeError);
});

test('parseNoDataResponse: 0x35 0x02 start count。足りないフィールドは 0', () => {
  assert.deepEqual(parseNoDataResponse(view([0x35, 0x02, 0x00, 0x0a, 0x00, 0x03])), [10, 3]);
  assert.deepEqual(parseNoDataResponse(view([0x35, 0x02, 0x01, 0x00])), [256, 0]);
  assert.deepEqual(parseNoDataResponse(view([0x35, 0x02])), [0, 0]);
  assert.equal(parseNoDataResponse(view([0x35, 0x01, 0x00, 0x0a, 0x00, 0x03])), null);
  assert.equal(parseNoDataResponse(view([0x36, 0x02, 0x00, 0x0a, 0x00, 0x03])), null);
  assert.equal(parseNoDataResponse(view([0x35])), null);
});

test('extractSerialIfSensorPacket: 0x36 ならシリアル番号', () => {
  assert.equal(extractSerialIfSensorPacket(view([0x36, 0x12, 0x34])), 0x1234);
  assert.equal(extractSerialIfSensorPacket(view([0x35, 0x12, 0x34])), null);
  assert.equal(extractSerialIfSensorPacket(view([0x36, 0x12])), null);
});

test('parseCurrentSerial: 0x35 0x01 serial watermark accumulated', () => {
  assert.deepEqual(parseCurrentSerial(view([0x35, 0x01, 0xff, 0xfe, 0x0a, 0x05, 0xdc])), {
    serial: 65534,
    watermark: 10,
    accumulated: 1500,
  });
  assert.equal(parseCurrentSerial(view([0x35, 0x01, 0xff, 0xfe, 0x0a, 0x05])), null);
  assert.equal(parseCurrentSerial(view([0x35, 0x02, 0xff, 0xfe, 0x0a, 0x05, 0xdc])), null);
});

test('timestampToStr: HH:MM:SS:mmm（オフセットの繰り上がり・日またぎ）', () => {
  assert.equal(timestampToStr(0, 0, 0, 0, 0), '00:00:00:000');
  assert.equal(timestampToStr(12, 34, 56, 789, 0), '12:34:56:789');
  assert.equal(timestampToStr(12, 34, 56, 995, 10), '12:34:57:005');
  assert.equal(timestampToStr(23, 59, 59, 999, 5), '00:00:00:004');
  assert.equal(timestampToStr(10, 59, 59, 990, 2015), '11:00:02:005');
});

// ── データパケット ───────────────────────────────────────────────────

/**
 * 104 バイトの FIFO データパケット。フレーム i（バイト順で i 番目）は
 * gyro = (1000(i+1), -100, 0) LSB、acc = (2048(i+1), -2048, 0) LSB、press = pressRaw。
 */
function makeFifoPacket(
  serial: number,
  time: { h: number; m: number; s: number; ms: number },
  pressRaw: number[] = [0, 0, 0, 0, 0, 0]
): DataView {
  const bytes = [0x36, (serial >> 8) & 0xff, serial & 0xff, time.h, time.m, time.s, (time.ms >> 8) & 0xff, time.ms & 0xff];
  for (let i = 0; i < 4; i++) {
    for (const value of [1000 * (i + 1), -100, 0, 2048 * (i + 1), -2048, 0]) {
      bytes.push((value >> 8) & 0xff, value & 0xff);
    }
    for (const value of pressRaw) bytes.push((value >> 8) & 0xff, value & 0xff);
  }
  return view(bytes);
}

test('extractTimestampMs: その日の 0 時からの経過ミリ秒', () => {
  assert.equal(extractTimestampMs(makeFifoPacket(10, { h: 1, m: 2, s: 3, ms: 456 })), 3723456);
});

test('decodeFifoPacket: 4 フレームを古い順（バイト列の末尾フレームから）に並べる', () => {
  const packet = decodeFifoPacket(makeFifoPacket(10, { h: 1, m: 2, s: 3, ms: 456 }, [0, 1000, 2000, 3000, 4000, 5000]));
  assert.equal(packet.serial, 10);
  assert.equal(packet.timestamp, 3723456);
  assert.equal(packet.samples.length, 4);

  packet.samples.forEach((sample, k) => {
    const frame = 3 - k; // 先頭サンプルはバイト列の 4 番目のフレーム
    assert.equal(sample.serial_number, 10);
    assert.equal(sample.packet_number, k);
    assert.equal(sample.t, 3723456 + k * FIFO_FRAME_INTERVAL_MS);
    assertClose(sample.converted_gyro.x, 70 * (frame + 1));
    assertClose(sample.converted_gyro.y, -7);
    assert.equal(sample.converted_gyro.z, 0);
    assert.deepEqual(sample.converted_acc, { x: frame + 1, y: -1, z: 0 });
    assert.deepEqual(sample.press, { values: [0, 1000, 2000, 3000, 4000, 5000], serial_number: 10, packet_number: k });
  });
});

// ── CSV ──────────────────────────────────────────────────────────────

test('packetToCsvRows: 1 パケット 4 行。timestamp は 5ms 刻み、圧力は固定式で N', () => {
  const rows = packetToCsvRows(makeFifoPacket(10, { h: 1, m: 2, s: 3, ms: 456 }));
  assert.deepEqual(rows, [
    '10, 01:02:03:456,   280.00,    -7.00,     0.00,   4.0000,  -1.0000,   0.0000,  22.5012,   6.9793,  31.8015,   3.1081,   3.7148,   0.0000',
    '10, 01:02:03:461,   210.00,    -7.00,     0.00,   3.0000,  -1.0000,   0.0000,  22.5012,   6.9793,  31.8015,   3.1081,   3.7148,   0.0000',
    '10, 01:02:03:466,   140.00,    -7.00,     0.00,   2.0000,  -1.0000,   0.0000,  22.5012,   6.9793,  31.8015,   3.1081,   3.7148,   0.0000',
    '10, 01:02:03:471,    70.00,    -7.00,     0.00,   1.0000,  -1.0000,   0.0000,  22.5012,   6.9793,  31.8015,   3.1081,   3.7148,   0.0000',
  ]);
});

test('rawStoreToCSV: ヘッダ + 時刻順の行。データパケット以外は飛ばす', () => {
  const later = makeFifoPacket(0, { h: 0, m: 0, s: 1, ms: 0 }); // 巻き戻り後のシリアル 0
  const earlier = makeFifoPacket(65535, { h: 0, m: 0, s: 0, ms: 980 });
  const store = new Map<number, DataView>([
    [0, later],
    [65535, earlier],
    [1, view([0x35, 0x02, 0, 1, 0, 1, 0, 0])], // 並べ替えで時刻を読むので 8 バイトは必要
  ]);
  const lines = rawStoreToCSV(store).split('\n');
  assert.equal(lines[0], FIFO_CSV_HEADER);
  assert.equal(lines.length, 1 + 8 + 1); // ヘッダ + 2 パケット × 4 行 + 末尾の改行
  assert.equal(lines.at(-1), '');
  assert.deepEqual(lines.slice(1, 9).map((line) => line.split(', ').slice(0, 2).join(' ')), [
    '65535 00:00:00:980', '65535 00:00:00:985', '65535 00:00:00:990', '65535 00:00:00:995',
    '0 00:00:01:000', '0 00:00:01:005', '0 00:00:01:010', '0 00:00:01:015',
  ]);
});

test('CSV: 個体別校正係数を渡すと、その ch は係数で、null の ch は旧式で N に換算する', () => {
  const pressRaw = [100, 200, 300, 400, 500, 600];
  const dv = makeFifoPacket(10, { h: 1, m: 2, s: 3, ms: 456 }, pressRaw);
  const calibrations: (PressureCalibration | null)[] = [
    { func: 1, coefficients: [0, 0, 0, 1, 0] }, // y = x
    { func: 1, coefficients: [0, 0, 0, 2, 0] }, // y = 2x
    null, null, null, null,
  ];
  const rows = packetToCsvRows(dv, calibrations);
  const plain = packetToCsvRows(dv);
  assert.equal(rows.length, 4);
  for (let i = 0; i < rows.length; i++) {
    const cells = rows[i]!.split(', ');
    assert.deepEqual(cells.slice(0, 8), plain[i]!.split(', ').slice(0, 8)); // serial / timestamp / gyro / acc は同じ
    assert.equal(Number(cells[8]), 100);
    assert.equal(Number(cells[9]), 400);
    assert.equal(Number(cells[10]), Number(legacyPressureToNewton(300).toFixed(4)));
  }
  const store = new Map<number, DataView>([[10, dv]]);
  assert.equal(rawStoreToCSV(store, calibrations).split('\n')[1], rows[0]);
});

// ── FifoLoopState ────────────────────────────────────────────────────

test('calcRequestRange: 未同期なら直近 accumulated 件、同期後は lastSerial の次から', () => {
  const state = new FifoLoopState();
  assert.deepEqual(state.calcRequestRange(100, 5, 200), [96, 5]);
  assert.equal(state.updateAfterResponse(new Set(), new Set(), 96, 5), 'ok');
  assert.equal(state.lastSerial, 100);

  assert.deepEqual(state.calcRequestRange(110, 10, 4), [101, 4]); // maxNewRequest で頭打ち

  state.lastSerial = 65534;
  assert.deepEqual(state.calcRequestRange(3, 5, 200), [65535, 5]); // 巻き戻りをまたぐ

  assert.deepEqual(new FifoLoopState().calcRequestRange(42, 0, 200), [0, 0]);
  assert.equal(state.dropped, 0);
});

test('calcRequestRange: リングバッファ容量を超えて遅れた分は ring_overflow として計上する', () => {
  const state = new FifoLoopState();
  state.lastSerial = 0;
  state.carryOver = [[1, 1]];
  assert.deepEqual(state.calcRequestRange(1600, 1500, 200), [101, 200]);
  assert.equal(state.lastSerial, 100);
  assert.equal(state.dropped, 100);
  assert.deepEqual(state.lossEvents, [{ reason: 'ring_overflow', dropped: 100 }]);
  assert.deepEqual(state.carryOver, []);
});

test('updateAfterResponse: BLE で落ちたシリアルは carryOver へ、lastSerial は要求範囲の末尾へ', () => {
  const state = new FifoLoopState();
  state.lastSerial = 100;
  assert.equal(state.updateAfterResponse(new Set([103, 104, 107]), new Set(), 101, 10), 'ok');
  assert.equal(state.lastSerial, 110);
  assert.deepEqual(state.carryOver, [[103, 2], [107, 1]]);
});

test('updateAfterResponse: carryOver が上限を超えたら諦めて再同期し、次の要求でバックログを計上する', () => {
  const state = new FifoLoopState();
  state.lastSerial = 0;
  const lost = new Set(Array.from({ length: 101 }, (_, i) => i + 1));
  assert.equal(state.updateAfterResponse(lost, new Set(), 1, 150), 'resync');
  assert.equal(state.dropped, 101);
  assert.equal(state.lastSerial, null);
  assert.equal(state.resyncPending, true);
  assert.deepEqual(state.carryOver, []);

  // 再同期: 直近 200 件だけ要求し、残り 100 件は resync_backlog
  assert.deepEqual(state.calcRequestRange(500, 300, 200), [301, 200]);
  assert.equal(state.dropped, 201);
  assert.deepEqual(state.lossEvents, [
    { reason: 'carryover_overflow', dropped: 101 },
    { reason: 'resync_backlog', dropped: 100 },
  ]);
  assert.equal(state.resyncPending, false);
});

test('updateAfterResponse: 新規レンジの no-data は再同期するが、carryOver は残す', () => {
  const state = new FifoLoopState();
  state.lastSerial = 10;
  state.carryOver = [[5, 1]];
  assert.equal(state.updateAfterResponse(new Set(), new Set([11]), 11, 3), 'ok');
  assert.equal(state.lastSerial, null);
  assert.equal(state.resyncPending, true);
  assert.deepEqual(state.carryOver, [[5, 1]]);
});

test('noteStored / noteSpanTarget / finalizePendingLoss: 収録スパン内の未回収を stopped_pending にする', () => {
  const state = new FifoLoopState();
  state.noteStored(10);
  state.noteStored(12);
  assert.deepEqual([state.firstStoredSerial, state.storedSpanMax], [10, 2]);
  state.noteStored(9); // より手前が来たら起点を巻き戻す
  assert.deepEqual([state.firstStoredSerial, state.storedSpanMax], [9, 3]);
  for (const serial of [9, 10, 12]) state.rawStore.set(serial, new DataView(new ArrayBuffer(1)));

  state.noteSpanTarget(15);
  assert.equal(state.storedSpanMax, 6);
  state.noteSpanTarget(9 + 40000); // 半周を超える値は無視
  assert.equal(state.storedSpanMax, 6);

  // スパン 9..15 の 7 件のうち格納 3 件 → 4 件
  assert.equal(state.finalizePendingLoss(), 4);
  assert.equal(state.dropped, 4);
  assert.deepEqual(state.lossEvents, [{ reason: 'stopped_pending', dropped: 4 }]);
  assert.equal(state.finalizePendingLoss(), 0);

  const wrapped = new FifoLoopState();
  wrapped.noteStored(65535);
  wrapped.noteStored(1);
  assert.deepEqual([wrapped.firstStoredSerial, wrapped.storedSpanMax], [65535, 2]);
});

// ── DrainBudget ──────────────────────────────────────────────────────

test('DrainBudget: 予算と絶対上限（予算 × 10）', () => {
  const budget = new DrainBudget(100, 1000);
  assert.deepEqual([budget.budgetMs, budget.deadline, budget.hardDeadline], [100, 1100, 2000]);

  const negative = new DrainBudget(-5, 1000);
  assert.deepEqual([negative.budgetMs, negative.deadline, negative.hardDeadline], [0, 1000, 1000]);

  const fromDeadline = DrainBudget.fromDeadline(5000, 1000); // 延長なし
  assert.deepEqual([fromDeadline.budgetMs, fromDeadline.deadline, fromDeadline.hardDeadline], [4000, 5000, 5000]);

  // coerce: number は「延長なしの絶対期限」扱い
  const coerced = DrainBudget.coerce(Date.now() + 500);
  assert.ok(coerced.remainingMs() > 0 && coerced.remainingMs() <= 500);
});

// ─── FW による開始可否 ─────────────────────────────────────────────

function fakeHost(availableModes?: { id: string }[]) {
  const writes: unknown[] = [];
  const errors: unknown[] = [];
  let sinkCalls = 0;
  const host = {
    id: 0,
    transport: { write: async (_uuid: string, data: unknown) => { writes.push(data); } },
    profile: { kind: 'insole', streaming_mode: 4 },
    isConnected: () => true,
    setNotifySink: () => { sinkCalls++; return () => {}; },
    reportError: (error: unknown) => { errors.push(error); },
    ...(availableModes ? { availableModes } : {}),
  };
  return { host, writes, errors, sinkCalls: () => sinkCalls };
}

test('start(): 使えるモードに FIFO が無いホストでは、コマンドを送らず UNSUPPORTED_MODE を報告する', async () => {
  const h = fakeHost([{ id: 'STREAMING_4' }, { id: 'STEP_ANALYSIS' }]);
  const fifo = new FifoRecorder(h.host);
  assert.equal(await fifo.start(), false);
  assert.deepEqual(h.writes, []);
  assert.equal(h.sinkCalls(), 0);
  assert.equal((h.errors[0] as { code?: string }).code, 'UNSUPPORTED_MODE');
});

// ─── reset() ─────────────────────────────────────────────────────

test('reset(): 収集済みデータと損失カウントを捨てる', () => {
  const fifo = new FifoRecorder({
    id: 0,
    transport: { write: async () => undefined },
    profile: { kind: 'insole', streaming_mode: 4 },
    isConnected: () => true,
    setNotifySink: () => () => {},
    reportError: () => {},
  });
  fifo.state.rawStore.set(1, new DataView(new ArrayBuffer(104)));
  fifo.state.dropped = 7;
  fifo.lag = 3;
  assert.equal(fifo.collectedCount, 1);

  fifo.reset();

  assert.equal(fifo.collectedCount, 0);
  assert.equal(fifo.droppedCount, 0);
  assert.equal(fifo.lag, 0);
});

test('reset(): 直前の checkpoint は無効になる（別セッション扱い）', () => {
  const fifo = new FifoRecorder({
    id: 0,
    transport: { write: async () => undefined },
    profile: { kind: 'insole', streaming_mode: 4 },
    isConnected: () => true,
    setNotifySink: () => () => {},
    reportError: () => {},
  });
  const checkpoint = fifo.createCheckpoint();
  fifo.reset();
  assert.equal(fifo.summarizeSince(checkpoint).available, false);
});
