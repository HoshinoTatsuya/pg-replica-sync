import { adminQuery } from './admin-query';

/**
 * `recovery_min_apply_delay` реплики: WAL принимается, но коммиты применяются
 * с задержкой — реплика отстаёт, НЕ будучи на паузе. `null` — снять задержку.
 */
export async function setApplyDelay(replicaUrl: string, delay: string | null): Promise<void> {
  await adminQuery(
    replicaUrl,
    delay === null
      ? 'ALTER SYSTEM RESET recovery_min_apply_delay'
      : `ALTER SYSTEM SET recovery_min_apply_delay = '${delay.replaceAll("'", "''")}'`,
  );
  await adminQuery(replicaUrl, 'SELECT pg_reload_conf()');
}
