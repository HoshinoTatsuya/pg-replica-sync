import { setTimeout as sleep } from 'node:timers/promises';

import { FaultProxy } from '@hoshinotatsuya/fault-kit/tcp';
import { Pool } from 'pg';

import { NODE_ROLE } from './constants/node-role.constant';
import { ROUTE_REASON } from './constants/route-reason.constant';
import { parseLsn } from './parse-lsn';
import { ReplicaRouter } from './replica-router';
import { adminQuery } from './testing/admin-query';
import { asRole } from './testing/as-role';
import { createSharedTable } from './testing/create-shared-table';
import { replicationEnv } from './testing/replication-env';
import { setApplyDelay } from './testing/set-apply-delay';
import { SPEC_SECRET } from './testing/spec-secret';
import { waitForReplicas } from './testing/wait-for-replicas';
import { TokenCodec } from './token-codec';
import type { ReplicaRouterOptions } from './types/replica-router-options.type';

/**
 * Истечение токена — только по ДОКАЗАННОЙ невыполнимости. Законный свежий
 * токен своей линии не истекает ни при сдвиге часов читателя, ни при малом
 * `tokenTtlMs`, ни при кэше мастера, снятом ДО записи (читатель прогрет
 * чтением без токена) — иначе чтение уходило бы как без токена на реплику с
 * задержкой применения, где записи нет. Двойник: токен и правда впереди
 * мастера — истекает, и по зонду мастера, начатому после первой встречи с ним.
 */
jest.setTimeout(90_000);

const env = replicationEnv();
const APP = {
  primary: asRole(env.primary, 'app'),
  r1: asRole(env.replica1, 'app'),
  r2: asRole(env.replica2, 'app'),
};
/** Узел решения → адрес суперпользователя: видна ли запись там, куда ушло чтение. */
const ADMIN_URL: Readonly<Record<string, string>> = {
  primary: env.primary,
  r1: env.replica1,
  r2: env.replica2,
};
const SKEW_MS = 120_000;
const ROUNDS = 20;

let table: string;
let nextId = 0;
let now = 0;
const routers: ReplicaRouter<string>[] = [];
const pools: Pool[] = [];
const proxies: FaultProxy[] = [];

const makeRouter = (options: Partial<ReplicaRouterOptions<string>> = {}): ReplicaRouter<string> => {
  const router = new ReplicaRouter<string>({
    primary: { name: 'primary', connection: APP.primary, target: 'primary' },
    replicas: [
      { name: 'r1', connection: APP.r1, target: 'r1' },
      { name: 'r2', connection: APP.r2, target: 'r2' },
    ],
    secrets: [SPEC_SECRET],
    ...options,
  });
  routers.push(router);
  return router;
};

const writer = (): Pool => {
  const created = new Pool({ connectionString: APP.primary, max: 1 });
  created.on('error', () => undefined);
  pools.push(created);
  return created;
};

const writeAndToken = async (
  router: ReplicaRouter<string>,
  via: Pool,
): Promise<{ id: number; token: string }> => {
  nextId += 1;
  const id = nextId;
  const client = await via.connect();
  try {
    await client.query('BEGIN');
    await client.query(`INSERT INTO ${table} (id) VALUES ($1)`, [id]);
    return { id, token: await router.commitAndIssueToken(client) };
  } finally {
    client.release();
  }
};

const visibleOn = async (node: string, id: number): Promise<boolean> => {
  const url = ADMIN_URL[node];
  if (url === undefined) {
    throw new Error(`неизвестный узел ${node}`);
  }
  return (await adminQuery(url, `SELECT 1 FROM ${table} WHERE id = ${id}`)).length === 1;
};

const futureToken = async (issuedAt: number): Promise<string> => {
  const [row] = await adminQuery<{ id: string; lsn: string }>(
    env.primary,
    'SELECT system_identifier::text AS id, pg_current_wal_insert_lsn()::text AS lsn FROM pg_control_system()',
  );
  return new TokenCodec([SPEC_SECRET]).encode(
    { systemId: row?.id ?? '', timeline: 1, lsn: parseLsn(row?.lsn ?? '') + parseLsn('1/0') },
    issuedAt,
  );
};

beforeAll(async () => {
  table = await createSharedTable(env.primary, [env.replica1, env.replica2]);
});

beforeEach(async () => {
  // Реплики принимают WAL, но применяют коммиты через час: отставание в байтах —
  // в потолке, и чтение без токена на них годится, а записи там нет.
  await setApplyDelay(env.replica1, '1h');
  await setApplyDelay(env.replica2, '1h');
});

afterEach(async () => {
  for (const proxy of proxies.splice(0)) {
    proxy.latency(0);
    await proxy.close();
  }
  await Promise.all(routers.splice(0).map((router) => router.close()));
  await Promise.all(pools.splice(0).map((created) => created.end()));
  await setApplyDelay(env.replica1, null);
  await setApplyDelay(env.replica2, null);
  await waitForReplicas(env.primary, [env.replica1, env.replica2]);
});

describe('законный свежий токен не истекает по кэшу мастера, снятому до записи', () => {
  it.each<[string, Partial<ReplicaRouterOptions<string>>, number]>([
    ['часы совпадают, умолчания (контроль)', {}, 0],
    ['часы читателя на 120 с впереди, умолчания', { wallClock: () => Date.now() + SKEW_MS }, 0],
    ['часы читателя на 120 с позади, умолчания', { wallClock: () => Date.now() - SKEW_MS }, 0],
    [
      'часы читателя на 120 с впереди, minProbeIntervalMs 1000',
      { wallClock: () => Date.now() + SKEW_MS, minProbeIntervalMs: 1_000 },
      0,
    ],
    [
      'часы читателя на 120 с впереди, кэш мастера не стареет и не перезондируется',
      { wallClock: () => Date.now() + SKEW_MS, minProbeIntervalMs: 600_000, clock: () => now },
      0,
    ],
    ['tokenTtlMs 1', { tokenTtlMs: 1 }, 0],
    ['tokenTtlMs 1, minProbeIntervalMs 1000', { tokenTtlMs: 1, minProbeIntervalMs: 1_000 }, 0],
    [
      'tokenTtlMs 200, stateTtlMs 1000, minProbeIntervalMs 1000, чтение через 250 мс',
      { tokenTtlMs: 200, stateTtlMs: 1_000, minProbeIntervalMs: 1_000 },
      250,
    ],
  ])(
    '%s: каждое чтение — мастер, запись видна там, ни одного истечения',
    async (_label, options, pauseMs) => {
      const issuer = makeRouter({ replicas: [] });
      const via = writer();
      const reader = makeRouter(options);
      const decisions: string[] = [];
      const invisible: number[] = [];
      for (let i = 0; i < ROUNDS; i += 1) {
        // Чтение без токена соседнего запроса: состояние мастера в кэше — ДО записи.
        expect((await reader.route()).role).toBe(NODE_ROLE.replica);
        const { id, token } = await writeAndToken(issuer, via);
        if (pauseMs > 0) {
          await sleep(pauseMs);
        }
        const decision = await reader.route(token);
        decisions.push(`${decision.role}:${decision.reason}`);
        if (!(await visibleOn(decision.node, id))) {
          invisible.push(id);
        }
      }
      expect(invisible).toEqual([]);
      expect(new Set(decisions)).toEqual(new Set([`${NODE_ROLE.primary}:${ROUTE_REASON.noReplicaEligible}`]));
      expect(reader.stats().expiredTokens).toBe(0);
    },
  );

  it('зонд мастера, начатый до записи и ещё идущий, не доказывает «впереди мастера»: его дожидаются и зондируют снова', async () => {
    const primary = new URL(env.primary);
    const proxy = await FaultProxy.start({ host: primary.hostname, port: Number(primary.port) });
    proxies.push(proxy);
    const slowPrimary = new URL(APP.primary);
    slowPrimary.hostname = '127.0.0.1';
    slowPrimary.port = String(proxy.port);
    const issuer = makeRouter({ replicas: [] });
    const via = writer();
    const probedPrimary: number[] = [];
    const reader = makeRouter({
      primary: { name: 'primary', connection: slowPrimary.toString(), target: 'primary' },
      wallClock: () => Date.now() + SKEW_MS,
      clock: () => now,
      observer: {
        probed: (event) => {
          if (event.node === 'primary') {
            probedPrimary.push(1);
          }
        },
      },
    });
    // Соединения зондов установлены; дальше каждый кусок к мастеру идёт 150 мс.
    expect((await reader.route()).role).toBe(NODE_ROLE.replica);
    proxy.latency(150);
    now += 10_000;
    const warm = reader.route();
    // Зонд мастера соседнего чтения ушёл ДО записи и ещё идёт.
    await sleep(20);
    const { id, token } = await writeAndToken(issuer, via);
    const decision = await reader.route(token);
    await warm;
    expect(decision).toMatchObject({ role: NODE_ROLE.primary, reason: ROUTE_REASON.noReplicaEligible });
    expect(await visibleOn(decision.node, id)).toBe(true);
    expect(reader.stats().expiredTokens).toBe(0);
    // Первый (прогрев) + идущий до записи + свежий после первой встречи с позицией.
    expect(probedPrimary.length).toBe(3);
  });
});

describe('двойник: токен и правда впереди мастера — истекает', () => {
  it('часы читателя на 120 с впереди, кэш мастера снят раньше: истекает по свежему зонду мастера, одному на позицию', async () => {
    const probedPrimary: number[] = [];
    const reader = makeRouter({
      wallClock: () => Date.now() + SKEW_MS,
      minProbeIntervalMs: 600_000,
      clock: () => now,
      observer: {
        probed: (event) => {
          if (event.node === 'primary') {
            probedPrimary.push(1);
          }
        },
      },
    });
    expect((await reader.route()).role).toBe(NODE_ROLE.replica);
    expect(probedPrimary.length).toBe(1);
    const future = await futureToken(Date.now());
    const decisions = [];
    for (let i = 0; i < 20; i += 1) {
      decisions.push(await reader.route(future));
    }
    expect(decisions.map((decision) => decision.reason)).toEqual(
      Array.from({ length: 20 }, () => ROUTE_REASON.replicaWithinLag),
    );
    expect(reader.stats().expiredTokens).toBe(20);
    // Кэш мастера снят до первой встречи с позицией — один свежий зонд, дальше кэш.
    expect(probedPrimary.length).toBe(2);
  });

  it('зонд мастера, начатый до первой встречи и ещё идущий: дождались — и истечение тем же чтением, по следующему зонду', async () => {
    const primary = new URL(env.primary);
    const proxy = await FaultProxy.start({ host: primary.hostname, port: Number(primary.port) });
    proxies.push(proxy);
    const slowPrimary = new URL(APP.primary);
    slowPrimary.hostname = '127.0.0.1';
    slowPrimary.port = String(proxy.port);
    const reader = makeRouter({
      primary: { name: 'primary', connection: slowPrimary.toString(), target: 'primary' },
      wallClock: () => Date.now() + SKEW_MS,
      clock: () => now,
    });
    expect((await reader.route()).role).toBe(NODE_ROLE.replica);
    const future = await futureToken(Date.now());
    proxy.latency(150);
    now += 10_000;
    const warm = reader.route();
    await sleep(20);
    const decision = await reader.route(future);
    await warm;
    expect(decision.reason).toBe(ROUTE_REASON.replicaWithinLag);
    expect(reader.stats().expiredTokens).toBe(1);
  });

  it('другая линия времени, просрочен, кэш мастера снят до первой встречи и «не впереди»: доказательство добывается зондом — истекает тем же чтением', async () => {
    const probedPrimary: number[] = [];
    const reader = makeRouter({
      minProbeIntervalMs: 600_000,
      clock: () => now,
      observer: {
        probed: (event) => {
          if (event.node === 'primary') {
            probedPrimary.push(1);
          }
        },
      },
    });
    expect((await reader.route()).role).toBe(NODE_ROLE.replica);
    const [row] = await adminQuery<{ id: string }>(
      env.primary,
      'SELECT system_identifier::text AS id FROM pg_control_system()',
    );
    // Позиция 0 — «позади» любого состояния мастера: кэш сам по себе зонда не просит.
    const otherTimeline = new TokenCodec([SPEC_SECRET]).encode(
      { systemId: row?.id ?? '', timeline: 99, lsn: 0n },
      Date.now() - 3_600_000,
    );
    const decision = await reader.route(otherTimeline);
    expect(decision.reason).toBe(ROUTE_REASON.replicaWithinLag);
    expect(reader.stats().expiredTokens).toBe(1);
    expect(probedPrimary.length).toBe(2);
  });

  it('тот же токен без сдвига часов, моложе tokenTtlMs: мастер с причиной token-ahead-of-primary, не истекает', async () => {
    const reader = makeRouter({ clock: () => now, minProbeIntervalMs: 600_000 });
    expect((await reader.route()).role).toBe(NODE_ROLE.replica);
    const decision = await reader.route(await futureToken(Date.now()));
    expect(decision).toMatchObject({ role: NODE_ROLE.primary, reason: ROUTE_REASON.tokenAheadOfPrimary });
    expect(reader.stats().expiredTokens).toBe(0);
  });
});
