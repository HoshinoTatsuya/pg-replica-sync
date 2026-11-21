import type { Exclusion } from './exclusion.type';
import type { NodeRole } from './node-role.type';
import type { RouteReason } from './route-reason.type';

/** Куда читать: узел, его `target`, причина и почему не подошли остальные реплики. */
export interface RouteDecision<TTarget> {
  readonly role: NodeRole;
  readonly node: string;
  readonly target: TTarget;
  readonly reason: RouteReason;
  readonly excluded: readonly Exclusion[];
  /** Сколько опросов реплик ушло на ожидание догоняния (0 — не ждали). */
  readonly catchUpPolls: number;
  /**
   * Узел — балансировщик (`balanced: true`): решение доказано про сервер зонда,
   * а не про сервер чтения. Читать можно только после `router.confirm(decision,
   * соединение чтения) === true`; иначе — с мастера.
   */
  readonly mustConfirm: boolean;
}
