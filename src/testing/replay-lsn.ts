import { parseLsn } from '../parse-lsn';
import { adminQuery } from './admin-query';

/** Позиция воспроизведения реплики. */
export async function replayLsn(replicaUrl: string): Promise<bigint> {
  const [row] = await adminQuery<{ lsn: string }>(replicaUrl, 'SELECT pg_last_wal_replay_lsn()::text AS lsn');
  if (row === undefined) {
    throw new Error('pg_last_wal_replay_lsn не ответил');
  }
  return parseLsn(row.lsn);
}
