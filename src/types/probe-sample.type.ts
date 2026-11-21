import type { ProbeOutcome } from './probe-outcome.type';

/** Итог зонда и его номер: номер больше снятого в начале чтения — зонд начат после него. */
export interface ProbeSample {
  readonly outcome: ProbeOutcome;
  readonly seq: number;
}
