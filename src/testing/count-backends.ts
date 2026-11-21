import { adminQuery } from './admin-query';

/** Сколько соединений с этим `application_name` открыто на узле (суперпользователь видит все). */
export async function countBackends(url: string, applicationName: string): Promise<number> {
  const [row] = await adminQuery<{ count: number }>(
    url,
    `SELECT count(*)::int AS count FROM pg_stat_activity WHERE application_name = '${applicationName.replaceAll("'", "''")}'`,
  );
  return row?.count ?? -1;
}
