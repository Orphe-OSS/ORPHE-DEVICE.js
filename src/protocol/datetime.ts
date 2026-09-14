/**
 * DATE_TIME characteristic の共通プロトコル。
 *
 * ワイヤ形式は [YY(西暦-2000), MM(1-12), DD, hh, mm, ss, subsec(10ms単位)] の
 * 7 バイト（CORE / INSOLE 共通）。
 * 時刻同期の手続き（読み出し・書き込み・往復時間の補正）は device/time-sync.ts。
 */

/** Date → 7 バイトのワイヤ形式 */
export function encodeDateTime(date: Date): Uint8Array {
  return Uint8Array.from([
    date.getFullYear() - 2000,
    date.getMonth() + 1,
    date.getDate(),
    date.getHours(),
    date.getMinutes(),
    date.getSeconds(),
    Math.floor(date.getMilliseconds() / 10),
  ]);
}

/** 7 バイトのワイヤ形式 → Date（encodeDateTime の逆変換） */
export function decodeDateTime(data: DataView): Date {
  return new Date(
    data.getUint8(0) + 2000,
    data.getUint8(1) - 1,
    data.getUint8(2),
    data.getUint8(3),
    data.getUint8(4),
    data.getUint8(5),
    data.getUint8(6) * 10
  );
}
