/**
 * Отсекает пул на уровне типов: у `pg.Pool` есть счётчики соединений, у клиента
 * транзакции (`pg.Client`, `pg.PoolClient`) их нет. COMMIT через пул ушёл бы на
 * случайное соединение; в рантайме такой вызов и так отвергается
 * (`TransactionNotOpenError`), а здесь — уже при компиляции. Обёртка вида
 * `{ query }` типом не отсекается: её ловит только рантайм.
 */
export interface NotAPool {
  readonly totalCount?: never;
  readonly idleCount?: never;
  readonly waitingCount?: never;
}
