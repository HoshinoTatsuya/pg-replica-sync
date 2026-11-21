/**
 * Соединение, на котором идёт транзакция записи: `pg.Client` или `pg.PoolClient`
 * (не пул — у пула COMMIT ушёл бы на случайное соединение). `command` — тег
 * ответа: у `COMMIT` транзакции с ошибкой он `ROLLBACK`. Драйвер, который тега не
 * сообщает, подходит: состояние транзакции до COMMIT проверяется отдельно.
 */
export interface SqlCommandExecutor {
  query(
    text: string,
  ): Promise<{ readonly rows: readonly unknown[]; readonly command?: string | null | undefined }>;
}
