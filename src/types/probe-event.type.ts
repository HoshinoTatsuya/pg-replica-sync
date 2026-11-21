import type { ProbeOutcome } from './probe-outcome.type';

/** Зонд узла выполнен (для метрик: число зондов, отказы, задержка). */
export interface ProbeEvent {
  readonly node: string;
  readonly outcome: ProbeOutcome;
  readonly durationMs: number;
}
