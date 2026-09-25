/** Toolkit の UI テスト用に happy-dom の window / document をグローバルへ置く */
import { Window } from 'happy-dom';

export function installDom(): Window {
  const window = new Window({ url: 'https://localhost/' });
  const globals = globalThis as Record<string, unknown>;
  globals.window = window;
  globals.document = window.document;
  for (const name of ['Element', 'HTMLElement', 'HTMLInputElement', 'HTMLSelectElement', 'Event']) {
    globals[name] = (window as unknown as Record<string, unknown>)[name];
  }
  Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true });
  Object.defineProperty(globalThis, 'localStorage', { value: window.localStorage, configurable: true });
  return window;
}
