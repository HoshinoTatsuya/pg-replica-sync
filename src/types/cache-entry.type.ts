import type { ProbeOutcome } from './probe-outcome.type';

/**
 * Запись кэша состояния: итог зонда, момент, после которого она выселяется
 * (часы кэша), номер зонда (растёт с каждым зондом маршрутизатора: «снято после
 * начала этого чтения») и момент его начала по монотонным часам (потолок
 * частоты зондов) по монотонным часам.
 */
export interface CacheEntry {
  readonly outcome: ProbeOutcome;
  readonly expiresAt: number;
  readonly seq: number;
  readonly startedAt: number;
}
