import { randomUUID } from 'node:crypto';

import { adminQuery } from './admin-query';
import { waitForReplicas } from './wait-for-replicas';

/**
 * Таблица спеки на мастере с правами роли приложения; возвращается, когда
 * DDL воспроизведён на перечисленных репликах.
 */
export async function createSharedTable(primaryUrl: string, replicaUrls: readonly string[]): Promise<string> {
  const table = `t_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
  await adminQuery(
    primaryUrl,
    `CREATE TABLE ${table} (id integer PRIMARY KEY, note text NOT NULL DEFAULT '')`,
  );
  await adminQuery(primaryUrl, `GRANT SELECT, INSERT, UPDATE, DELETE ON ${table} TO app`);
  await waitForReplicas(primaryUrl, replicaUrls);
  return table;
}
