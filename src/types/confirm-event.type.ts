import type { ExclusionReason } from './exclusion-reason.type';
import type { RouteDecision } from './route-decision.type';

/**
 * Итог `confirm` на соединении чтения. `reason` — почему сервер чтения не
 * подошёл (`null` — подошёл); `error` — запрос подтверждения не выполнился
 * (отказ, потолок времени): тогда `reason` — `unavailable`.
 */
export interface ConfirmEvent {
  readonly decision: RouteDecision<unknown>;
  readonly confirmed: boolean;
  readonly reason: ExclusionReason | null;
  readonly error?: Error;
}
