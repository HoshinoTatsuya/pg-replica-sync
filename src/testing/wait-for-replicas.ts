import { reachablePrimaryLsn } from './reachable-primary-lsn';
import { waitForReplay } from './wait-for-replay';

/**
 * Реплики воспроизвели всё, что мастер записал к моменту вызова (маркер и
 * достижимая позиция — `reachablePrimaryLsn`). Позиция токена, выданного
 * раньше, тоже пройдена: позиция вставки монотонна, маркер записан после
 * токена; токен, выданный сразу после, равен этой позиции.
 */
export async function waitForReplicas(primaryUrl: string, replicaUrls: readonly string[]): Promise<void> {
  const target = await reachablePrimaryLsn(primaryUrl);
  await Promise.all(replicaUrls.map((url) => waitForReplay(url, target)));
}
