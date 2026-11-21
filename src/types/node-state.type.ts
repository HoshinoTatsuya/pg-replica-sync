/**
 * Что зонд узнал об узле. `null` — «не смогли определить»: решение по такому
 * полю — исключение реплики, а не допуск.
 */
export interface NodeState {
  readonly inRecovery: boolean;
  readonly systemId: string | null;
  /**
   * Экземпляр сервера: `system_identifier` и момент старта postmaster. Меняется
   * при каждом перезапуске — состояние, снятое до него, к узлу больше не относится.
   */
  readonly instance: string | null;
  /** Реплика: позиция воспроизведения; мастер: null. */
  readonly replayLsn: bigint | null;
  /** Мастер: позиция вставки; реплика: null. */
  readonly insertLsn: bigint | null;
  /**
   * Мастер: позиция для токена — позиция вставки, а если она стоит сразу за
   * заголовком страницы WAL (записи на странице ещё нет), то граница страницы:
   * конец последней записи, который реплика воспроизводит. Не определилась
   * раскладка WAL — позиция вставки как есть. Реплика: null.
   */
  readonly tokenLsn: bigint | null;
  readonly timeline: number | null;
  /** Реплика: пауза запрошена или действует; мастер: false. */
  readonly paused: boolean;
  /** Роль зонда видит `pg_stat_wal_receiver`. */
  readonly hasStatsPrivilege: boolean;
  /** У соединения зонда открыта транзакция с записью (номер транзакции выдан, COMMIT не прошёл). */
  readonly writePending: boolean;
}
