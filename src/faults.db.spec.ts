import { FaultProxy } from '@hoshinotatsuya/fault-kit/tcp';
import { Pool } from 'pg';

import { EXCLUSION_REASON } from './constants/exclusion-reason.constant';
import { NODE_ROLE } from './constants/node-role.constant';
import { ROUTE_REASON } from './constants/route-reason.constant';
import { parseLsn } from './parse-lsn';
import { ProbeTimeoutError } from './probe-timeout.error';
import { ReplicaRouter } from './replica-router';
import { adminQuery } from './testing/admin-query';
import { asRole } from './testing/as-role';
import { closedPort } from './testing/closed-port';
import { createSharedTable } from './testing/create-shared-table';
import { insertLsn } from './testing/insert-lsn';
import { replicationEnv } from './testing/replication-env';
import { SPEC_SECRET } from './testing/spec-secret';
import { waitForReplicas } from './testing/wait-for-replicas';
import { TokenCodec } from './token-codec';
import type { ProbeEvent } from './types/probe-event.type';

/**
 * Отказы на настоящей репликации: недоступная реплика, реплика за
 * замёрзшим прокси, роль без прав на состояние приёмника WAL, испорченные и
 * чужие токены. Каждый отказ — исключение реплики с потолком времени, итог —
 * мастер, а не зависание и не «реплика».
 */
jest.setTimeout(60_000);

const SECRET = SPEC_SECRET;
const env = replicationEnv();
const APP = {
  primary: asRole(env.primary, 'app'),
  r1: asRole(env.replica1, 'app'),
  r2: asRole(env.replica2, 'app'),
};

/** Момент выдачи токенов, собранных спекой, и часы выдачи маршрутизатора: токены не просрочены. */
const ISSUED_AT = 1_700_000_000_000;

let table: string;
let now = 0;
let nextId = 100;
const routers: ReplicaRouter<string>[] = [];
const proxies: FaultProxy[] = [];
const pools: Pool[] = [];

const makeRouter = (
  replicas: readonly { name: string; connection: string }[],
  options: {
    primary?: string;
    probeTimeoutMs?: number;
    observer?: { probed?: (event: ProbeEvent) => void };
  } = {},
): ReplicaRouter<string> => {
  const router = new ReplicaRouter<string>({
    primary: { name: 'primary', connection: options.primary ?? APP.primary, target: 'primary' },
    replicas: replicas.map((replica) => ({ ...replica, target: replica.name })),
    secrets: [SECRET],
    clock: () => now,
    wallClock: () => ISSUED_AT,
    ...(options.probeTimeoutMs === undefined ? {} : { probeTimeoutMs: options.probeTimeoutMs }),
    ...(options.observer === undefined ? {} : { observer: options.observer }),
  });
  routers.push(router);
  return router;
};

/** Пул мастера под ролью приложения: токен после COMMIT, который уже вернулся. */
const primaryPool = (): Pool => {
  const created = new Pool({ connectionString: APP.primary, max: 1 });
  created.on('error', () => undefined);
  pools.push(created);
  return created;
};

/** Запись на мастере; возвращается, когда перечисленные реплики её воспроизвели. */
const writeReplayed = async (id: number, replicas: readonly string[]): Promise<void> => {
  await adminQuery(env.primary, `INSERT INTO ${table} (id) VALUES (${id})`);
  await waitForReplicas(env.primary, replicas);
};

/**
 * Запись, токен после неё и ожидание, пока реплики воспроизведут позицию токена.
 * Токен берётся ДО ожидания: взятый после, он включал бы фоновую запись WAL
 * мастера, случившуюся за время ожидания (Postgres 18 — снимок транзакций,
 * автоочистка), и реплика законно оказывалась бы «позади» — флак, а не дефект.
 */
const writeTokenReplayed = async (
  router: ReplicaRouter<string>,
  id: number,
  replicas: readonly string[],
): Promise<string> => {
  await adminQuery(env.primary, `INSERT INTO ${table} (id) VALUES (${id})`);
  const token = await router.issueToken(primaryPool());
  await waitForReplicas(env.primary, replicas);
  return token;
};

beforeAll(async () => {
  table = await createSharedTable(env.primary, [env.replica1, env.replica2]);
  // Идемпотентно: спеки идут и повторно на той же топологии (своя топология, мутационный прогон).
  await adminQuery(
    env.primary,
    "DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'plain') THEN CREATE ROLE plain LOGIN PASSWORD 'plain'; END IF; END $$",
  );
  await adminQuery(env.primary, `GRANT SELECT ON ${table} TO plain`);
  await waitForReplicas(env.primary, [env.replica1, env.replica2]);
});

afterEach(async () => {
  for (const proxy of proxies.splice(0)) {
    proxy.thaw();
    await proxy.close();
  }
  await Promise.all(routers.splice(0).map((router) => router.close()));
  await Promise.all(pools.splice(0).map((pool) => pool.end()));
});

describe('реплика недоступна или заморожена', () => {
  it('отказ соединения — реплика исключена, чтение на другую; повторно не опрашивается до потолка', async () => {
    const dead = `postgres://app:app@127.0.0.1:${await closedPort()}/postgres`;
    const router = makeRouter([
      { name: 'dead', connection: dead },
      { name: 'r1', connection: APP.r1 },
    ]);
    const token = await writeTokenReplayed(router, 1, [env.replica1]);

    const decision = await router.route(token);
    expect(decision.node).toBe('r1');
    expect(decision.excluded).toEqual([{ node: 'dead', reason: EXCLUSION_REASON.unavailable }]);
    const failed = router.stats().probes.failed;
    expect(failed).toBe(1);
    await router.route(token);
    expect(router.stats().probes.failed).toBe(failed);
  });

  it('замёрзший прокси: зонд обрывается по потолку, чтение на мастер; после thaw — снова реплика', async () => {
    const target = new URL(env.replica1);
    const proxy = await FaultProxy.start({ host: target.hostname, port: Number(target.port) });
    proxies.push(proxy);
    const viaProxy = new URL(APP.r1);
    viaProxy.port = String(proxy.port);
    const failures: Error[] = [];
    const router = makeRouter([{ name: 'r1', connection: viaProxy.toString() }], {
      probeTimeoutMs: 300,
      observer: {
        probed: (event) => {
          if (!event.outcome.ok) {
            failures.push(event.outcome.error);
          }
        },
      },
    });
    expect((await router.route(await writeTokenReplayed(router, 2, [env.replica1]))).node).toBe('r1');

    proxy.freeze();
    const token = await writeTokenReplayed(router, 3, [env.replica1]);
    now += 10_000;
    const frozen = await router.route(token);
    expect(frozen.role).toBe(NODE_ROLE.primary);
    expect(frozen.excluded).toEqual([{ node: 'r1', reason: EXCLUSION_REASON.unavailable }]);
    expect(failures.map((error) => error.constructor)).toEqual([ProbeTimeoutError]);

    // Второе чтение в окне повтора не ждёт потолок зонда снова: отказ из кэша.
    const again = await router.route(token);
    expect(again.role).toBe(NODE_ROLE.primary);
    expect(failures.length).toBe(1);

    proxy.thaw();
    now += 10_000;
    const thawed = await router.route(token);
    expect(thawed.node).toBe('r1');
    expect(thawed.reason).toBe(ROUTE_REASON.replicaCaughtUp);
  });
});

describe('медленная, но живая реплика против мёртвой', () => {
  const viaProxy = async (latencyMs: number | 'frozen'): Promise<{ proxy: FaultProxy; url: string }> => {
    const target = new URL(env.replica1);
    const proxy = await FaultProxy.start({ host: target.hostname, port: Number(target.port) });
    proxies.push(proxy);
    if (latencyMs === 'frozen') {
      proxy.freeze();
    } else {
      proxy.latency(latencyMs);
    }
    const url = new URL(APP.r1);
    url.hostname = '127.0.0.1';
    url.port = String(proxy.port);
    return { proxy, url: url.toString() };
  };

  const attempts = async (router: ReplicaRouter<string>): Promise<string[]> => {
    const seen: string[] = [];
    for (let i = 0; i < 10; i += 1) {
      // Отказ из кэша истёк — следующее чтение зондирует снова.
      now += 10_000;
      const decision = await router.route();
      seen.push(
        decision.role === NODE_ROLE.replica ? 'replica' : (decision.excluded[0]?.reason ?? decision.reason),
      );
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    return seen;
  };

  it('установка соединения дольше потолка зонда, запрос — короче: соединение доживает, следующий зонд — на нём, реплика годится', async () => {
    // 150 мс на каждый кусок: запрос зонда ≈ 300 мс, установка (несколько обменов) ≈ 900 мс.
    const { url } = await viaProxy(150);
    const router = makeRouter([{ name: 'r1', connection: url }], { probeTimeoutMs: 600 });
    const seen = await attempts(router);
    expect(seen[0]).toBe(EXCLUSION_REASON.unavailable);
    expect(seen.slice(-3)).toEqual(['replica', 'replica', 'replica']);
  });

  it('двойник: замёрзшая реплика остаётся unavailable, а её соединение рвётся по connectTimeoutMs и открывается заново', async () => {
    const { proxy, url } = await viaProxy('frozen');
    const router = new ReplicaRouter<string>({
      primary: { name: 'primary', connection: APP.primary, target: 'primary' },
      replicas: [{ name: 'r1', connection: url, target: 'r1' }],
      secrets: [SECRET],
      clock: () => now,
      wallClock: () => ISSUED_AT,
      probeTimeoutMs: 600,
      connectTimeoutMs: 1_000,
    });
    routers.push(router);
    const seen = await attempts(router);
    expect(seen).toEqual(Array.from({ length: 10 }, () => EXCLUSION_REASON.unavailable));
    // Не одно вечное соединение: по потолку установки оно рвётся, следующий зонд открывает новое.
    expect(proxy.stats().accepted).toBeGreaterThanOrEqual(3);
  });
});

describe('не смогли определить — мастер', () => {
  it('роль без pg_read_all_stats не видит линию времени реплики: исключение с этой причиной, не допуск', async () => {
    const router = makeRouter([
      { name: 'r1', connection: asRole(env.replica1, 'plain') },
      { name: 'r2', connection: asRole(env.replica2, 'plain') },
    ]);
    const token = await writeTokenReplayed(router, 4, [env.replica1, env.replica2]);

    for (const decision of [await router.route(token), await router.route()]) {
      expect(decision.role).toBe(NODE_ROLE.primary);
      expect([...decision.excluded].sort((a, b) => a.node.localeCompare(b.node))).toEqual([
        { node: 'r1', reason: EXCLUSION_REASON.noStatsPrivilege },
        { node: 'r2', reason: EXCLUSION_REASON.noStatsPrivilege },
      ]);
    }
  });

  it('токен записан не на мастере (узел в recovery) — токен «только мастер»', async () => {
    const unresolved: Error[] = [];
    const router = new ReplicaRouter<string>({
      primary: { name: 'primary', connection: APP.primary, target: 'primary' },
      replicas: [{ name: 'r1', connection: APP.r1, target: 'r1' }],
      secrets: [SECRET],
      observer: { tokenUnresolved: ({ error }) => unresolved.push(error) },
    });
    routers.push(router);
    const replicaPool = new Pool({ connectionString: APP.r1, max: 1 });
    pools.push(replicaPool);

    const token = await router.issueToken(replicaPool);
    expect(new TokenCodec([SECRET]).decode(token)).toMatchObject({ kind: 'unresolved' });
    expect(unresolved.length).toBe(1);
    const decision = await router.route(token);
    expect(decision.role).toBe(NODE_ROLE.primary);
    expect(decision.reason).toBe(ROUTE_REASON.tokenUnresolved);
  });
});

describe('токен до COMMIT', () => {
  it('токен, запрошенный внутри незакоммиченной транзакции с записью, — «только мастер»', async () => {
    const unresolved: Error[] = [];
    const router = new ReplicaRouter<string>({
      primary: { name: 'primary', connection: APP.primary, target: 'primary' },
      replicas: [{ name: 'r1', connection: APP.r1, target: 'r1' }],
      secrets: [SECRET],
      observer: { tokenUnresolved: ({ error }) => unresolved.push(error) },
    });
    routers.push(router);
    const primaryPool = new Pool({ connectionString: APP.primary, max: 1 });
    pools.push(primaryPool);
    const client = await primaryPool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`INSERT INTO ${table} (id) VALUES (900)`);
      const early = await router.issueToken(client);
      await client.query('COMMIT');
      const late = await router.issueToken(client);

      expect(new TokenCodec([SECRET]).decode(early)).toMatchObject({ kind: 'unresolved' });
      expect(unresolved.map((error) => error.message)).toEqual([
        'транзакция с записью ещё не закоммичена: позиция её коммита неизвестна',
      ]);
      expect(new TokenCodec([SECRET]).decode(late).kind).toBe('position');
    } finally {
      client.release();
    }
  });
});

describe('испорченный и чужой токен — мастер', () => {
  const route = async (token: string) => {
    const router = makeRouter([
      { name: 'r1', connection: APP.r1 },
      { name: 'r2', connection: APP.r2 },
    ]);
    nextId += 1;
    await writeReplayed(nextId, [env.replica1, env.replica2]);
    return router.route(token);
  };

  it.each([
    ['мусор', 'garbage'],
    [
      'обрезан',
      `${new TokenCodec([SECRET]).encode({ systemId: '1', timeline: 1, lsn: 0n }, ISSUED_AT).slice(0, -3)}`,
    ],
    [
      'подписан чужим ключом',
      new TokenCodec(['другой-ключ-подписи-0123456789abcdef']).encode(
        { systemId: '1', timeline: 1, lsn: 0n },
        ISSUED_AT,
      ),
    ],
  ])('%s — token-invalid', async (_label, token) => {
    const decision = await route(token);
    expect(decision.role).toBe(NODE_ROLE.primary);
    expect(decision.reason).toBe(ROUTE_REASON.tokenInvalid);
  });

  it('подписан верно, но другим кластером (system identifier) — token-foreign, каждая реплика other-cluster', async () => {
    const decision = await route(
      new TokenCodec([SECRET]).encode({ systemId: '1', timeline: 1, lsn: 0n }, ISSUED_AT),
    );
    expect(decision.role).toBe(NODE_ROLE.primary);
    expect(decision.reason).toBe(ROUTE_REASON.tokenForeign);
    expect(decision.excluded.map((entry) => entry.reason)).toEqual([
      EXCLUSION_REASON.otherCluster,
      EXCLUSION_REASON.otherCluster,
    ]);
  });

  it('позиция «из будущего» относительно всех узлов — мастер с этой причиной, не «реплика догнала»', async () => {
    const [row] = await adminQuery<{ id: string }>(
      env.primary,
      'SELECT system_identifier::text AS id FROM pg_control_system()',
    );
    const future = (await insertLsn(env.primary)) + parseLsn('1/0');
    const decision = await route(
      new TokenCodec([SECRET]).encode({ systemId: row?.id ?? '', timeline: 1, lsn: future }, ISSUED_AT),
    );
    expect(decision.role).toBe(NODE_ROLE.primary);
    expect(decision.reason).toBe(ROUTE_REASON.tokenAheadOfPrimary);
    expect(decision.excluded.map((entry) => entry.reason)).toEqual([
      EXCLUSION_REASON.behind,
      EXCLUSION_REASON.behind,
    ]);
  });
});
