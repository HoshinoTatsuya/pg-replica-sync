import { adminQuery } from './admin-query';

/**
 * Оборвать на сервере соединения с этим `application_name`. В спеках — это и
 * «сервер потерял соединение зонда», и уборка: соединение, которое код забыл
 * закрыть, обрывается сервером, и процесс jest не висит на открытом сокете
 * (мутация «close ничего не закрывает» краснеет утверждением, а не зависанием).
 *
 * Выборка — в подзапросе с `OFFSET 0`: порядок условий в WHERE Postgres не
 * обещает, и `pg_terminate_backend(pid)` рядом с фильтром мог бы выполниться
 * для КАЖДОЙ строки pg_stat_activity — вместе со своим соединением и walsender'ами.
 */
export async function terminateBackends(url: string, applicationName: string): Promise<number> {
  const name = applicationName.replaceAll("'", "''");
  const rows = await adminQuery<{ terminated: boolean }>(
    url,
    `SELECT pg_terminate_backend(pid) AS terminated FROM (
       SELECT pid FROM pg_stat_activity WHERE application_name = '${name}' AND pid <> pg_backend_pid() OFFSET 0
     ) AS chosen`,
  );
  return rows.filter((row) => row.terminated).length;
}
