/**
 * 全GATT操作のグローバル直列化キュー。
 *
 * Web Bluetooth の GATT 操作（read/write/startNotifications/stopNotifications）は
 * プラットフォームによって並行発行に耐えられないため、1本のチェーンで直列化する。
 */
export class GattOperationQueue {
  private tail: Promise<unknown> = Promise.resolve();

  /**
   * 操作をキューへ投入する。
   * 先行操作の完了（成功/失敗を問わず）後に実行され、
   * この操作自身の結果/例外だけが返る Promise を返す。
   */
  enqueue<T>(operation: () => T | Promise<T>): Promise<T> {
    const run = this.tail.catch(() => { /* 先行の失敗は後続を止めない */ }).then(operation);
    this.tail = run.catch(() => { /* チェーン維持のみ。呼び出し元へは run で伝播 */ });
    return run;
  }
}
