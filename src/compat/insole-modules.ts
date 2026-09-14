/**
 * OrpheInsoleFifo / OrpheInsoleGait — 旧来の名前で FifoRecorder / InsoleGait を使うための薄い層。
 * `new OrpheInsoleFifo(insole)` のように OrpheInsole / Orphe（互換クラス）を渡せる。
 */
import type { FifoRecorderOptions } from '../fifo/recorder.ts';
import { FifoRecorder } from '../fifo/recorder.ts';
import { InsoleGait } from '../gait/analyzer.ts';
import { OrpheDevice } from '../device/orphe-device.ts';
import { LegacyDevice } from './legacy-device.ts';
import {
  FIFO_CSV_HEADER,
  FIFO_FRAME_INTERVAL_MS,
  FIFO_IMU_ODR_HZ,
  FIFO_LEGACY_CSV_FRAME_INTERVAL_MS,
  FIFO_RING_BUFFER_CAPACITY,
} from '../fifo/protocol.ts';
import { GAIT_CSV_HEADER } from '../gait/aggregator.ts';

type Host = LegacyDevice<object> | OrpheDevice<object>;

function hostDevice(host: Host): OrpheDevice<object> {
  return host instanceof LegacyDevice ? host.device : host;
}

export class OrpheInsoleFifo extends FifoRecorder {
  static readonly FRAME_INTERVAL_MS = FIFO_FRAME_INTERVAL_MS;
  static readonly IMU_ODR_HZ = FIFO_IMU_ODR_HZ;
  static readonly LEGACY_CSV_FRAME_INTERVAL_MS = FIFO_LEGACY_CSV_FRAME_INTERVAL_MS;
  static readonly CSV_HEADER = FIFO_CSV_HEADER;
  static readonly RING_BUFFER_CAPACITY = FIFO_RING_BUFFER_CAPACITY;

  /** 渡された互換インスタンス（または OrpheDevice） */
  readonly insole: Host;

  constructor(insole: Host, options: FifoRecorderOptions = {}) {
    super(hostDevice(insole), options);
    this.insole = insole;
  }
}

export class OrpheInsoleGait extends InsoleGait {
  static readonly CSV_HEADER = GAIT_CSV_HEADER;

  /** 渡された互換インスタンス（または OrpheDevice） */
  readonly insole: Host;

  constructor(insole: Host, _options: Record<string, unknown> = {}) {
    super(hostDevice(insole));
    this.insole = insole;
  }
}
