import type { Clock } from './clock.type';
import type { ReplicaNode } from './replica-node.type';
import type { RouterObserver } from './router-observer.type';

/**
 * Настройки маршрутизатора. Необязательное поле можно передать и как
 * `undefined` (в том числе под `exactOptionalPropertyTypes`): это умолчание.
 */
export interface ReplicaRouterOptions<TTarget> {
  readonly primary: ReplicaNode<TTarget>;
  /** Пустой список допустим: все чтения — на мастер (`no-replicas`). */
  readonly replicas: readonly ReplicaNode<TTarget>[];
  /**
   * Ключи подписи токена, не короче 32 байт: первый подписывает, все проверяют
   * (ротация — новый ключ первым, старый следом, пока живут выданные токены).
   */
  readonly secrets: readonly (string | Uint8Array)[];
  /**
   * Потолок жизни состояния узла в кэше, мс (`REPLICA_SYNC_DEFAULTS.STATE_TTL_MS`),
   * не больше `MAX_STATE_TTL_MS`.
   */
  readonly stateTtlMs?: number | undefined;
  /** Потолок одного зонда (соединение + запрос), мс. */
  readonly probeTimeoutMs?: number | undefined;
  /**
   * Потолок жизни соединения зонда, которое не установилось или запрос на котором
   * не ответил, мс (`REPLICA_SYNC_DEFAULTS.CONNECT_TIMEOUT_MS`): до него соединение
   * не рвётся, даже если зонд уже отказал по `probeTimeoutMs`.
   */
  readonly connectTimeoutMs?: number | undefined;
  /** Узел, не ответивший зонду, не опрашивается столько, мс. */
  readonly unavailableRetryMs?: number | undefined;
  /** Без токена: потолок отставания реплики от позиции вставки мастера, байт. */
  readonly maxLagBytes?: number | undefined;
  /** С токеном: сколько ждать догоняния перед уходом на мастер, мс (0 — не ждать). */
  readonly waitForCatchUpMs?: number | undefined;
  /** Интервал опроса реплик во время ожидания, мс. */
  readonly catchUpPollMs?: number | undefined;
  /** Не чаще одного нового зонда узла за столько мс (0 — без потолка). */
  readonly minProbeIntervalMs?: number | undefined;
  /**
   * Сколько токен, который после failover ни одна реплика выполнить не может
   * (другая линия времени, другой кластер, впереди мастера), держит чтения на
   * мастере, мс; старше — чтение как без токена (`expiredTokens` в `stats()`).
   * Невыполнимость доказывается зондом мастера, начатым после первой встречи с
   * позицией токена; токен «без позиции» не стареет.
   */
  readonly tokenTtlMs?: number | undefined;
  readonly observer?: RouterObserver | undefined;
  /** Часы кэша; по умолчанию `performance.now`. Обязаны возвращать конечное число. */
  readonly clock?: Clock | undefined;
  /**
   * Часы момента выдачи токена — мс эпохи Unix, общие для процессов, которые
   * выдают и читают токены; по умолчанию `Date.now`. Расхождение часов процессов
   * сдвигает только срок невыполнимого токена (см. `tokenTtlMs`).
   */
  readonly wallClock?: Clock | undefined;
}
