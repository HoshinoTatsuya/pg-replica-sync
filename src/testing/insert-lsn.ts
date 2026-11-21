import { parseLsn } from '../parse-lsn';
import { adminQuery } from './admin-query';

/** Позиция вставки мастера. */
export async function insertLsn(primaryUrl: string): Promise<bigint> {
  const [row] = await adminQuery<{ lsn: string }>(
    primaryUrl,
    'SELECT pg_current_wal_insert_lsn()::text AS lsn',
  );
  if (row === undefined) {
    throw new Error('pg_current_wal_insert_lsn не ответил');
  }
  return parseLsn(row.lsn);
}
