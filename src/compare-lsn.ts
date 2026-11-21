import { parseLsn } from './parse-lsn';

/**
 * Сравнение позиций WAL как 64-битных чисел: -1, 0 или 1. Принимает текст
 * `X/Y` (разбирается строго) или уже разобранную позицию. Единственная точка
 * сравнения позиций в пакете.
 */
export function compareLsn(left: string | bigint, right: string | bigint): -1 | 0 | 1 {
  const a = typeof left === 'bigint' ? left : parseLsn(left);
  const b = typeof right === 'bigint' ? right : parseLsn(right);
  if (a === b) {
    return 0;
  }
  return a < b ? -1 : 1;
}
