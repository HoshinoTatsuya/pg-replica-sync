import { WAL_FORMAT } from './constants/wal-format.constant';
import { lsnOrNull } from './lsn-or-null';
import { timelineOf } from './timeline-of';
import { tokenLsn } from './token-lsn';
import type { NodeState } from './types/node-state.type';
import { walLayoutOf } from './wal-layout-of';

/**
 * Строка зонда (`PROBE_SQL.STATE`) → состояние узла. Всё, что не разобралось,
 * — `null` (а пауза — «на паузе»): «не смогли определить» дальше исключает
 * реплику. Ответ без булева `in_recovery` — не ответ Postgres: отказ зонда.
 */
export function readNodeState(row: unknown): NodeState {
  const value = (row ?? {}) as Record<string, unknown>;
  const inRecovery = value.in_recovery;
  if (typeof inRecovery !== 'boolean') {
    throw new Error(`зонд вернул не то: in_recovery = ${JSON.stringify(inRecovery)}`);
  }
  const systemId =
    typeof value.system_id === 'string' && WAL_FORMAT.SYSTEM_ID.test(value.system_id)
      ? value.system_id
      : null;
  const startedAt = typeof value.started_at === 'string' && value.started_at !== '' ? value.started_at : null;
  const insertLsn = inRecovery ? null : lsnOrNull(value.insert_lsn);
  return {
    inRecovery,
    systemId,
    instance: systemId === null || startedAt === null ? null : `${systemId}@${startedAt}`,
    replayLsn: inRecovery ? lsnOrNull(value.replay_lsn) : null,
    insertLsn,
    tokenLsn: insertLsn === null ? null : tokenLsn(insertLsn, walLayoutOf(value.wal_layout)),
    timeline: timelineOf(inRecovery, value.received_tli, value.wal_file),
    paused: inRecovery && value.pause_state !== WAL_FORMAT.NOT_PAUSED,
    hasStatsPrivilege: value.has_stats === true,
    writePending: value.write_pending === true,
  };
}
