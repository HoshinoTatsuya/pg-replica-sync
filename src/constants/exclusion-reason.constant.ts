import { deepFreeze } from '../deep-freeze';

/**
 * Почему реплика не подошла для этого чтения. Любое «не смогли определить»
 * — отдельное значение и исключение, а не «подошла».
 */
export const EXCLUSION_REASON = {
  /** Зонд не ответил: отказ соединения, ошибка или потолок времени. */
  unavailable: 'unavailable',
  /** `pg_is_in_recovery() = false`: узел стал мастером. */
  promoted: 'promoted',
  /** Воспроизведение WAL на паузе (`pg_wal_replay_pause`). */
  paused: 'paused',
  /** Роль зонда не видит `pg_stat_wal_receiver` (нужен pg_read_all_stats / pg_monitor). */
  noStatsPrivilege: 'no-stats-privilege',
  /** Линию времени определить не смогли (приёмник WAL не работает). */
  timelineUnknown: 'timeline-unknown',
  /** Линия времени реплики не та, что у токена (или у мастера). */
  timelineMismatch: 'timeline-mismatch',
  /** Реплика из другого кластера (system identifier). */
  otherCluster: 'other-cluster',
  /** Состояние пришло, но не разбирается (позиция WAL пуста или не в форме `X/Y`). */
  stateUnknown: 'state-unknown',
  /** Позиция воспроизведения меньше позиции токена. */
  behind: 'behind',
  /** Без токена: отставание больше потолка. */
  lagExceeded: 'lag-exceeded',
} as const;
deepFreeze(EXCLUSION_REASON);
