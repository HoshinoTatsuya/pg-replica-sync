/**
 * Отставание реплики от мастера в байтах WAL. Состояния сняты в разные моменты,
 * поэтому реплика может оказаться «впереди» снятой раньше позиции мастера —
 * это ноль, а не отрицательное отставание.
 */
export function lagBytes(primaryInsertLsn: bigint, replicaReplayLsn: bigint): bigint {
  const lag = primaryInsertLsn - replicaReplayLsn;
  return lag > 0n ? lag : 0n;
}
