import type { WalPosition } from './wal-position.type';

/**
 * Что требуется от реплики для этого чтения: догнать позицию токена или (без
 * токена) не отставать от мастера больше потолка.
 */
export type ReplicaRequirement =
  | { readonly kind: 'position'; readonly position: WalPosition }
  | {
      readonly kind: 'lag';
      readonly systemId: string;
      readonly timeline: number;
      readonly primaryInsertLsn: bigint;
      readonly maxLagBytes: bigint;
    };
