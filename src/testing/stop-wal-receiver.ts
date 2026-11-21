import { setTimeout as sleep } from 'node:timers/promises';

import { adminQuery } from './admin-query';

/**
 * Остановить приёмник WAL реплики — так реплика видит недоступный мастер:
 * `primary_conninfo = ''`, приёмник уходит, `pg_stat_wal_receiver` пуст.
 * Возвращает функцию, которая возвращает прежний `primary_conninfo` и ждёт,
 * пока приёмник снова покажет линию времени. Потолки — по времени, с причиной.
 */
export async function stopWalReceiver(replicaUrl: string): Promise<() => Promise<void>> {
  const [row] = await adminQuery<{ conninfo: string }>(
    replicaUrl,
    "SELECT current_setting('primary_conninfo') AS conninfo",
  );
  const conninfo = row?.conninfo ?? '';
  if (conninfo === '') {
    throw new Error('у реплики нет primary_conninfo: останавливать нечего');
  }
  const waitReceiver = async (running: boolean): Promise<void> => {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const [state] = await adminQuery<{ tli: number | null }>(
        replicaUrl,
        'SELECT (SELECT received_tli FROM pg_stat_wal_receiver LIMIT 1) AS tli',
      );
      if ((state?.tli !== null && state?.tli !== undefined) === running) {
        return;
      }
      await sleep(50);
    }
    throw new Error(`приёмник WAL реплики не ${running ? 'поднялся' : 'остановился'} за 15 с`);
  };
  await adminQuery(replicaUrl, "ALTER SYSTEM SET primary_conninfo = ''");
  await adminQuery(replicaUrl, 'SELECT pg_reload_conf()');
  await waitReceiver(false);
  return async () => {
    await adminQuery(replicaUrl, `ALTER SYSTEM SET primary_conninfo = '${conninfo.replaceAll("'", "''")}'`);
    await adminQuery(replicaUrl, 'SELECT pg_reload_conf()');
    await waitReceiver(true);
  };
}
