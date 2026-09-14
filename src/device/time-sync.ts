/**
 * デバイス時計の同期。「PC時刻 + 平均往復時間/2」を DATE_TIME へ書き込む。
 * ワイヤ形式（7 バイト）の encode / decode は protocol/datetime.ts。
 */
import type { GattIo } from '../ble/types.ts';
import { decodeDateTime, encodeDateTime } from '../protocol/datetime.ts';

/** {@link readDateTime} が返すデバイス時刻。 */
export interface DeviceDateTime {
  /** デコードしたデバイス時刻 */
  date: Date;
  /** read した生ペイロード（7 バイト） */
  raw: DataView;
  /** 読み出しにかかった往復時間 [ms]（floor 済み） */
  round_trip_time: number;
}

/** {@link readDateTime} / {@link writeDateTime} / {@link syncDeviceTime} の共通オプション。 */
export interface SyncTimeOptions {
  /** 平均値算出のための計測回数。既定 3 */
  samples?: number;
  /** DATE_TIME characteristic の論理名。既定 'DATE_TIME' */
  uuid?: string;
  /** テスト用注入点: 現在時刻 */
  now?: () => Date;
  /** テスト用注入点: RTT 計測用の単調クロック [ms] */
  clock?: () => number;
}

/** {@link syncDeviceTime} の結果。同期のズレを事後検証できるよう計測値も返す。 */
export interface SyncTimeResult {
  /** 全計測の往復時間の合計 [ms] */
  sum_round_trip_time: number;
  /** 往復時間の平均 [ms] */
  average_round_trip_time: number;
  /** 書き込み直前の PC 時刻（epoch ms） */
  standard_time: number;
  /** 実際にデバイスへ書いた時刻（standard_time + 片道遅延, epoch ms） */
  adjusted_time: number;
  /** 各回の往復時間 [ms] */
  round_trip_times: number[];
  /** 片道遅延の推定値 [ms]（平均往復時間の半分） */
  half_round_trip_time: number;
}

/** デバイスの時刻を読み、往復時間を添えて返す */
export async function readDateTime(
  transport: GattIo,
  options: SyncTimeOptions = {}
): Promise<DeviceDateTime> {
  const clock = options.clock ?? (() => performance.now());
  const uuid = options.uuid ?? 'DATE_TIME';
  const start = clock();
  const data = await transport.read(uuid);
  const round_trip_time = Math.floor(clock() - start);
  return { date: decodeDateTime(data), raw: data, round_trip_time };
}

/** Date をワイヤ形式でデバイスへ書き込む */
export async function writeDateTime(
  transport: GattIo,
  date: Date,
  options: SyncTimeOptions = {}
): Promise<void> {
  await transport.write(options.uuid ?? 'DATE_TIME', encodeDateTime(date));
}

/**
 * デバイスの時計を PC 時刻 + 平均往復時間/2 に同期する。
 */
export async function syncDeviceTime(
  transport: GattIo,
  options: SyncTimeOptions = {}
): Promise<SyncTimeResult> {
  const samples = options.samples ?? 3;
  const now = options.now ?? (() => new Date());

  let sum_round_trip_time = 0;
  const round_trip_times: number[] = [];
  for (let i = 0; i < samples; i++) {
    const deviceTime = await readDateTime(transport, options);
    sum_round_trip_time += deviceTime.round_trip_time;
    round_trip_times.push(deviceTime.round_trip_time);
  }
  const average_round_trip_time = sum_round_trip_time / samples;
  const half_round_trip_time = Math.round(average_round_trip_time / 2);
  const standard_time = now().getTime();
  const adjusted_time = standard_time + half_round_trip_time;

  await writeDateTime(transport, new Date(adjusted_time), options);
  return {
    sum_round_trip_time,
    average_round_trip_time,
    standard_time,
    adjusted_time,
    round_trip_times,
    half_round_trip_time,
  };
}
