/**
 * `<script src="orphe-core-insole.js">` で読み込むファイルのエントリ。
 * 公開 API を `OrpheCoreInsoleJS` に置き、互換クラスは同名のグローバルにも置く。
 */
import { INSOLE_STREAMING_MODES } from './modes/insole.ts';
import { parseInsoleSensorValues } from './profiles/insole.ts';
import { Orphe, OrpheInsole, OrpheInsoleFifo, OrpheInsoleGait, OrpheInsoleSimulator, OrpheInsoleUtils } from './index.ts';

export * from './index.ts';

const globals = globalThis as Record<string, unknown>;
globals.Orphe = Orphe;
globals.OrpheInsole = OrpheInsole;
globals.OrpheInsoleFifo = OrpheInsoleFifo;
globals.OrpheInsoleGait = OrpheInsoleGait;
globals.OrpheInsoleSimulator = OrpheInsoleSimulator;
globals.OrpheInsoleUtils = OrpheInsoleUtils;
globals.parseInsoleSensorValues = parseInsoleSensorValues;
globals.ORPHE_INSOLE_STREAMING_MODES = INSOLE_STREAMING_MODES;
