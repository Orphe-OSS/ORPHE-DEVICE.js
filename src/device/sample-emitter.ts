/**
 * SampleEmitter — 正規化サンプルのフィールド別コールバック配送。
 *
 * パース（DataView → サンプル）はプロファイルの責務で、emitter は配送のみを行う。
 * 複数購読でき、リスナーの throw は他のリスナーへの配送を壊さない。
 *
 * TFields（フィールド名 → ペイロード型）をプロファイルから受け取ると、
 * on() のイベントキー補完とリスナー引数の型付けが効く。
 */
import type { SensorFieldMap } from './profile.ts';

/** リスナーの第2引数。値がどの notify のどのサンプル由来かを示す。 */
export interface SampleEmitMeta<TFields extends object = SensorFieldMap> {
  /** 発生元 characteristic の論理名 */
  uuid: string;
  /** その値を含むサンプル全体 */
  sample: Partial<TFields>;
}

/** '*' 購読者はサンプル全体、フィールド購読者はそのペイロードを受け取る */
export type SampleListener<
  TFields extends object = SensorFieldMap,
  K extends Extract<keyof TFields, string> | '*' = '*',
> = (
  value: K extends '*' ? Partial<TFields> : TFields[Exclude<K, '*'>],
  meta: SampleEmitMeta<TFields>
) => void;

/** 内部保持用の型消去済みリスナー */
type StoredListener = (value: unknown, meta: unknown) => void;

/**
 * 正規化サンプルをフィールド名ごとのコールバックへ配送する emitter。
 * リスナーの throw は他のリスナーへの配送を壊さない。
 */
export class SampleEmitter<TFields extends object = SensorFieldMap> {
  private readonly listeners = new Map<string, Set<StoredListener>>();
  private readonly onListenerError: ((error: unknown) => void) | null;

  constructor(onListenerError?: (error: unknown) => void) {
    this.onListenerError = onListenerError ?? null;
  }

  /**
   * フィールド名（'acc' 等）で購読する。'*' はサンプル全体を受け取る。
   * 解除関数を返す。
   */
  on<K extends Extract<keyof TFields, string> | '*'>(
    field: K,
    listener: SampleListener<TFields, K>
  ): () => void {
    let set = this.listeners.get(field);
    if (!set) {
      set = new Set();
      this.listeners.set(field, set);
    }
    const stored = listener as unknown as StoredListener;
    set.add(stored);
    return () => {
      set.delete(stored);
      if (set.size === 0) this.listeners.delete(field);
    };
  }

  /** そのフィールドの購読者数（`'*'` も 1 つのフィールドとして数える）。 */
  listenerCount(field: string): number {
    return this.listeners.get(field)?.size ?? 0;
  }

  /**
   * サンプル列を購読者へ配送する。`'*'` 購読者にはサンプル全体、
   * フィールド購読者には `undefined` でない値だけを渡す。
   */
  emit(uuid: string, samples: ReadonlyArray<Partial<TFields>>): void {
    for (const sample of samples) {
      const meta: SampleEmitMeta<TFields> = { uuid, sample };
      const record = sample as Record<string, unknown>;
      const wildcard = this.listeners.get('*');
      if (wildcard) {
        for (const listener of [...wildcard]) this.safeCall(listener, sample, meta);
      }
      for (const field of Object.keys(record)) {
        const value = record[field];
        if (value === undefined) continue;
        const set = this.listeners.get(field);
        if (!set) continue;
        for (const listener of [...set]) this.safeCall(listener, value, meta);
      }
    }
  }

  private safeCall(listener: StoredListener, value: unknown, meta: SampleEmitMeta<TFields>): void {
    try {
      listener(value, meta);
    } catch (error) {
      if (this.onListenerError) {
        try { this.onListenerError(error); } catch { /* noop */ }
      }
    }
  }
}
