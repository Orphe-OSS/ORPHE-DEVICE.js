/**
 * CSV のブラウザダウンロード。FifoRecorder / InsoleGait の download() が共用する。
 * DOM lib に依存しないよう、必要な形だけを構造的型で受ける。
 */

// DOM lib 非依存のための構造的型（downloadCsv 用）
interface AnchorLike {
  href: string;
  download: string;
  style: { display: string };
  click(): void;
  parentNode: { removeChild(node: unknown): void } | null;
}
interface DocumentLike {
  body: { appendChild(node: unknown): void };
  createElement(tag: string): AnchorLike;
}

/** CSV 文字列をブラウザでダウンロードさせる（Node など document のない環境では throw） */
export function downloadCsv(csv: string, filename: string): void {
  const doc = (globalThis as { document?: DocumentLike }).document;
  if (!doc) throw new Error('downloadCsv: document is not available (browser only)');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = doc.createElement('a');
  a.href = url;
  a.download = filename;
  a.style.display = 'none';
  doc.body.appendChild(a);
  a.click();
  // click 直後に同期で revoke すると blob 読み込み前に URL が無効化され
  // ダウンロードが始まらないことがあるため、次 tick 以降でクリーンアップする
  setTimeout(() => {
    URL.revokeObjectURL(url);
    a.parentNode?.removeChild(a);
  }, 1000);
}
