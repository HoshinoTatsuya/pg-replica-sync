/**
 * Адреса узлов настоящей потоковой репликации (`scripts/with-replication.sh`):
 * суперпользователь test/test; pgbouncer — роль приложения app/app. Нет адреса — отказ с объяснением, а не пропуск.
 */
export function replicationEnv(): {
  readonly primary: string;
  readonly replica1: string;
  readonly replica2: string;
  readonly replica3: string;
  /** pgbouncer в режиме transaction над replica1 и replica2 (роль app). */
  readonly bouncerTx: string;
  /** Каскадная реплика: следует за replica1. */
  readonly cascade: string;
  /** Реплика только через архив WAL (без приёмника WAL). */
  readonly archive: string;
} {
  const read = (name: string): string => {
    const value = process.env[name];
    if (value === undefined || value === '') {
      throw new Error(`${name} не задан: спеки идут под scripts/with-replication.sh (pnpm test)`);
    }
    return value;
  };
  return {
    primary: read('PG_PRIMARY_URL'),
    replica1: read('PG_REPLICA1_URL'),
    replica2: read('PG_REPLICA2_URL'),
    replica3: read('PG_REPLICA3_URL'),
    bouncerTx: read('PG_BOUNCER_TX_URL'),
    cascade: read('PG_CASCADE_URL'),
    archive: read('PG_ARCHIVE_URL'),
  };
}
