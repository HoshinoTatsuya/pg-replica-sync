import { deepFreeze } from '../deep-freeze';

/**
 * Зонд состояния узла — один запрос, одинаковый для мастера и реплики.
 * Функции, падающие «не в том» режиме (`pg_get_wal_replay_pause_state` вне
 * recovery, `pg_walfile_name` в recovery), — под CASE: Postgres вычисляет
 * ветку только при выполнении условия (проверено на 17).
 *
 * - Линия времени мастера — из имени WAL-файла текущей позиции вставки:
 *   `pg_control_checkpoint().timeline_id` после промоции остаётся старым до
 *   ближайшей контрольной точки (замер: промоция → 2 по WAL, 1 по checkpoint).
 * - Линия времени реплики — `pg_stat_wal_receiver.received_tli`; без
 *   pg_read_all_stats колонка пуста (замер под ролью без прав), поэтому право
 *   запрашивается тем же запросом: «нет прав» и «приёмник стоит» — разные причины.
 * - Позиция мастера — `pg_current_wal_insert_lsn()`, а не `pg_current_wal_lsn()`:
 *   при `synchronous_commit = off` запись коммита может быть ещё не записана,
 *   и позиция записи окажется МЕНЬШЕ конца коммита. Позиция вставки — нет.
 * - `write_pending` — у соединения есть номер незавершённой транзакции: токен,
 *   выданный до COMMIT, был бы меньше позиции коммита, и реплика «догнала бы»
 *   его без этой записи. Такой токен не выдаётся.
 * - `started_at` — момент старта postmaster в секундах эпохи (не `::text`
 *   метки времени: её вид зависит от DateStyle и TimeZone сессии, и одно и то
 *   же соединение чтения и зонда давали бы разные экземпляры): вместе с
 *   `system_identifier` это экземпляр сервера. После перезапуска реплики позиция воспроизведения
 *   откатывается к minRecoveryPoint (замер: на 69–94 МБ), и всё, что снято до
 *   перезапуска, к ней больше не относится.
 * - `wal_layout` — выравнивание, размер страницы и сегмента WAL мастера
 *   (`pg_control_init()`): по ним позиция вставки сразу за заголовком страницы
 *   сводится к границе страницы (`tokenLsn`).
 */
export const PROBE_SQL = {
  STATE: `SELECT pg_is_in_recovery() AS in_recovery,
  (SELECT system_identifier::text FROM pg_control_system()) AS system_id,
  extract(epoch FROM pg_postmaster_start_time())::text AS started_at,
  CASE WHEN pg_is_in_recovery() THEN pg_last_wal_replay_lsn()::text END AS replay_lsn,
  CASE WHEN pg_is_in_recovery() THEN pg_get_wal_replay_pause_state() END AS pause_state,
  CASE WHEN pg_is_in_recovery() THEN (SELECT received_tli FROM pg_stat_wal_receiver LIMIT 1) END AS received_tli,
  pg_has_role(current_user, 'pg_read_all_stats', 'USAGE') AS has_stats,
  CASE WHEN NOT pg_is_in_recovery() THEN pg_current_wal_insert_lsn()::text END AS insert_lsn,
  CASE WHEN NOT pg_is_in_recovery() THEN pg_walfile_name(pg_current_wal_insert_lsn()) END AS wal_file,
  CASE WHEN NOT pg_is_in_recovery() THEN pg_current_xact_id_if_assigned() IS NOT NULL END AS write_pending,
  CASE WHEN NOT pg_is_in_recovery() THEN (SELECT ARRAY[max_data_alignment, wal_block_size, bytes_per_wal_segment] FROM pg_control_init()) END AS wal_layout`,
} as const;
deepFreeze(PROBE_SQL);
