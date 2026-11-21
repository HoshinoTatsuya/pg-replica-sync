import { InvalidReplicaSyncOptionsError } from './invalid-replica-sync-options.error';

/** Целое в [min, max], иначе отказ при создании (NaN, дробь и Infinity — тоже отказ). */
export function requireInteger(
  name: string,
  value: number,
  min: number,
  max = Number.MAX_SAFE_INTEGER,
): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    const range = max === Number.MAX_SAFE_INTEGER ? `≥ ${min}` : `в ${min}..${max}`;
    throw new InvalidReplicaSyncOptionsError(`${name}: ожидается целое ${range}, получено ${value}`);
  }
  return value;
}
