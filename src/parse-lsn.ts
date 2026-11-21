import { WAL_FORMAT } from './constants/wal-format.constant';
import { InvalidLsnError } from './invalid-lsn.error';

/**
 * `X/Y` → 64-битная позиция `X·2³² + Y`. Сравнивать позиции строками нельзя:
 * `'10/0' < '9/0'` и `'0/FFFFFFFF' > '1/0'` лексикографически, а по WAL —
 * наоборот. Всё, что не в форме Postgres, — отказ, а не «ноль».
 */
export function parseLsn(text: string): bigint {
  const match = WAL_FORMAT.LSN_TEXT.exec(text);
  if (match === null) {
    throw new InvalidLsnError(text);
  }
  const [, high = '', low = ''] = match;
  return (BigInt(`0x${high}`) << 32n) | BigInt(`0x${low}`);
}
