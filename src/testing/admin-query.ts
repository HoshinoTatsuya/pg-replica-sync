import { Client } from 'pg';

/** Один запрос отдельным соединением (суперпользователь): пауза, промоция, DDL. */
export async function adminQuery<T = Record<string, unknown>>(url: string, text: string): Promise<T[]> {
  const client = new Client({ connectionString: url, application_name: 'pg-replica-sync-spec-admin' });
  client.on('error', () => undefined);
  await client.connect();
  try {
    return (await client.query(text)).rows as T[];
  } finally {
    await client.end();
  }
}
