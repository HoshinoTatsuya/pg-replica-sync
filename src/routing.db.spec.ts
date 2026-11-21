import { performance } from 'node:perf_hooks';
import { setTimeout as sleep } from 'node:timers/promises';

import { FaultProxy } from '@hoshinotatsuya/fault-kit/tcp';
import { Pool } from 'pg';

import { EXCLUSION_REASON } from './constants/exclusion-reason.constant';
import { NODE_ROLE } from './constants/node-role.constant';
import { REPLICA_SYNC_DEFAULTS } from './constants/replica-sync-defaults.constant';
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
 * Цена и потолки маршрутизации на настоящей репликации: частота зондов при
 * отставании, объединение одновременных зондов, причина ухода на мастер для
 * свежего токена, потолок времени `route()`, срок жизни токена, который ни одна
 * реплика выполнить не может.
 */
jest.setTimeout(60_000);

const env = replicationEnv();
const APP = {
  primary: asRole(env.primary, 'app'),
  r1: asRole(env.replica1, 'app'),
  r2: asRole(env.replica2, 'app'),
};
const AT = 1_700_000_000_000;

let table: string;
let now = 0;
let nextId = 0;
const routers: ReplicaRouter<string>[] = [];
const pools: Pool[] = [];
const proxies: FaultProxy[] = [];

const pool = (url: string): Pool => {
  const created = new Pool({ connectionString: url, max: 2 });
  created.on('error', () => undefined);
  pools.push(created);
  return created;
};

const makeRouter = (options: Partial<ReplicaRouterOptions<string>> = {}): ReplicaRouter<string> => {
  const router = new ReplicaRouter<string>({
    primary: { name: 'primary', connection: APP.primary, target: 'primary' },
    replicas: [
      { name: 'r1', connection: APP.r1, target: 'r1' },
      { name: 'r2', connection: APP.r2, target: 'r2' },
    ],
    secrets: [SPEC_SECRET],
    clock: () => now,
    ...options,
  });
  routers.push(router);
  return router;
};

/** Запись и токен на соединении записи: COMMIT и позиция — одним вызовом. */
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

const probeCounter = () => {
  const counts = new Map<string, number>();
  return {
    counts,
    probed: (event: { node: string }) => counts.set(event.node, (counts.get(event.node) ?? 0) + 1),
  };
};

beforeAll(async () => {
  table = await createSharedTable(env.primary, [env.replica1, env.replica2]);
});

afterEach(async () => {
  for (const proxy of proxies.splice(0)) {
    proxy.thaw();
    proxy.latency(0);
    await proxy.close();
  }
  await setApplyDelay(env.replica1, null);
  await setApplyDelay(env.replica2, null);
  await waitForReplicas(env.primary, [env.replica1, env.replica2]);
  await Promise.all(routers.splice(0).map((router) => router.close()));
  await Promise.all(pools.splice(0).map((created) => created.end()));
});

describe('частота зондов', () => {
  it.each([
    ['часы читателя совпадают с часами выдавшего', 0],
    ['часы читателя на 5 с позади', -5_000],
    ['часы читателя на 5 с впереди', 5_000],
  ])(
    'токен впереди отставших реплик: новый зонд узла не чаще minProbeIntervalMs при любом числе чтений (%s)',
    async (_label, skew) => {
      await setApplyDelay(env.replica1, '1h');
      await setApplyDelay(env.replica2, '1h');
      const writer = makeRouter({ wallClock: () => AT });
      const { token } = await writeAndToken(writer);
      const limited = probeCounter();
      const reader = makeRouter({
        minProbeIntervalMs: 600_000,
        wallClock: () => AT + skew,
        observer: { probed: limited.probed },
      });

      for (let i = 0; i < 200; i += 1) {
        const decision = await reader.route(token);
        expect(decision.role).toBe(NODE_ROLE.primary);
      }
      expect(Object.fromEntries(limited.counts)).toEqual({ r1: 1, r2: 1, primary: 1 });

      // Контроль: без потолка частоты каждое из тех же чтений зондирует обе реплики —
      // ограничивает именно потолок, а не кэш.
      const unlimited = probeCounter();
      const control = makeRouter({
        minProbeIntervalMs: 0,
        wallClock: () => AT + skew,
        observer: { probed: unlimited.probed },
      });
      for (let i = 0; i < 20; i += 1) {
        await control.route(token);
      }
      expect(unlimited.counts.get('r1')).toBe(20);
      expect(unlimited.counts.get('r2')).toBe(20);
    },
  );

  it.each([
    ['часы читателя совпадают с часами выдавшего', 0],
    ['часы читателя на 5 с впереди', 5_000],
  ])(
    'чтение сразу после СВОЕЙ записи: зонд, снятый до первой встречи с токеном, не используется даже в потолке частоты (%s)',
    async (_label, skew) => {
      await setApplyDelay(env.replica1, '1h');
      await setApplyDelay(env.replica2, '1h');
      const writer = makeRouter({ wallClock: () => AT });
      const counter = probeCounter();
      const reader = makeRouter({
        minProbeIntervalMs: 600_000,
        wallClock: () => AT + skew,
        observer: { probed: counter.probed },
      });
      let last = '';
      for (let i = 0; i < 10; i += 1) {
        last = (await writeAndToken(writer)).token;
        expect((await reader.route(last)).role).toBe(NODE_ROLE.primary);
      }
      // Каждый новый токен — свежий зонд каждой реплики на каждое чтение.
      expect(counter.counts.get('r1')).toBe(10);
      expect(counter.counts.get('r2')).toBe(10);
      // Тот же токен снова — зонды уже после первой встречи с ним: новых нет.
      for (let i = 0; i < 10; i += 1) {
        await reader.route(last);
      }
      expect(counter.counts.get('r1')).toBe(10);
      expect(counter.counts.get('r2')).toBe(10);
    },
  );

  it('часы сдвигаются самой работой (каждый вызов +1 с) и у писателя с читателем расходятся: потолок частоты держится, токен своей линии и «без позиции» не стареют', async () => {
    await setApplyDelay(env.replica1, '1h');
    await setApplyDelay(env.replica2, '1h');
    let writerWall = AT;
    let readerWall = AT - 30_000;
    const writer = makeRouter({ wallClock: () => (writerWall += 1_000) });
    const { token } = await writeAndToken(writer);
    const unresolved = await writer.issueToken(pool(APP.r1));
    const counter = probeCounter();
    const reader = makeRouter({
      minProbeIntervalMs: 600_000,
      tokenTtlMs: 60_000,
      wallClock: () => (readerWall += 1_000),
      observer: { probed: counter.probed },
    });
    const reasons = new Set<string>();
    for (let i = 0; i < 200; i += 1) {
      reasons.add((await reader.route(token)).reason);
      reasons.add((await reader.route(unresolved)).reason);
    }
    // Часы читателя ушли на 171 с вперёд (вызов при создании — проверка часов — и на
    // каждое чтение с позицией): возраст токена давно больше tokenTtlMs.
    expect(readerWall - AT).toBe(171_000);
    expect([...reasons].sort()).toEqual(
      [ROUTE_REASON.noReplicaEligible, ROUTE_REASON.tokenUnresolved].sort(),
    );
    expect(reader.stats().expiredTokens).toBe(0);
    expect(counter.counts.get('r1')).toBe(1);
    expect(counter.counts.get('r2')).toBe(1);
  });

  it('одновременные чтения ждут ОДИН зонд узла', async () => {
    await setApplyDelay(env.replica1, '1h');
    await setApplyDelay(env.replica2, '1h');
    const counter = probeCounter();
    const router = makeRouter({ minProbeIntervalMs: 0, observer: { probed: counter.probed } });
    const { token } = await writeAndToken(router);

    const decisions = await Promise.all(Array.from({ length: 20 }, () => router.route(token)));
    expect(decisions.map((decision) => decision.role)).toEqual(
      Array.from({ length: 20 }, () => NODE_ROLE.primary),
    );
    expect(Object.fromEntries(counter.counts)).toEqual({ r1: 1, r2: 1, primary: 1 });
  });
});

describe('причина ухода на мастер', () => {
  it.each([
    ['потолок частоты по умолчанию', {}],
    ['мастер не перезондируется (потолок частоты больше спеки)', { minProbeIntervalMs: 600_000 }],
  ])(
    'свежий законный токен, реплики отстают, кэш мастера старше токена — no-replica-eligible, не «токен впереди мастера» (%s)',
    async (_label, options) => {
      await setApplyDelay(env.replica1, '1h');
      await setApplyDelay(env.replica2, '1h');
      const router = makeRouter(options);
      // Состояние мастера в кэше снято ДО записи (часы кэша стоят: оно не истекает).
      expect((await router.route()).role).toBe(NODE_ROLE.replica);
      const { token } = await writeAndToken(router);

      const decision = await router.route(token);
      expect(decision.role).toBe(NODE_ROLE.primary);
      expect(decision.reason).toBe(ROUTE_REASON.noReplicaEligible);
      expect([...decision.excluded].sort((a, b) => a.node.localeCompare(b.node))).toEqual([
        { node: 'r1', reason: EXCLUSION_REASON.behind },
        { node: 'r2', reason: EXCLUSION_REASON.behind },
      ]);
    },
  );

  it('токен и правда впереди мастера, а в кэше — старое состояние мастера: свежий зонд подтверждает token-ahead-of-primary', async () => {
    // Потолок частоты снят: свежий зонд мастера не зависит от того, сколько прошло с прошлого.
    const router = makeRouter({ wallClock: () => AT, minProbeIntervalMs: 0 });
    expect((await router.route()).role).toBe(NODE_ROLE.replica);
    const [row] = await adminQuery<{ id: string; lsn: string }>(
      env.primary,
      'SELECT system_identifier::text AS id, pg_current_wal_insert_lsn()::text AS lsn FROM pg_control_system()',
    );
    const future = new TokenCodec([SPEC_SECRET]).encode(
      { systemId: row?.id ?? '', timeline: 1, lsn: parseLsn(row?.lsn ?? '') + parseLsn('1/0') },
      AT,
    );
    const decision = await router.route(future);
    expect(decision.role).toBe(NODE_ROLE.primary);
    expect(decision.reason).toBe(ROUTE_REASON.tokenAheadOfPrimary);
  });
});

describe('память о позициях токенов', () => {
  /**
   * `count` позиций позади мастера, но впереди реплик с задержкой применения:
   * первый коммит после включения задержки реплики не применят, и позиции за его
   * концом им недостижимы (прочие записи WAL они воспроизводят без задержки).
   */
  const positionsBehindPrimary = async (count: number): Promise<(offset: number) => string> => {
    await setApplyDelay(env.replica1, '1h');
    await setApplyDelay(env.replica2, '1h');
    await adminQuery(env.primary, "SELECT pg_logical_emit_message(true, 'spec', 'barrier')");
    const [row] = await adminQuery<{ id: string; lsn: string }>(
      env.primary,
      'SELECT system_identifier::text AS id, pg_current_wal_insert_lsn()::text AS lsn FROM pg_control_system()',
    );
    // Мастер уходит вперёд больше, чем на `count` байт: позиции токенов — позади него.
    await adminQuery(
      env.primary,
      `SELECT pg_logical_emit_message(false, 'spec', repeat('x', ${count + 4_096}))`,
    );
    const codec = new TokenCodec([SPEC_SECRET]);
    const base = parseLsn(row?.lsn ?? '');
    return (offset: number) =>
      codec.encode({ systemId: row?.id ?? '', timeline: 1, lsn: base + BigInt(offset % count) }, AT + offset);
  };

  it('2000 разных токенов на 100 позиций по кругу, дважды: по зонду реплики на позицию, а не на чтение', async () => {
    const tokenAt = await positionsBehindPrimary(100);
    const counter = probeCounter();
    const router = makeRouter({
      wallClock: () => AT,
      minProbeIntervalMs: 600_000,
      observer: { probed: counter.probed },
    });
    const reasons = new Set<string>();
    for (let i = 0; i < 4_000; i += 1) {
      reasons.add((await router.route(tokenAt(i % 2_000))).reason);
    }
    expect([...reasons]).toEqual([ROUTE_REASON.noReplicaEligible]);
    // Каждая новая позиция — свежий зонд каждой реплики (снятый раньше о ней ничего
    // не говорит); повторная встреча — кэш. Ключ по строке токена (2000 > памяти)
    // давал бы зонд на каждое чтение.
    expect(counter.counts.get('r1')).toBe(100);
    expect(counter.counts.get('r2')).toBe(100);
  });

  it('LRU: горячая позиция при потоке новых больше POSITION_MEMORY не стоит зондов (вытесненная — один лишний)', async () => {
    const tokenAt = await positionsBehindPrimary(REPLICA_SYNC_DEFAULTS.POSITION_MEMORY * 2 + 2);
    const counter = probeCounter();
    const router = makeRouter({
      wallClock: () => AT,
      minProbeIntervalMs: 600_000,
      observer: { probed: counter.probed },
    });
    const hot = tokenAt(0);
    await router.route(hot);
    const hotProbes: number[] = [];
    for (let i = 1; i <= REPLICA_SYNC_DEFAULTS.POSITION_MEMORY * 2; i += 1) {
      await router.route(tokenAt(i));
      if (i % 100 === 0) {
        const before = counter.counts.get('r1') ?? 0;
        await router.route(hot);
        hotProbes.push((counter.counts.get('r1') ?? 0) - before);
      }
    }
    expect(hotProbes).toEqual(Array.from({ length: hotProbes.length }, () => 0));
    expect(hotProbes.length).toBe(20);
    // Контроль: новая позиция по-прежнему стоит свежего зонда — память не «всё помнит».
    const before = counter.counts.get('r1') ?? 0;
    await router.route(tokenAt(REPLICA_SYNC_DEFAULTS.POSITION_MEMORY * 2 + 1));
    expect((counter.counts.get('r1') ?? 0) - before).toBe(1);
  });
});

describe('часы кэша', () => {
  it('часы по умолчанию (performance.now): кэш живёт stateTtlMs и истекает — следующий route() зондирует снова', async () => {
    const counter = probeCounter();
    const router = new ReplicaRouter<string>({
      primary: { name: 'primary', connection: APP.primary, target: 'primary' },
      replicas: [
        { name: 'r1', connection: APP.r1, target: 'r1' },
        { name: 'r2', connection: APP.r2, target: 'r2' },
      ],
      secrets: [SPEC_SECRET],
      stateTtlMs: 200,
      observer: { probed: counter.probed },
    });
    routers.push(router);
    await router.route();
    await router.route();
    expect(Object.fromEntries(counter.counts)).toEqual({ primary: 1, r1: 1, r2: 1 });
    await sleep(400);
    await router.route();
    expect(Object.fromEntries(counter.counts)).toEqual({ primary: 2, r1: 2, r2: 2 });
  });

  it('часы кэша шагнули назад на час: пауза реплики замечена, а не скрыта вечным кэшем', async () => {
    let back = 0;
    let clockNow = 1_000_000_000;
    const router = makeRouter({
      clock: () => clockNow - back,
      replicas: [{ name: 'r1', connection: APP.r1, target: 'r1' }],
    });
    expect((await router.route()).node).toBe('r1');
    back = 3_600_000;
    await adminQuery(env.replica1, 'SELECT pg_wal_replay_pause()');
    try {
      clockNow += 1;
      const decision = await router.route();
      expect(decision.role).toBe(NODE_ROLE.primary);
      expect(decision.excluded).toEqual([{ node: 'r1', reason: EXCLUSION_REASON.paused }]);
    } finally {
      await adminQuery(env.replica1, 'SELECT pg_wal_replay_resume()');
    }
  });
});

describe('потолок времени route()', () => {
  it('медленная реплика и замёрзший мастер: route() укладывается в waitForCatchUpMs + probeTimeoutMs', async () => {
    const WAIT = 500;
    const PROBE = 1_000;
    await setApplyDelay(env.replica1, '1h');
    const replica = new URL(env.replica1);
    const primary = new URL(env.primary);
    const replicaProxy = await FaultProxy.start({ host: replica.hostname, port: Number(replica.port) });
    const primaryProxy = await FaultProxy.start({ host: primary.hostname, port: Number(primary.port) });
    proxies.push(replicaProxy, primaryProxy);
    const via = (proxy: FaultProxy, url: string): string => {
      const parsed = new URL(url);
      parsed.hostname = '127.0.0.1';
      parsed.port = String(proxy.port);
      return parsed.toString();
    };
    const router = makeRouter({
      primary: { name: 'primary', connection: via(primaryProxy, APP.primary), target: 'primary' },
      replicas: [{ name: 'r1', connection: via(replicaProxy, APP.r1), target: 'r1' }],
      waitForCatchUpMs: WAIT,
      probeTimeoutMs: PROBE,
    });
    // Соединения зондов установлены до сбоя.
    await router.route();
    const { token } = await writeAndToken(router);
    now += 10_000;
    replicaProxy.latency(450);
    primaryProxy.freeze();

    const started = performance.now();
    const decision = await router.route(token);
    const elapsed = performance.now() - started;

    expect(decision.role).toBe(NODE_ROLE.primary);
    // Зонд реплики ≈ 900 мс (450 мс в каждую сторону) — в потолке зонда, но опрос,
    // начатый в ожидании, кончился бы через 1.8 с после начала. Запас 200 мс — на
    // занятую машину; без потолка выходило ≈ 2800 мс (опрос после конца ожидания и
    // зонд замёрзшего мастера сверх него).
    expect(elapsed).toBeLessThan(WAIT + PROBE + 200);
  });
});

describe('срок жизни токена, который после failover ни одна реплика выполнить не может', () => {
  const systemId = async (): Promise<string> => {
    const [row] = await adminQuery<{ id: string }>(
      env.primary,
      'SELECT system_identifier::text AS id FROM pg_control_system()',
    );
    return row?.id ?? '';
  };

  it('«другая линия времени», «другой кластер», «впереди мастера» держат мастер tokenTtlMs, потом — чтение как без токена', async () => {
    let wall = AT;
    // Потолок частоты снят: «впереди мастера» называется по свежему зонду мастера, а не по
    // состоянию, снятому соседним чтением миллисекунду назад.
    const router = makeRouter({ wallClock: () => wall, tokenTtlMs: 60_000, minProbeIntervalMs: 0 });
    const codec = new TokenCodec([SPEC_SECRET]);
    const id = await systemId();
    const [row] = await adminQuery<{ lsn: string }>(
      env.primary,
      'SELECT pg_current_wal_insert_lsn()::text AS lsn',
    );
    const tokens = [
      [codec.encode({ systemId: id, timeline: 99, lsn: 0n }, AT), ROUTE_REASON.tokenOtherTimeline],
      [codec.encode({ systemId: '1', timeline: 1, lsn: 0n }, AT), ROUTE_REASON.tokenForeign],
      [
        codec.encode({ systemId: id, timeline: 1, lsn: parseLsn(row?.lsn ?? '') + parseLsn('1/0') }, AT),
        ROUTE_REASON.tokenAheadOfPrimary,
      ],
    ] as const;

    wall = AT + 60_000;
    for (const [token, reason] of tokens) {
      expect(await router.route(token)).toMatchObject({ role: NODE_ROLE.primary, reason });
    }
    expect(router.stats().expiredTokens).toBe(0);

    wall = AT + 60_001;
    for (const [token] of tokens) {
      expect(await router.route(token)).toMatchObject({
        role: NODE_ROLE.replica,
        reason: ROUTE_REASON.replicaWithinLag,
      });
    }
    expect(router.stats().expiredTokens).toBe(3);
  });

  it('просроченный токен «впереди мастера» истекает и под потолком частоты: один зонд мастера после первой встречи, дальше — кэш', async () => {
    let wall = AT;
    const counter = probeCounter();
    const router = makeRouter({
      wallClock: () => wall,
      minProbeIntervalMs: 600_000,
      observer: { probed: counter.probed },
    });
    // Состояние мастера в кэше (часы кэша стоят) снято ДО первой встречи с токеном:
    // «впереди» по нему не доказано — нужен зонд, начатый после.
    expect((await router.route()).role).toBe(NODE_ROLE.replica);
    expect(counter.counts.get('primary')).toBe(1);
    const [row] = await adminQuery<{ lsn: string }>(
      env.primary,
      'SELECT pg_current_wal_insert_lsn()::text AS lsn',
    );
    const future = new TokenCodec([SPEC_SECRET]).encode(
      { systemId: await systemId(), timeline: 1, lsn: parseLsn(row?.lsn ?? '') + parseLsn('1/0') },
      AT,
    );
    wall = AT + 600_000;
    const decisions = [];
    for (let i = 0; i < 50; i += 1) {
      decisions.push(await router.route(future));
    }
    expect(decisions.map((decision) => decision.reason)).toEqual(
      Array.from({ length: 50 }, () => ROUTE_REASON.replicaWithinLag),
    );
    expect(router.stats().expiredTokens).toBe(50);
    expect(counter.counts.get('primary')).toBe(2);
  });

  it('токен «без позиции» не стареет: мастер и через сколько угодно, даже если реплика в потолке отставания', async () => {
    await setApplyDelay(env.replica1, '1h');
    await setApplyDelay(env.replica2, '1h');
    let wall = AT;
    const router = makeRouter({ wallClock: () => wall, tokenTtlMs: 60_000 });
    const unresolved = await router.issueToken(pool(APP.r1));
    expect(new TokenCodec([SPEC_SECRET]).decode(unresolved)).toEqual({ kind: 'unresolved', issuedAt: AT });
    // Запись, которой нет на репликах (задержка применения), — отставание меньше потолка.
    await writeAndToken(router);
    expect((await router.route()).role).toBe(NODE_ROLE.replica);
    for (const age of [60_001, 3_600_000]) {
      wall = AT + age;
      expect(await router.route(unresolved)).toMatchObject({
        role: NODE_ROLE.primary,
        reason: ROUTE_REASON.tokenUnresolved,
      });
    }
    expect(router.stats().expiredTokens).toBe(0);
  });

  it('просроченный токен своей линии времени по-прежнему проверяется по позиции, а не по отставанию', async () => {
    let wall = AT;
    const router = makeRouter({ wallClock: () => wall, tokenTtlMs: 1_000 });
    await setApplyDelay(env.replica1, '1h');
    await setApplyDelay(env.replica2, '1h');
    const { token } = await writeAndToken(router);
    wall = AT + 600_000;

    // Реплики не воспроизвели запись токена: без токена они годились бы (отставание
    // меньше потолка), с токеном — нет, сколько бы ему ни было.
    const decision = await router.route(token);
    expect(decision.role).toBe(NODE_ROLE.primary);
    expect(decision.reason).toBe(ROUTE_REASON.noReplicaEligible);
    expect(router.stats().expiredTokens).toBe(0);
    const withoutToken = await router.route();
    expect(withoutToken.role).toBe(NODE_ROLE.replica);
  });
});
