/**
 * GET_FW_NAME characteristic のデコードと、リリース日による機能判定。
 *
 * ペイロードは固定長で、前半がビルド識別子の ASCII、後半がバージョンと
 * ビルド日付の数値。全体をテキストとしてデコードすると後半が化けるため、
 * 前半と後半を分けて読む。
 */

/** GET_FW_NAME のペイロード長 [byte] */
export const FW_NAME_BYTE_LENGTH = 23;

const BUILD_ID_LENGTH = 15;

/** デコード済みのファームウェア情報。 */
export interface FirmwareInfo {
  /** ビルド識別子（機種・用途を表す文字列部分） */
  buildId: string;
  /** メインバージョン */
  major: number;
  /** サブバージョン */
  minor: number;
  /** パッチ番号 */
  patch: number;
  /** リリース日（ローカルタイムの 00:00） */
  releasedAt: Date;
  /**
   * リリース日を `YYYYMMDD` の整数にしたもの（例 `20260905`）。
   * 大小比較がそのまま日付の前後になるので、機能判定にはこれを使う。
   */
  releaseDate: number;
  /** 表示・ログ用のビルド名 */
  name: string;
  /** read した生ペイロード */
  raw: DataView;
}

/** ASCII 部を読む。非印字文字は終端として扱う */
function readBuildId(dv: DataView): string {
  let out = '';
  for (let i = 0; i < BUILD_ID_LENGTH; i++) {
    const code = dv.getUint8(i);
    if (code < 0x20 || code > 0x7e) break;
    out += String.fromCharCode(code);
  }
  return out;
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, '0');
}

/**
 * GET_FW_NAME の read ペイロードをデコードする。
 * 長さ不足や日付が不正な値（未書込・別フォーマット）の場合は null。
 */
export function decodeFirmwareInfo(data: DataView): FirmwareInfo | null {
  if (!data || data.byteLength < FW_NAME_BYTE_LENGTH) return null;

  const year = data.getUint16(18);
  const month = data.getUint8(20);
  const day = data.getUint8(21);
  if (year < 2000 || year > 2199) return null;
  if (month < 1 || month > 12) return null;
  if (day < 1 || day > 31) return null;

  const buildId = readBuildId(data);
  const major = data.getUint8(15);
  const minor = data.getUint16(16);
  const patch = data.getUint8(22);
  const yyyymmdd = `${year}${pad(month, 2)}${pad(day, 2)}`;

  return {
    buildId,
    major,
    minor,
    patch,
    releasedAt: new Date(year, month - 1, day),
    releaseDate: Number(yyyymmdd),
    name: `${buildId}-${major}-${pad(minor, 4)}-${yyyymmdd}-${pad(patch, 2)}`,
    raw: data,
  };
}

/** リリース日（`YYYYMMDD`）を取り出す。FW 情報が未取得なら null。 */
export function firmwareReleaseDate(firmware: FirmwareInfo | null | undefined): number | null {
  return firmware ? firmware.releaseDate : null;
}
