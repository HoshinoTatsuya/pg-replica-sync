import { Pool, type PoolClient } from 'pg';

import { NODE_ROLE } from './constants/node-role.constant';
import { ReplicaRouter } from './replica-router';
import { asRole } from './testing/as-role';
import { createSharedTable } from './testing/create-shared-table';
import { replicationEnv } from './testing/replication-env';
import { setApplyDelay } from './testing/set-apply-delay';
import { SPEC_SECRET } from './testing/spec-secret';
import { waitForReplicas } from './testing/wait-for-replicas';

/**
 * Пулер в режиме transaction (pgbouncer над двумя репликами, одна отстаёт
 * задержкой применения): к серверу привязана только транзакция. Рецепт README —
 * `confirm` первым запросом ВНУТРИ читающей транзакции и чтение в ней же.
 */
jest.setTimeout(60_000);

const env = replicationEnv();
const APP = { primary: asRole(env.primary, 'app'), r1: asRole(env.replica1, 'app') };

let table: string;
const pools: Pool[] = [];
const routers: ReplicaRouter<Pool>[] = [];

const pool = (url: string, max: number): Pool => {
  const created = new Pool({ connectionString: url, max });
  created.on('error', () => undefined);
  pools.push(created);
  return created;
};

/** Экземпляр сервера, на котором выполнилась транзакция (момент старта postmaster). */
const serverOf = async (client: PoolClient): Promise<string> =>
  (
    await client.query<{ started: string }>(
      'SELECT extract(epoch FROM pg_postmaster_start_time())::text AS started',
    )
  ).rows[0]?.started ?? '';

/**
 * Серверные соединения pgbouncer открываются по требованию: один клиент без
 * конкуренции получил бы одно соединение и один сервер навсегда. Четыре
 * одновременные транзакции открывают четыре (хосты — по кругу), дальше
 * простаивающие отдаются по очереди (server_round_robin) — транзакции идут на
 * оба сервера.
 */
const warmUp = async (): Promise<void> => {
  const warm = new Pool({ connectionString: env.bouncerTx, max: 4 });
  warm.on('error', () => undefined);
  try {
    await Promise.all(
      Array.from({ length: 4 }, async () => {
        const client = await warm.connect();
        try {
          await client.query('BEGIN READ ONLY');
          await client.query('SELECT pg_sleep(0.2)');
          await client.query('COMMIT');
        } finally {
          client.release();
        }
      }),
    );
  } finally {
    await warm.end();
  }
};

beforeAll(async () => {
  table = await createSharedTable(env.primary, [env.replica1, env.replica2]);
});

afterEach(async () => {
  await setApplyDelay(env.replica2, null);
  await waitForReplicas(env.primary, [env.replica1, env.replica2]);
  await Promise.all(routers.splice(0).map((router) => router.close()));
  await Promise.all(pools.splice(0).map((created) => created.end()));
});

describe('пулер в режиме transaction над несколькими репликами', () => {
  it('контроль: транзакции одного клиента пулера попадают на разные серверы', async () => {
    await warmUp();
    const bouncer = pool(env.bouncerTx, 1);
    const client = await bouncer.connect();
    const servers = new Set<string>();
    try {
      for (let i = 0; i < 20; i += 1) {
        await client.query('BEGIN READ ONLY');
        servers.add(await serverOf(client));
        await client.query('COMMIT');
      }
    } finally {
      client.release();
    }
    expect(servers.size).toBe(2);
  });

  it('confirm первым запросом в читающей транзакции, чтение в ней же: каждое подтверждённое чтение видит запись, отставший сервер отклонён', async () => {
    await setApplyDelay(env.replica2, '1h');
    await warmUp();
    const bouncer = pool(env.bouncerTx, 1);
    const primary = pool(APP.primary, 2);
    const router = new ReplicaRouter<Pool>({
      primary: { name: 'primary', connection: APP.primary, target: primary },
      // Зонд — напрямую к догнавшей реплике: решение «реплика» не зависит от того, на какой
      // сервер пулер отдал транзакцию зонда (иначе чётность очереди серверов могла бы отдавать
      // зонд всегда отставшей). Предмет проверки — confirm на соединении чтения через пулер.
      replicas: [{ name: 'ro', connection: APP.r1, target: bouncer, balanced: true }],
      secrets: [SPEC_SECRET],
    });
    routers.push(router);
    const writer = await primary.connect();
    let token: string;
    try {
      await writer.query('BEGIN');
      await writer.query(`INSERT INTO ${table} (id) VALUES (1)`);
      token = await router.commitAndIssueToken(writer);
    } finally {
      writer.release();
    }
    await waitForReplicas(env.primary, [env.replica1]);

    const reads: { readonly confirmed: boolean; readonly seen: boolean }[] = [];
    for (let i = 0; i < 20; i += 1) {
      const decision = await router.route(token);
      if (decision.role !== NODE_ROLE.replica) {
        reads.push({ confirmed: false, seen: true });
        continue;
      }
      const client = await decision.target.connect();
      try {
        await client.query('BEGIN READ ONLY');
        const confirmed = await router.confirm(decision, client);
        const seen = confirmed
          ? ((await client.query(`SELECT 1 FROM ${table} WHERE id = 1`)).rowCount ?? 0) === 1
          : ((await primary.query(`SELECT 1 FROM ${table} WHERE id = 1`)).rowCount ?? 0) === 1;
        await client.query('COMMIT');
        reads.push({ confirmed, seen });
      } finally {
        client.release();
      }
    }
    expect(reads.map((read) => read.seen)).toEqual(Array.from({ length: 20 }, () => true));
    expect(router.stats().reads).toEqual({ replica: 20, primary: 0 });
    // Транзакции чтения попадали на оба сервера: часть подтверждена, часть отклонена.
    expect(reads.filter((read) => read.confirmed).length).toBeGreaterThanOrEqual(3);
    expect(reads.filter((read) => !read.confirmed).length).toBeGreaterThanOrEqual(3);
  });
});
