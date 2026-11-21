import { randomUUID } from 'node:crypto';

import { Client, Pool } from 'pg';

import { EXCLUSION_REASON } from './constants/exclusion-reason.constant';
import { NODE_ROLE } from './constants/node-role.constant';
import { PROBE_SQL } from './constants/probe-sql.constant';
import { ROUTE_REASON } from './constants/route-reason.constant';
import { readNodeState } from './read-node-state';
import { ReplicaRouter } from './replica-router';
import { adminQuery } from './testing/admin-query';
import { asRole } from './testing/as-role';
import { createSharedTable } from './testing/create-shared-table';
import { replicationEnv } from './testing/replication-env';
import { setApplyDelay } from './testing/set-apply-delay';
import { SPEC_SECRET } from './testing/spec-secret';
import { stopWalReceiver } from './testing/stop-wal-receiver';
import { SwitchingProxy } from './testing/switching-proxy';
import { terminateBackends } from './testing/terminate-backends';
import { untilChanged } from './testing/until-changed';
import { waitForReplicas } from './testing/wait-for-replicas';
import type { ConfirmEvent } from './types/confirm-event.type';
import type { RouteDecision } from './types/route-decision.type';
import type { RouterObserver } from './types/router-observer.type';

/**
 * Узел меняется под маршрутизатором: соединение зонда оборвано (перезапуск
 * реплики), приёмник WAL реплики стоит (мастер ей недоступен), за адресом —
 * другой сервер или балансировщик над несколькими.
 */
jest.setTimeout(60_000);

const env = replicationEnv();
const APP = {
  primary: asRole(env.primary, 'app'),
  r1: asRole(env.replica1, 'app'),
  r2: asRole(env.replica2, 'app'),
};

let table: string;
let now = 0;
let nextId = 0;
const routers: ReplicaRouter<string>[] = [];
const pools: Pool[] = [];
const proxies: SwitchingProxy[] = [];
const restores: (() => Promise<void>)[] = [];
const applicationNames: string[] = [];

const pool = (url: string): Pool => {
  const created = new Pool({ connectionString: url, max: 2 });
  created.on('error', () => undefined);
  pools.push(created);
  return created;
};

/** Своё `application_name` соединений зонда: их можно найти и оборвать на сервере. */
const probeName = (): string => {
  const name = `spec-node-${randomUUID().slice(0, 8)}`;
  applicationNames.push(name);
  return name;
};

const makeRouter = (
  replicas: readonly { name: string; connection: string; balanced?: boolean }[],
  applicationName: string,
  observer: RouterObserver = {},
): ReplicaRouter<string> => {
  const router = new ReplicaRouter<string>({
    primary: { name: 'primary', connection: APP.primary, target: 'primary' },
    replicas: replicas.map((replica) => ({
      name: replica.name,
      connection: { connectionString: replica.connection, application_name: applicationName },
      target: replica.name,
      ...(replica.balanced === undefined ? {} : { balanced: replica.balanced }),
    })),
    secrets: [SPEC_SECRET],
    clock: () => now,
    stateTtlMs: 1_000,
    probeTimeoutMs: 1_000,
    observer,
  });
  routers.push(router);
  return router;
};

const writeAndToken = async (router: ReplicaRouter<string>): Promise<{ id: number; token: string }> => {
  nextId += 1;
  const id = nextId;
  const client = await pool(APP.primary).connect();
  try {
    await client.query('BEGIN');
    await client.query(`INSERT INTO ${table} (id) VALUES ($1)`, [id]);
    return { id, token: await router.commitAndIssueToken(client) };
  } finally {
    client.release();
  }
};

/** Решение, как только оно перестало быть «эта реплика»: потеря соединения доходит до клиента асинхронно. */
const untilNotReplica = (
  router: ReplicaRouter<string>,
  token: string,
  node: string,
): Promise<RouteDecision<string>> =>
  untilChanged(
    () => router.route(token),
    (decision) => decision.node === node,
  );

beforeAll(async () => {
  table = await createSharedTable(env.primary, [env.replica1, env.replica2]);
});

afterEach(async () => {
  for (const restore of restores.splice(0)) {
    await restore();
  }
  for (const url of [env.replica1, env.replica2]) {
    await adminQuery(url, 'SELECT pg_wal_replay_resume()');
    await setApplyDelay(url, null);
  }
  await waitForReplicas(env.primary, [env.replica1, env.replica2]);
  await Promise.all(routers.splice(0).map((router) => router.close()));
  for (const proxy of proxies.splice(0)) {
    await proxy.close();
  }
  await Promise.all(pools.splice(0).map((created) => created.end()));
  for (const name of applicationNames.splice(0)) {
    for (const url of [env.primary, env.replica1, env.replica2]) {
      await terminateBackends(url, name);
    }
  }
});

describe('соединение зонда реплики оборвано (перезапуск, сеть)', () => {
  it('состояние, снятое через оборванное соединение, больше не используется: решение — по свежему зонду', async () => {
    const name = probeName();
    const router = makeRouter([{ name: 'r1', connection: APP.r1 }], name);
    const { token } = await writeAndToken(router);
    await waitForReplicas(env.primary, [env.replica1]);
    expect((await router.route(token)).node).toBe('r1');

    // Свежий зонд покажет паузу; кэш (часы стоят — сам он не истечёт) помнит «догнала».
    await adminQuery(env.replica1, 'SELECT pg_wal_replay_pause()');
    expect(await terminateBackends(env.replica1, name)).toBe(1);

    const decision = await untilNotReplica(router, token, 'r1');
    expect(decision.role).toBe(NODE_ROLE.primary);
    expect(decision.excluded).toEqual([{ node: 'r1', reason: EXCLUSION_REASON.paused }]);
  });
});

describe('приёмник WAL реплики стоит (мастер ей недоступен)', () => {
  it('линия времени этого же экземпляра реплики известна — чтение с токеном идёт на реплику, а не на мастер', async () => {
    const router = makeRouter([{ name: 'r1', connection: APP.r1 }], probeName());
    const { id, token } = await writeAndToken(router);
    await waitForReplicas(env.primary, [env.replica1]);
    expect((await router.route(token)).node).toBe('r1');
    restores.push(await stopWalReceiver(env.replica1));
    now += 10_000;

    const decision = await router.route(token);
    expect(decision.role).toBe(NODE_ROLE.replica);
    expect(decision.node).toBe('r1');
    expect(decision.reason).toBe(ROUTE_REASON.replicaCaughtUp);
    const [seen] = await adminQuery<{ found: boolean }>(
      env.replica1,
      `SELECT EXISTS (SELECT 1 FROM ${table} WHERE id = ${id}) AS found`,
    );
    expect(seen?.found).toBe(true);

    // Контроль: маршрутизатор, не видевший линию времени этой реплики, её не угадывает.
    const fresh = makeRouter([{ name: 'r1', connection: APP.r1 }], probeName());
    const unknown = await fresh.route(token);
    expect(unknown.role).toBe(NODE_ROLE.primary);
    expect(unknown.excluded).toEqual([{ node: 'r1', reason: EXCLUSION_REASON.timelineUnknown }]);
  });

  it('тот же адрес — уже ДРУГОЙ сервер: линия времени прежнего экземпляра не переносится', async () => {
    const proxy = await SwitchingProxy.start([env.replica1, env.replica2]);
    proxies.push(proxy);
    proxy.target(0);
    const name = probeName();
    const router = makeRouter([{ name: 'x', connection: proxy.urlFor(APP.r1) }], name);
    const { token } = await writeAndToken(router);
    await waitForReplicas(env.primary, [env.replica1, env.replica2]);
    expect((await router.route(token)).node).toBe('x');

    restores.push(await stopWalReceiver(env.replica2));
    proxy.target(1);
    expect(await terminateBackends(env.replica1, name)).toBe(1);

    const decision = await untilNotReplica(router, token, 'x');
    expect(decision.role).toBe(NODE_ROLE.primary);
    expect(decision.excluded).toEqual([{ node: 'x', reason: EXCLUSION_REASON.timelineUnknown }]);
  });
});

describe('адрес реплики — балансировщик над несколькими', () => {
  it('решение подтверждается на соединении чтения: каждое чтение видит запись, отставший сервер отклонён', async () => {
    const proxy = await SwitchingProxy.start([env.replica1, env.replica2]);
    proxies.push(proxy);
    await setApplyDelay(env.replica2, '1h');
    const confirmEvents: ConfirmEvent[] = [];
    const router = makeRouter(
      [{ name: 'ro', connection: proxy.urlFor(APP.r1), balanced: true }],
      probeName(),
      { confirmed: (event) => confirmEvents.push(event) },
    );
    const { id, token } = await writeAndToken(router);
    await waitForReplicas(env.primary, [env.replica1]);
    const primaryPool = pool(APP.primary);

    const reads: { readonly confirmed: boolean; readonly seen: boolean }[] = [];
    for (let i = 0; i < 10; i += 1) {
      const decision = await router.route(token);
      expect(decision.role).toBe(NODE_ROLE.replica);
      expect(decision.mustConfirm).toBe(true);
      const client = new Client({ connectionString: proxy.urlFor(APP.r1) });
      client.on('error', () => undefined);
      await client.connect();
      try {
        const confirmed = await router.confirm(decision, client);
        const reader = confirmed ? client : primaryPool;
        const seen = ((await reader.query(`SELECT 1 FROM ${table} WHERE id = $1`, [id])).rowCount ?? 0) === 1;
        reads.push({ confirmed, seen });
      } finally {
        await client.end();
      }
    }
    expect(reads.map((read) => read.seen)).toEqual(Array.from({ length: 10 }, () => true));
    // Балансировщик по кругу: часть соединений чтения попала на отставший сервер и отклонена.
    expect(reads.filter((read) => read.confirmed).length).toBeGreaterThanOrEqual(3);
    expect(reads.filter((read) => !read.confirmed).length).toBeGreaterThanOrEqual(3);
    // Отказы confirm видны в счётчиках и в хуке, с причиной: решение «реплика» уже посчитано в reads.
    const confirms = router.stats().confirms;
    expect(confirms.confirmed).toBe(reads.filter((read) => read.confirmed).length);
    expect(confirms.rejected).toBe(reads.filter((read) => !read.confirmed).length);
    expect(confirms.reasons).toEqual({ behind: confirms.rejected });
    expect(confirmEvents.map((event) => event.confirmed)).toEqual(reads.map((read) => read.confirmed));
  });

  it('запрос подтверждения отказал или не ответил — «нет» (чтение с мастера), с причиной unavailable и ошибкой в хуке', async () => {
    const events: ConfirmEvent[] = [];
    const router = makeRouter([{ name: 'r1', connection: APP.r1 }], probeName(), {
      confirmed: (event) => events.push(event),
    });
    const { token } = await writeAndToken(router);
    await waitForReplicas(env.primary, [env.replica1]);
    const decision = await router.route(token);
    expect(decision.role).toBe(NODE_ROLE.replica);
    const failing = { query: () => Promise.reject(new Error('соединение чтения оборвано')) };
    const silent = { query: () => new Promise<never>(() => undefined) };
    expect(await router.confirm(decision, failing)).toBe(false);
    expect(await router.confirm(decision, silent)).toBe(false);
    expect(await router.confirm(decision, pool(APP.r1))).toBe(true);
    expect(router.stats().confirms).toEqual({ confirmed: 1, rejected: 2, reasons: { unavailable: 2 } });
    expect(events.map((event) => [event.confirmed, event.reason, event.error?.message])).toEqual([
      [false, EXCLUSION_REASON.unavailable, 'соединение чтения оборвано'],
      [false, EXCLUSION_REASON.unavailable, 'состояние узла не определилось за 1000 мс'],
      [true, null, undefined],
    ]);
  });

  it('экземпляр сервера не зависит от DateStyle и TimeZone сессии: зонд и соединение чтения видят один экземпляр', async () => {
    const instances: (string | null)[] = [];
    for (const settings of [
      "SET TimeZone = 'UTC'; SET DateStyle = 'ISO, MDY'",
      "SET TimeZone = 'Asia/Tokyo'; SET DateStyle = 'SQL, DMY'",
    ]) {
      const client = new Client({ connectionString: APP.r1 });
      client.on('error', () => undefined);
      await client.connect();
      try {
        await client.query(settings);
        instances.push(readNodeState((await client.query(PROBE_SQL.STATE)).rows[0]).instance);
      } finally {
        await client.end();
      }
    }
    expect(instances[0]).not.toBeNull();
    expect(instances[1]).toBe(instances[0]);
  });

  it('решение «мастер» подтверждать не нужно; чужое решение — отказ', async () => {
    const router = makeRouter([{ name: 'r1', connection: APP.r1 }], probeName());
    const other = makeRouter([{ name: 'r1', connection: APP.r1 }], probeName());
    const replicaPool = pool(APP.r1);
    await adminQuery(env.replica1, 'SELECT pg_wal_replay_pause()');
    const { token } = await writeAndToken(router);
    const toPrimary = await router.route(token);
    expect(toPrimary.role).toBe(NODE_ROLE.primary);
    expect(toPrimary.mustConfirm).toBe(false);
    expect(await router.confirm(toPrimary, replicaPool)).toBe(true);

    await adminQuery(env.replica1, 'SELECT pg_wal_replay_resume()');
    await waitForReplicas(env.primary, [env.replica1]);
    now += 10_000;
    const toReplica = await other.route(token);
    expect(toReplica.role).toBe(NODE_ROLE.replica);
    expect(toReplica.mustConfirm).toBe(false);
    await expect(router.confirm(toReplica, replicaPool)).rejects.toThrow('не этим маршрутизатором');
    expect(await other.confirm(toReplica, replicaPool)).toBe(true);
  });
});
