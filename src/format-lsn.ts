import { WAL_FORMAT } from './constants/wal-format.constant';

/** 64-битная позиция → `X/Y` в форме Postgres (`pg_lsn` принимает её обратно). */
export function formatLsn(value: bigint): string {
  if (value < 0n || value > WAL_FORMAT.MAX_LSN) {
    throw new RangeError(`позиция WAL вне 64 бит: ${value}`);
  }
  return `${(value >> 32n).toString(16).toUpperCase()}/${(value & 0xffffffffn).toString(16).toUpperCase()}`;
}
