import type { ExclusionReason } from './exclusion-reason.type';
import type { ReplicaNode } from './replica-node.type';

/** Реплика, рассмотренная для чтения: `reason === null` — подходит. */
export interface Evaluated<TTarget> {
  readonly node: string;
  readonly replica: ReplicaNode<TTarget>;
  readonly reason: ExclusionReason | null;
}
