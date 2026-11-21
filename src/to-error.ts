import { valueText } from './value-text';
/** Брошенное значение → Error (бросить могут что угодно). */
export function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(valueText(value), { cause: value });
}
