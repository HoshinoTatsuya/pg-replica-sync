import type { Client } from 'pg';

/**
 * Закрыть сокет соединения сразу. `client.end()` шлёт Terminate и ждёт сервер:
 * на замёрзшей сети он висел бы до таймаута TCP и держал бы цикл событий.
 * Сокет берётся по форме: у pg это `client.connection.stream`.
 */
export function destroyClient(client: Client): void {
  const stream = (client as unknown as { connection?: { stream?: { destroy?: () => void } } }).connection
    ?.stream;
  stream?.destroy?.();
}
