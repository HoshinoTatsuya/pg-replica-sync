import { parseLsn } from '../parse-lsn';
import { adminQuery } from './admin-query';

/**
 * Позиция мастера, которую реплика ГАРАНТИРОВАННО воспроизведёт: конец
 * последней записанной и сброшенной на диск записи WAL. Всё, что мастер
 * записал раньше, лежит до неё.
 *
 * Позиция вставки (`pg_current_wal_insert_lsn`) для ожидания годится не всегда:
 * сразу после `pg_switch_wal` и когда последняя запись кончилась ровно на
 * границе страницы она стоит ЗА заголовком новой страницы, где записи ещё нет,
 * а воспроизведение реплики — на самой границе. Такую позицию реплика
 * «догоняет» только со следующей записью WAL — фоновым снимком транзакций раз
 * в 15 с (замер: 13 и 15 с после переключения сегмента), — и ожидание с
 * потолком в 10 с то проходило, то нет. Поэтому: записать маркер
 * (транзакционное сообщение — его COMMIT сбрасывает WAL на диск) и взять
 * позицию, когда вставка совпала со сброшенной, — она и конец записи, и та
 * позиция, которую получит следующий токен.
 */
export async function reachablePrimaryLsn(primaryUrl: string): Promise<bigint> {
  let last = '';
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await adminQuery(primaryUrl, "SELECT pg_logical_emit_message(true, 'pg-replica-sync-spec', '')");
    const [row] = await adminQuery<{ inserted: string; flushed: string }>(
      primaryUrl,
      'SELECT pg_current_wal_insert_lsn()::text AS inserted, pg_current_wal_flush_lsn()::text AS flushed',
    );
    if (row === undefined) {
      throw new Error('позиции мастера не ответили');
    }
    if (row.inserted === row.flushed) {
      return parseLsn(row.flushed);
    }
    last = `вставка ${row.inserted}, сброшено ${row.flushed}`;
  }
  throw new Error(`позиция вставки мастера не совпала со сброшенной за 5 маркеров: ${last}`);
}
