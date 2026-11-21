import type { WalLayout } from './types/wal-layout.type';

/**
 * Позиция для токена по позиции вставки мастера.
 *
 * `pg_current_wal_insert_lsn()`, когда последняя запись кончилась ровно на
 * границе страницы WAL (или сразу после переключения сегмента), стоит ЗА
 * заголовком новой страницы, где записи ещё нет, а воспроизведение реплики —
 * на самой границе (конец последней записи). Такую позицию реплика проходила
 * только со следующей записью WAL — на простаивающем мастере это ожидание без
 * верхней границы. Байты заголовка — не байты записи: ни одна запись не
 * кончается внутри него, поэтому граница страницы — та же позиция «после
 * всего записанного», и токен берёт её.
 *
 * Размеры заголовков — из раскладки сервера (`pg_control_init()`):
 * короткий = MAXALIGN(20), длинный (первая страница сегмента) = MAXALIGN(36)
 * (24 и 40 при выравнивании 8). Раскладка не определилась или выравнивание
 * не 4 и не 8 — позиция вставки как есть: ошибка в сторону мастера.
 */
export function tokenLsn(insertLsn: bigint, layout: WalLayout | null): bigint {
  if (layout === null || (layout.maxAlign !== 4 && layout.maxAlign !== 8)) {
    return insertLsn;
  }
  const align = (size: number): bigint => BigInt(Math.ceil(size / layout.maxAlign) * layout.maxAlign);
  const shortHeader = align(20);
  const longHeader = align(36);
  const inSegment = insertLsn % BigInt(layout.segmentSize);
  if (inSegment === longHeader) {
    return insertLsn - longHeader;
  }
  if (inSegment >= BigInt(layout.blockSize) && insertLsn % BigInt(layout.blockSize) === shortHeader) {
    return insertLsn - shortHeader;
  }
  return insertLsn;
}
