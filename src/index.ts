/**
 * orphe-device — ORPHE CORE / ORPHE INSOLE 共通 BLE SDK の公開 API。
 *
 * ここに並ぶものだけが互換性を約束する対象。内部部品（プロトコルの codec、
 * 状態機械、キュー等）は各モジュールから直接 import できるが、公開 API ではない。
 */

// ── デバイス（ファサード） ────────────────────────────────────────
export { OrpheDevice } from './device/orphe-device.ts';
export type { OrpheDeviceOptions } from './device/orphe-device.ts';
export type {
  BeginContext,
  BeginOptions,
  DeviceMode,
  DeviceProfile,
  LostDataInfo,
  SensorFieldMap,
  SensorSample,
} from './device/profile.ts';
export { SampleEmitter } from './device/sample-emitter.ts';
export type { SampleEmitMeta, SampleListener } from './device/sample-emitter.ts';
export { attachLegacyCallbacks, fieldToGotName } from './device/legacy.ts';
export type { FirmwareInfo } from './protocol/fw-info.ts';

// ── プロファイル（CORE） ──────────────────────────────────────────
export {
  CORE_ACC_RANGES,
  CORE_GYRO_RANGES,
  CORE_NOTIFICATION_TYPES,
  CoreProfile,
  coreProfile,
  coreRequestDeviceOptions,
} from './profiles/core.ts';
export type {
  CoreDeviceInformation,
  CoreGaitPayload,
  CoreProfileOptions,
  CorePronationPayload,
  CoreQuat,
  CoreSampleStamp,
  CoreScalar,
  CoreSensorFields,
  CoreSensorSample,
  CoreStridePayload,
  CoreVec3,
} from './profiles/core.ts';
export { CORE_FIFO_MIN_RELEASE_DATE, CORE_MODES } from './modes/core.ts';

// ── プロファイル（INSOLE） ────────────────────────────────────────
export {
  INSOLE_ACC_RANGES,
  INSOLE_GYRO_DPS_PER_LSB_PER_RANGE,
  INSOLE_GYRO_RANGES,
  InsoleProfile,
  insoleProfile,
  insoleRequestDeviceOptions,
} from './profiles/insole.ts';
export type {
  InsoleDeviceInformation,
  InsoleParsedSample,
  InsolePress,
  InsoleProfileOptions,
  InsoleSampleStamp,
  InsoleSensorFields,
  InsoleSensorSample,
  InsoleStampedQuat,
  InsoleStampedVec3,
} from './profiles/insole.ts';
export {
  INSOLE_FIFO_MIN_RELEASE_DATE,
  INSOLE_MODES,
  INSOLE_PRESSURE_CALIBRATION_MIN_RELEASE_DATE,
  INSOLE_STREAMING_MODES,
  insoleStreamingModeOf,
} from './modes/insole.ts';
export {
  applyPressureCalibration,
  legacyPressureToNewton,
  pressureToNewton,
} from './protocol/pressure-calibration.ts';
export type { PressureCalibration } from './protocol/pressure-calibration.ts';

// ── FIFO 収録（ロスレス） ─────────────────────────────────────────
export { FifoRecorder } from './fifo/recorder.ts';
export type {
  FifoAnomalyInfo,
  FifoCheckpoint,
  FifoDataLossInfo,
  FifoHost,
  FifoProgressInfo,
  FifoRecorderOptions,
  FifoStoppedInfo,
  FifoSummary,
  FifoTiming,
} from './fifo/recorder.ts';
export type { FifoPacket, FifoSample } from './fifo/protocol.ts';
export type { FifoLossEvent, FifoLossReason } from './fifo/state.ts';
export { pressureToN } from './fifo/protocol.ts';

// ── 歩容解析（INSOLE） ────────────────────────────────────────────
export { InsoleGait } from './gait/analyzer.ts';
export type { GaitDiagnostics, GaitHost, GaitTransportInfo } from './gait/analyzer.ts';
export type { GaitRow, GaitStepLossInfo, GaitStepLossStats } from './gait/aggregator.ts';
export type {
  GaitMotionPacket,
  GaitOverviewPacket,
  GaitPacket,
  GaitPronationPacket,
  GaitStridePacket,
} from './gait/packet.ts';
export { GAIT_TYPES, STRIDE_DIRECTIONS } from './gait/packet.ts';

// ── プロトコル ────────────────────────────────────────────────────
export { ORPHE_UUID, orpheCharacteristics } from './protocol/uuids.ts';
export type { CharacteristicId } from './protocol/uuids.ts';
export { readDateTime, syncDeviceTime, writeDateTime } from './device/time-sync.ts';
export type { DeviceDateTime, SyncTimeOptions, SyncTimeResult } from './device/time-sync.ts';
export { quatToEuler } from './protocol/geometry.ts';
export type { EulerAngles, Quat, Vec3 } from './protocol/geometry.ts';

// ── BLE トランスポート ────────────────────────────────────────────
export { OrpheBleTransport } from './ble/transport.ts';
export { TransportError } from './ble/errors.ts';
export type { TransportErrorCode } from './ble/errors.ts';
export type {
  ConnectionState,
  DeviceGuard,
  GattIo,
  OperationOptions,
  ReconnectAttemptInfo,
  ReconnectConfig,
  ReconnectFailedInfo,
  ReconnectSuccessInfo,
  TransportConfig,
  TransportEvents,
} from './ble/types.ts';
export type {
  BleBluetooth,
  BleBufferSource,
  BleCharacteristic,
  BleDevice,
  BleGattServer,
  BleGattService,
  BleRequestDeviceOptions,
  BleValueChangedEvent,
  StorageLike,
} from './ble/web-bluetooth.ts';

// ── 互換 API（new Orphe(0) / new OrpheInsole(0) と got* コールバック代入スタイル） ──
export { Orphe } from './compat/orphe-core.ts';
export type { CoreBeginOptions, LegacyCoreDeviceInformation, OrpheInjections } from './compat/orphe-core.ts';
export { OrpheInsole } from './compat/orphe-insole.ts';
export type { InsoleAdvertisementStatus, InsoleBeginOptions, InsoleSensorDataEvent } from './compat/orphe-insole.ts';
export { OrpheInsoleFifo, OrpheInsoleGait } from './compat/insole-modules.ts';
export { LegacyDevice } from './compat/legacy-device.ts';
export type {
  LegacyBeginOptions,
  LegacyDeviceInjections,
  LegacyReconnectAttemptInfo,
  LegacyReconnectFailedInfo,
  LegacyReconnectSuccessInfo,
} from './compat/legacy-device.ts';

export { OrpheInsoleSimulator } from './compat/insole-simulator.ts';
export type {
  InsoleSimulatorBeginOptions,
  InsoleSimulatorDeviceInformation,
  InsoleSimulatorFrame,
  InsoleSimulatorInterpolation,
  InsoleSimulatorSensorDataEvent,
  InsoleSimulatorStampedEuler,
} from './compat/insole-simulator.ts';

// ── 圧力データユーティリティ（INSOLE） ──────────────────────────────
export { OrpheInsoleUtils } from './insole-utils.ts';
export type {
  ContactDetectorOptions,
  InsoleContactDownEvent,
  InsoleContactUpEvent,
  InsoleCoP,
  InsoleCoPFlag,
  InsoleMountInfo,
  InsolePressFlag,
  InsolePressValidation,
  InsolePressureCalibrationJSON,
  InsoleSensorPoint,
  StuckChannelMonitorOptions,
} from './insole-utils.ts';

// ── 計測セッション（INSOLE の FIFO / Step Analysis 切替と計測区間の記録） ──
export {
  INSOLE_TOOLKIT_PROFILES,
  INSOLE_TOOLKIT_STEP_UNSUPPORTED_FW,
  InsoleToolkitSession,
  insoleToolkitMeasurementToCSV,
  normalizeInsoleSensorDataMode,
  normalizeInsoleToolkitConfiguration,
  normalizeInsoleToolkitOutputs,
  resolveInsoleToolkitProfile,
} from './session/insole-toolkit-session.ts';
export type {
  InsoleMeasurementResult,
  InsoleMeasurementSerialSummary,
  InsoleMeasurementSnapshot,
  InsoleSensorDataMode,
  InsoleSessionAdapters,
  InsoleSessionDevice,
  InsoleSessionFifo,
  InsoleSessionGait,
  InsoleToolkitConfiguration,
  InsoleToolkitConfigurationInput,
  InsoleToolkitError,
  InsoleToolkitOutputs,
  InsoleToolkitProfile,
  InsoleToolkitProfileInput,
  InsoleToolkitSessionOptions,
  InsoleToolkitSessionSnapshot,
  ResolvedInsoleToolkitProfile,
} from './session/insole-toolkit-session.ts';

// ── タブ間共有 / ユーティリティ ───────────────────────────────────
export { BleSharedBridge, defaultBridgeEnvironment } from './bridge.ts';
export type { BridgeCallbacks, BridgeChannel, BridgeEnvironment, BridgeTimingOptions } from './bridge.ts';
export { downloadCsv } from './csv.ts';
