/// <reference lib="dom" />
/** Toolkit の UI 生成に使う共通ヘルパ */

/** 要素を作って親要素へ追加する */
export function buildElement(
  tagName: string,
  innerHTML: string,
  className: string,
  style: string,
  parent: Element,
): HTMLElement {
  const element = document.createElement(tagName);
  element.innerHTML = innerHTML;
  element.className = className;
  if (style !== '') {
    element.setAttribute('style', style);
  }
  parent.appendChild(element);
  return element;
}

/** id で要素を取る（見つからなければ null） */
export function byId<T extends HTMLElement = HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}
