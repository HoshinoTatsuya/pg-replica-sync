import { deepFreeze } from '../deep-freeze';

/**
 * Почему чтение ушло туда, куда ушло. Значение — метка метрики: словарь
 * закрытый, каждая причина ухода на мастер называется отдельно, чтобы «реплики
 * отстают» отличалось от «токен испорчен» и от «не смогли определить».
 */
export const ROUTE_REASON = {
  /** Реплика догнала позицию токена. */
  replicaCaughtUp: 'replica-caught-up',
  /** Без токена: отставание реплики в потолке. */
  replicaWithinLag: 'replica-within-lag',
  /** Реплик не задано. */
  noReplicas: 'no-replicas',
  /** Токен не разбирается: не та форма, не та подпись, слишком длинный. */
  tokenInvalid: 'token-invalid',
  /** Токен выдан без позиции (позицию после записи определить не смогли). */
  tokenUnresolved: 'token-unresolved',
  /** Токен с другой линии времени, чем у мастера: был failover. */
  tokenOtherTimeline: 'token-other-timeline',
  /** Позиция токена впереди мастера той же линии времени. */
  tokenAheadOfPrimary: 'token-ahead-of-primary',
  /** Токен выдан другим кластером (system identifier не совпал). */
  tokenForeign: 'token-foreign',
  /** Ни одна реплика не подошла; почему каждая — в `excluded`. */
  noReplicaEligible: 'no-replica-eligible',
  /** Без токена: позицию или линию времени мастера определить не смогли. */
  primaryStateUnknown: 'primary-state-unknown',
} as const;
deepFreeze(ROUTE_REASON);
