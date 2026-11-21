import type { ConfirmEvent } from './confirm-event.type';
import type { ProbeEvent } from './probe-event.type';
import type { RouteDecision } from './route-decision.type';

/**
 * Наблюдение для метрик и логов. Отказ наблюдателя маршрутизацию не роняет:
 * исключение хука, отказ `async`-хука и бросающий геттер свойства хука
 * проглатываются.
 */
export interface RouterObserver {
  readonly routed?: ((decision: RouteDecision<unknown>) => void) | undefined;
  readonly probed?: ((event: ProbeEvent) => void) | undefined;
  /** Позицию после записи определить не смогли — выдан токен «только мастер». */
  readonly tokenUnresolved?: ((event: { readonly error: Error }) => void) | undefined;
  /** Итог `confirm` на соединении чтения (подтверждено или почему нет). */
  readonly confirmed?: ((event: ConfirmEvent) => void) | undefined;
}
