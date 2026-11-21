/**
 * Чем выполнить запрос: `pg.Client`, `pg.PoolClient`, `pg.Pool` — или что угодно
 * с той же формой. Структурно, чтобы вторая копия `pg` в монорепозитории
 * подходила так же.
 */
export interface SqlQueryExecutor {
  query(text: string): Promise<{ readonly rows: readonly unknown[] }>;
}
