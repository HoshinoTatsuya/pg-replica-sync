import { Pool } from 'pg';

import { EXCLUSION_REASON } from './constants/exclusion-reason.constant';
import { NODE_ROLE } from './constants/node-role.constant';
import { ROUTE_REASON } from './constants/route-reason.constant';
import { ReplicaRouter } from './replica-router';
import { adminQuery } from './testing/admin-query';
import { asRole } from './testing/as-role';
import { createSharedTable } from './testing/create-shared-table';
import { replicationEnv } from './testing/replication-env';
import { setApplyDelay } from './testing/set-apply-delay';
import { SPEC_SECRET } from './testing/spec-secret';
import { waitForReplicas } from './testing/wait-for-replicas';
import type { ProbeEvent } from './types/probe-event.type';

/**
 * Настоящая потоковая репликация: мастер и две реплики (pg_basebackup -R).
 * Маршрутизатор и чтение — под ролью приложения без суперправ; пауза и
 * задержка воспроизведения — суперпользователем.
 */
jest.setTimeout(60_000);

const SECRET = SPEC_SECRET;
const env = replicationEnv();
const APP = {
  primary: asRole(env.primary, 'app'),
  r1: asRole(env.replica1, 'app'),
  r2: asRole(env.replica2, 'app'),
};

let table: string;
const pools: Pool[] = [];
const routers: ReplicaRouter<Pool>[] = [];
let nextId = 0;
/** Часы кэша: потолок кэша истекает продвижением, а не ожиданием. */
let now = 0;

const pool = (url: string): Pool => {
  const created = new Pool({ connectionString: url, max: 2 });
  created.on('error', () => undefined);
  pools.push(created);
  return created;
};

const makeRouter = (
  options: { waitForCatchUpMs?: number; observer?: { probed?: (event: ProbeEvent) => void } } = {},
) => {
  const router = new ReplicaRouter<Pool>({
    primary: { name: 'primary', connection: APP.primary, target: pool(APP.primary) },
    replicas: [
      { name: 'r1', connection: APP.r1, target: pool(APP.r1) },
      { name: 'r2', connection: APP.r2, target: pool(APP.r2) },
    ],
    secrets: [SECRET],
    clock: () => now,
    ...options,
  });
  routers.push(router);
  return router;
};

/** Запись на мастере и токен с ТОГО ЖЕ соединения после COMMIT. */
const writeAndToken = async (
  router: ReplicaRouter<Pool>,
  primary: Pool,
): Promise<{ id: number; token: string }> => {
  nextId += 1;
  const id = nextId;
  const client = await primary.connect();
  try {
    await client.query('BEGIN');
    await client.query(`INSERT INTO ${table} (id, note) VALUES ($1, 'w')`, [id]);
    await client.query('COMMIT');
    return { id, token: await router.issueToken(client) };
  } finally {
    client.release();
  }
};

const sees = async (target: Pool, id: number): Promise<boolean> =>
  (await target.query(`SELECT 1 FROM ${table} WHERE id = $1`, [id])).rowCount === 1;

beforeAll(async () => {
  table = await createSharedTable(env.primary, [env.replica1, env.replica2]);
});

afterEach(async () => {
  for (const url of [env.replica1, env.replica2]) {
    await adminQuery(url, 'SELECT pg_wal_replay_resume()');
    await setApplyDelay(url, null);
  }
  await waitForReplicas(env.primary, [env.replica1, env.replica2]);
  await Promise.all(routers.splice(0).map((router) => router.close()));
  await Promise.all(pools.splice(0).map((created) => created.end()));
});

describe('читаешь свои записи на настоящей репликации', () => {
  it('запись → немедленное чтение с токеном видит запись: 40 раз подряд, куда бы ни ушло', async () => {
    const router = makeRouter();
    const primary = pools[0] as Pool;
    const seen: boolean[] = [];
    const roles: string[] = [];
    for (let i = 0; i < 40; i += 1) {
      const { id, token } = await writeAndToken(router, primary);
      const decision = await router.route(token);
      roles.push(decision.role);
      seen.push(await sees(decision.target, id));
    }
    expect(seen).toEqual(Array.from({ length: 40 }, () => true));
    expect(router.stats().reads.replica + router.stats().reads.primary).toBe(40);
    expect(roles.length).toBe(40);
  });

  it('реплики на паузе — мастер; после resume и догоняния — снова реплика, и запись там видна', async () => {
    const router = makeRouter();
    const primary = pools[0] as Pool;
    await adminQuery(env.replica1, 'SELECT pg_wal_replay_pause()');
    await adminQuery(env.replica2, 'SELECT pg_wal_replay_pause()');
    const { id, token } = await writeAndToken(router, primary);

    const paused = await router.route(token);
    expect(paused.role).toBe(NODE_ROLE.primary);
    expect(paused.reason).toBe(ROUTE_REASON.noReplicaEligible);
    expect([...paused.excluded].sort((a, b) => a.node.localeCompare(b.node))).toEqual([
      { node: 'r1', reason: EXCLUSION_REASON.paused },
      { node: 'r2', reason: EXCLUSION_REASON.paused },
    ]);
    expect(await sees(paused.target, id)).toBe(true);

    await adminQuery(env.replica1, 'SELECT pg_wal_replay_resume()');
    await adminQuery(env.replica2, 'SELECT pg_wal_replay_resume()');
    // Маркер записан после токена: обе реплики прошли и позицию токена.
    await waitForReplicas(env.primary, [env.replica1, env.replica2]);
    // Кэш помнит «на паузе» до своего потолка: продвигаем его часы.
    now += 1_000;

    const resumed = await router.route(token);
    expect(resumed.role).toBe(NODE_ROLE.replica);
    expect(resumed.reason).toBe(ROUTE_REASON.replicaCaughtUp);
    expect(resumed.excluded).toEqual([]);
    expect(await sees(resumed.target, id)).toBe(true);
  });

  it('две реплики, одна отстаёт (задержка применения, не пауза) — каждое чтение на догнавшую', async () => {
    const router = makeRouter();
    const primary = pools[0] as Pool;
    await setApplyDelay(env.replica2, '1h');
    const { id, token } = await writeAndToken(router, primary);
    await waitForReplicas(env.primary, [env.replica1]);

    const decisions = [];
    for (let i = 0; i < 10; i += 1) {
      decisions.push(await router.route(token));
    }
    expect(decisions.map((decision) => decision.node)).toEqual(Array.from({ length: 10 }, () => 'r1'));
    expect(decisions[0]?.excluded).toEqual([{ node: 'r2', reason: EXCLUSION_REASON.behind }]);
    expect(await sees((decisions[0] as { target: Pool }).target, id)).toBe(true);
    // Отставшая реплика записи действительно не видит: выбор по позиции, а не случайно.
    expect(await sees(pools[2] as Pool, id)).toBe(false);
  });

  it('ожидание догоняния: чтение ждёт, пока реплика догонит, и уходит на неё, а не на мастер', async () => {
    let resolveBehind: (() => void) | undefined;
    const behindSeen = new Promise<void>((resolve) => {
      resolveBehind = resolve;
    });
    const router = makeRouter({
      waitForCatchUpMs: 30_000,
      observer: {
        probed: (event) => {
          if (event.node === 'r2' && event.outcome.ok) {
            resolveBehind?.();
          }
        },
      },
    });
    const primary = pools[0] as Pool;
    await adminQuery(env.replica1, 'SELECT pg_wal_replay_pause()');
    await setApplyDelay(env.replica2, '1h');
    const { id, token } = await writeAndToken(router, primary);

    const pending = router.route(token);
    await behindSeen;
    await setApplyDelay(env.replica2, null);
    const decision = await pending;

    expect(decision.role).toBe(NODE_ROLE.replica);
    expect(decision.node).toBe('r2');
    expect(decision.catchUpPolls).toBeGreaterThan(0);
    expect(decision.excluded).toEqual([{ node: 'r1', reason: EXCLUSION_REASON.paused }]);
    expect(await sees(decision.target, id)).toBe(true);
  });

  it('ожидание с потолком: реплика не догоняет — мастер по потолку, а не зависание', async () => {
    const router = makeRouter({ waitForCatchUpMs: 300 });
    const primary = pools[0] as Pool;
    await adminQuery(env.replica1, 'SELECT pg_wal_replay_pause()');
    await setApplyDelay(env.replica2, '1h');
    const { id, token } = await writeAndToken(router, primary);

    const decision = await router.route(token);
    expect(decision.role).toBe(NODE_ROLE.primary);
    expect(decision.reason).toBe(ROUTE_REASON.noReplicaEligible);
    expect(decision.catchUpPolls).toBeGreaterThan(0);
    expect([...decision.excluded].sort((a, b) => a.node.localeCompare(b.node))).toEqual([
      { node: 'r1', reason: EXCLUSION_REASON.paused },
      { node: 'r2', reason: EXCLUSION_REASON.behind },
    ]);
    expect(await sees(decision.target, id)).toBe(true);
  });
});
