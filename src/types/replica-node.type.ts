import type { ClientConfig } from 'pg';

/**
 * Узел: имя (метка метрик), адрес для зонда состояния и `target` — то, чем
 * вызывающий читает с этого узла (свой пул, drizzle, что угодно). Зонд ходит
 * СВОИМ соединением: его можно оборвать по потолку, не трогая пул приложения.
 */
export interface ReplicaNode<TTarget> {
  readonly name: string;
  readonly connection: string | ClientConfig;
  readonly target: TTarget;
  /**
   * Адрес ведёт не на ОДИН сервер, а на балансировщик над несколькими репликами
   * (сервис «только чтение», прокси, читающая точка облака). Зонд видит один
   * сервер, а чтение уходит на любой, поэтому решение «реплика» по такому узлу
   * обязано подтверждаться на соединении чтения: `decision.mustConfirm` и
   * `router.confirm(decision, connection)`.
   */
  readonly balanced?: boolean | undefined;
}
