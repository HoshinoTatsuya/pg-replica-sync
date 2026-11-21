import { setTimeout as sleep } from 'node:timers/promises';

import { adminQuery } from './admin-query';
import { replayLsn } from './replay-lsn';

/**
 * Дождаться УСЛОВИЯ «реплика воспроизвела позицию» — с потолком по времени,
 * а не по числу опросов: под нагрузкой каждый опрос (новое соединение) дольше,
 * и счёт опросов сжимал потолок. Потолок (20 с) — запас под нагруженную машину
 * и меньше таймаута теста, поэтому зависание падает этой ошибкой с причиной, а
 * не таймаутом jest. Он ничего не маскирует: ожидание — подготовка спеки, а не
 * утверждение о маршрутизаторе; «реплика не догнала» спеки делают паузой или
 * задержкой применения, а не временем.
 *
 * Цель обязана быть ДОСТИЖИМОЙ — концом записанной записи
 * (`reachablePrimaryLsn`), а не позицией вставки после переключения сегмента.
 * Отказ называет, что видит реплика: принято, воспроизведено, пауза, задержка.
 */
export async function waitForReplay(replicaUrl: string, target: bigint, ceilingMs = 20_000): Promise<void> {
  const deadline = Date.now() + ceilingMs;
  let polls = 0;
  while (Date.now() < deadline) {
    polls += 1;
    if ((await replayLsn(replicaUrl)) >= target) {
      return;
    }
    await sleep(25);
  }
  const [state] = await adminQuery<Record<string, string>>(
    replicaUrl,
    `SELECT pg_last_wal_receive_lsn()::text AS received, pg_last_wal_replay_lsn()::text AS replayed,
       pg_get_wal_replay_pause_state() AS pause, current_setting('recovery_min_apply_delay') AS apply_delay`,
  );
  throw new Error(
    `реплика не воспроизвела позицию ${target} за ${ceilingMs} мс (${polls} опросов): ${JSON.stringify(state)}`,
  );
}
