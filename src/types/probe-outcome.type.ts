import type { NodeState } from './node-state.type';

/** Итог зонда: состояние или отказ (соединение, ошибка, потолок времени, неразборчивый ответ). */
export type ProbeOutcome =
  | { readonly ok: true; readonly state: NodeState }
  | { readonly ok: false; readonly error: Error };
