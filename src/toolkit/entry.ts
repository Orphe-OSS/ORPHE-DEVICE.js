/**
 * `<script src="orphe-core-insole-toolkit.js">` で読み込むファイルのエントリ。
 * 先に orphe-core-insole.js を読み込んでおくこと。buildCoreToolkit() などをグローバルに置く
 * （設定モーダルの onchange 属性からも呼ばれる）。
 */
import {
  INSOLE_TOOLKIT_PROFILES,
  INSOLE_TOOLKIT_STEP_UNSUPPORTED_FW,
  InsoleToolkitSession,
  insoleToolkitMeasurementToCSV,
  normalizeInsoleSensorDataMode,
  normalizeInsoleToolkitConfiguration,
  normalizeInsoleToolkitOutputs,
  resolveInsoleToolkitProfile,
} from '../index.ts';
import * as coreToolkit from './core-toolkit.ts';
import * as insoleToolkit from './insole-toolkit.ts';
import * as companionToolkit from './core-companion-toolkit.ts';

const globals = globalThis as Record<string, unknown>;

const { orpheCore: _orpheCore, setOrpheCore, ...companion } = companionToolkit;
Object.assign(globals, coreToolkit, insoleToolkit, companion, {
  InsoleToolkitSession,
  INSOLE_TOOLKIT_PROFILES,
  INSOLE_TOOLKIT_STEP_UNSUPPORTED_FW,
  resolveInsoleToolkitProfile,
  normalizeInsoleToolkitConfiguration,
  normalizeInsoleToolkitOutputs,
  normalizeInsoleSensorDataMode,
  insoleToolkitMeasurementToCSV,
});
Object.defineProperty(globalThis, 'orpheCore', {
  configurable: true,
  get: () => companionToolkit.orpheCore,
  set: (core) => setOrpheCore(core),
});
