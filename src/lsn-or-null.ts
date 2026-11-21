import { parseLsn } from './parse-lsn';

/** Позиция из ответа сервера или `null`, если её нет или она не в форме. */
export function lsnOrNull(value: unknown): bigint | null {
  if (typeof value !== 'string') {
    return null;
  }
  try {
    return parseLsn(value);
  } catch {
    return null;
  }
}
