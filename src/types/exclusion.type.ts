import type { ExclusionReason } from './exclusion-reason.type';

/** Реплика, не подошедшая для чтения, и почему. */
export interface Exclusion {
  readonly node: string;
  readonly reason: ExclusionReason;
}
