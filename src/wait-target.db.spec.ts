import { parseLsn } from './parse-lsn';
import { adminQuery } from './testing/admin-query';
import { reachablePrimaryLsn } from './testing/reachable-primary-lsn';
import { replayLsn } from './testing/replay-lsn';
import { replicationEnv } from './testing/replication-env';
import { waitForReplay } from './testing/wait-for-replay';

/**
 * Обвязка спек: цель ожидания догоняния обязана быть ДОСТИЖИМОЙ. Флак
 * «реплика не воспроизвела позицию … за 400 опросов» был не нагрузкой: после
 * `pg_switch_wal` позиция вставки мастера стоит за заголовком нового сегмента
 * (+40 байт), реплика стоит на границе и догоняет её только с фоновой записью
 * WAL (замер: 13 и 15 с при потолке ожидания 10 с). Здесь — утверждения о
 * самой цели, а не о времени: цель не дальше сброшенного WAL мастера и равна
 * позиции вставки (её получит следующий токен).
 */
jest.setTimeout(60_000);

const env = replicationEnv();

const flushedLsn = async (): Promise<bigint> => {
  const [row] = await adminQuery<{ lsn: string }>(
    env.primary,
    'SELECT pg_current_wal_flush_lsn()::text AS lsn',
  );
  return parseLsn(row?.lsn ?? '');
};
const insertedLsn = async (): Promise<bigint> => {
  const [row] = await adminQuery<{ lsn: string }>(
    env.primary,
    'SELECT pg_current_wal_insert_lsn()::text AS lsn',
  );
  return parseLsn(row?.lsn ?? '');
};

afterEach(async () => {
  await adminQuery(env.replica1, 'SELECT pg_wal_replay_resume()');
});

describe('цель ожидания догоняния', () => {
  it('после pg_switch_wal: цель не дальше сброшенного WAL, равна позиции вставки, реплика её проходит', async () => {
    await adminQuery(env.primary, 'SELECT pg_switch_wal()');
    const target = await reachablePrimaryLsn(env.primary);
    // Состояние после маркера: вставка совпала со сброшенной (её и получит следующий токен).
    expect(target).toBeLessThanOrEqual(await flushedLsn());
    expect(await insertedLsn()).toBe(target);
    // Потолок 3 с — меньше цикла фонового снимка транзакций (15 с): цель достигается без него.
    await waitForReplay(env.replica1, target, 3_000);
    expect((await replayLsn(env.replica1)) >= target).toBe(true);
  });

  it('реплика на паузе — отказ ожидания по потолку с состоянием реплики, а не таймаут теста', async () => {
    await adminQuery(env.replica1, 'SELECT pg_wal_replay_pause()');
    await adminQuery(env.primary, 'SELECT pg_switch_wal()');
    const target = await reachablePrimaryLsn(env.primary);
    await expect(waitForReplay(env.replica1, target, 300)).rejects.toThrow(
      new RegExp(`реплика не воспроизвела позицию ${target} за 300 мс .*"pause":"(paused|pause requested)"`),
    );
  });
});
