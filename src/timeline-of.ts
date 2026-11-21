import { WAL_FORMAT } from './constants/wal-format.constant';

/**
 * Линия времени узла: реплики — `received_tli` приёмника WAL, мастера — из
 * имени WAL-файла позиции вставки. `null` — не определилась.
 */
export function timelineOf(inRecovery: boolean, receivedTli: unknown, walFile: unknown): number | null {
  if (inRecovery) {
    const tli = typeof receivedTli === 'string' ? Number(receivedTli) : receivedTli;
    return typeof tli === 'number' && Number.isInteger(tli) && tli > 0 ? tli : null;
  }
  const match = typeof walFile === 'string' ? WAL_FORMAT.WAL_FILE.exec(walFile) : null;
  const tli = match?.[1] === undefined ? 0 : Number.parseInt(match[1], 16);
  return tli > 0 ? tli : null;
}
