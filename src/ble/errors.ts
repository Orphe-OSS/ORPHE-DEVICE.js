/**
 * トランスポート層のエラー。code でプログラム判定できるようにする。
 */

/** TransportError.code の種別（プログラム判定用） */
export type TransportErrorCode =
  | 'NO_DEVICE'
  | 'NO_BLUETOOTH'
  | 'UNKNOWN_UUID'
  | 'CONNECT_TIMEOUT'
  | 'DEVICE_DISALLOWED'
  | 'ALREADY_DISCONNECTED'
  | 'RECONNECT_DEVICE_NOT_FOUND'
  | 'RECONNECT_FAILED'
  | 'RECONNECT_NOT_CONFIGURED'
  | 'INVALID_MODE'
  | 'UNSUPPORTED_MODE';

/** code 付き Error（エラー種別のプログラム判定用） */
export class TransportError extends Error {
  /** エラー種別（メッセージ文字列に依存せず判定できる） */
  readonly code: TransportErrorCode;
  constructor(code: TransportErrorCode, message: string) {
    super(message);
    this.name = 'OrpheBleTransportError';
    this.code = code;
  }
}
