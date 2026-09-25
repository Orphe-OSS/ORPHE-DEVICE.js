/**
 * `ble.gotAcc = function(acc) { ... }` 代入スタイルの got* コールバックアダプタ。
 *
 * target に代入された関数を emitter のフィールド配送から呼ぶ。
 * SDK ラッパーが自身を target にして attach する想定。
 *
 * 仕様:
 *   - フィールド名 → got + PascalCase（irregular: ble_frequency → gotBLEFrequency,
 *     lost_data → lostData で、lostData は (serial, prev) の2引数）
 *   - コールバックは target を this にして呼ぶ（コールバック内で this.id を参照できる）
 *   - gotData をオーバーライドすると生 DataView が gotData に渡り、他の got* は
 *     停止する（gotData モード）。lostData / gotBLEFrequency は停止しない
 *   - コールバックの throw は他の配送を壊さず onError へ報告される
 */
import type { OrpheCoreInsole } from './orphe-core-insole.ts';

const IRREGULAR_FIELD_NAMES: Record<string, string> = {
  ble_frequency: 'gotBLEFrequency',
  lost_data: 'lostData',
};

/** gotData オーバーライド中でも配送を止めないフィールド */
const PASS_DURING_GOT_DATA = new Set(['lost_data', 'ble_frequency']);

/** フィールド名 → got* コールバック名（acc → gotAcc, converted_acc → gotConvertedAcc） */
export function fieldToGotName(field: string): string {
  const irregular = IRREGULAR_FIELD_NAMES[field];
  if (irregular) return irregular;
  return 'got' + field
    .split('_')
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
}

/**
 * target に got* 配送を接続する。解除関数を返す。
 * target 省略時は ble 自身に接続する（型の上では any 相当になるため、
 * 型安全に使いたい場合は SDK ラッパー側で自身を渡すこと）。
 *
 * gotData の「オーバーライドされた」判定は attach 時点の値との比較。
 * SDK ラッパーが既定の noop gotData を持っていても gotData モードに
 * 誤爆しない（ユーザが差し替えたときだけ発動する）。
 */
export function attachLegacyCallbacks<TFields extends object>(
  ble: OrpheCoreInsole<TFields>,
  target: Record<string, unknown> = ble as unknown as Record<string, unknown>
): () => void {
  const initialGotData = target.gotData;
  const isGotDataOverridden = (): boolean =>
    typeof target.gotData === 'function' && target.gotData !== initialGotData;

  const invoke = (name: string, args: unknown[]): void => {
    const callback = target[name];
    if (typeof callback !== 'function') return;
    try {
      (callback as (...a: unknown[]) => void).apply(target, args);
    } catch (error) {
      ble.reportError(error);
    }
  };

  const offStar = ble.emitter.on('*', (sample) => {
    const suppress = isGotDataOverridden();
    for (const field of Object.keys(sample)) {
      const value = (sample as Record<string, unknown>)[field];
      if (value === undefined) continue;
      if (suppress && !PASS_DURING_GOT_DATA.has(field)) continue;
      if (field === 'lost_data') {
        const loss = value as { serial: number; prev: number };
        invoke('lostData', [loss.serial, loss.prev]);
      } else {
        invoke(fieldToGotName(field), [value]);
      }
    }
  });

  const offRaw = ble.onRaw((uuid, data) => {
    if (!isGotDataOverridden()) return;
    invoke('gotData', [data, uuid]);
  });

  return () => {
    offStar();
    offRaw();
  };
}
