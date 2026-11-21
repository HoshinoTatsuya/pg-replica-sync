import { EXCLUSION_REASON } from './constants/exclusion-reason.constant';
import { NODE_ROLE } from './constants/node-role.constant';
import { ROUTE_REASON } from './constants/route-reason.constant';
import { ReplicaRouter } from './replica-router';
import { adminQuery } from './testing/admin-query';
import { asRole } from './testing/as-role';
import { closedPort } from './testing/closed-port';
import { createSharedTable } from './testing/create-shared-table';
import { replicationEnv } from './testing/replication-env';
import { setApplyDelay } from './testing/set-apply-delay';
import { SPEC_SECRET } from './testing/spec-secret';
import { waitForReplicas } from './testing/wait-for-replicas';

/**
 * Чтение без токена: реплика, только если её отставание от позиции вставки
 * мастера в потолке. Отставание — настоящее: задержка применения коммитов на
 * обеих репликах и переключение WAL-сегмента на мастере (+16 МБ позиции).
 */
jest.setTimeout(60_000);

const SECRET = SPEC_SECRET;
const MAX_LAG = 64 * 1024;
const TTL = 250;
const env = replicationEnv();
const APP = {
  primary: asRole(env.primary, 'app'),
  r1: asRole(env.replica1, 'app'),
  r2: asRole(env.replica2, 'app'),
};

let table: string;
let now = 0;
const routers: ReplicaRouter<string>[] = [];

const makeRouter = (primaryConnection = APP.primary): ReplicaRouter<string> => {
  const router = new ReplicaRouter<string>({
    primary: { name: 'primary', connection: primaryConnection, target: 'primary' },
    replicas: [
      { name: 'r1', connection: APP.r1, target: 'r1' },
      { name: 'r2', connection: APP.r2, target: 'r2' },
    ],
    secrets: [SECRET],
    maxLagBytes: MAX_LAG,
    stateTtlMs: TTL,
    clock: () => now,
  });
  routers.push(router);
  return router;
};

beforeAll(async () => {
  table = await createSharedTable(env.primary, [env.replica1, env.replica2]);
});

afterEach(async () => {
  await setApplyDelay(env.replica1, null);
  await setApplyDelay(env.replica2, null);
  await waitForReplicas(env.primary, [env.replica1, env.replica2]);
  await Promise.all(routers.splice(0).map((router) => router.close()));
});

describe('чтение без токена: потолок отставания', () => {
  it('реплики догнали — реплика; отстали больше потолка — мастер, но только после потолка кэша', async () => {
    const router = makeRouter();
    const fresh = await router.route();
    expect(fresh.role).toBe(NODE_ROLE.replica);
    expect(fresh.reason).toBe(ROUTE_REASON.replicaWithinLag);
    const probesBefore = router.stats().probes.ok;
    expect(probesBefore).toBe(3);

    await setApplyDelay(env.replica1, '1h');
    await setApplyDelay(env.replica2, '1h');
    await adminQuery(env.primary, `INSERT INTO ${table} (id) VALUES (1)`);
    await adminQuery(env.primary, 'SELECT pg_switch_wal()');

    // В пределах потолка кэша решение — по снятому состоянию: зондов нет.
    const cached = await router.route();
    expect(cached.role).toBe(NODE_ROLE.replica);
    expect(router.stats().probes.ok).toBe(probesBefore);

    now += TTL;
    const stale = await router.route();
    expect(router.stats().probes.ok).toBe(probesBefore + 3);
    expect(stale.role).toBe(NODE_ROLE.primary);
    expect(stale.reason).toBe(ROUTE_REASON.noReplicaEligible);
    expect([...stale.excluded].sort((a, b) => a.node.localeCompare(b.node))).toEqual([
      { node: 'r1', reason: EXCLUSION_REASON.lagExceeded },
      { node: 'r2', reason: EXCLUSION_REASON.lagExceeded },
    ]);
    const lag = router.stats().lagBytes;
    expect(Object.keys(lag).sort()).toEqual(['r1', 'r2']);
    for (const value of Object.values(lag)) {
      expect(typeof value).toBe('number');
      expect(value).toBeGreaterThan(MAX_LAG);
    }
    // Счётчики сериализуются как есть (прежде bigint ронял JSON.stringify).
    expect(JSON.parse(JSON.stringify(router.stats()))).toEqual(router.stats());
  });

  it('одна реплика отстала — без токена каждое чтение на другую', async () => {
    const router = makeRouter();
    await setApplyDelay(env.replica2, '1h');
    await adminQuery(env.primary, `INSERT INTO ${table} (id) VALUES (2)`);
    await adminQuery(env.primary, 'SELECT pg_switch_wal()');
    await waitForReplicas(env.primary, [env.replica1]);

    const nodes = [];
    for (let i = 0; i < 6; i += 1) {
      nodes.push((await router.route()).node);
      now += TTL;
    }
    expect(nodes).toEqual(['r1', 'r1', 'r1', 'r1', 'r1', 'r1']);
  });

  it('позицию мастера определить не смогли — мастер, а не «реплика без потолка»', async () => {
    const router = makeRouter(`postgres://app:app@127.0.0.1:${await closedPort()}/postgres`);
    const decision = await router.route();
    expect(decision.role).toBe(NODE_ROLE.primary);
    expect(decision.reason).toBe(ROUTE_REASON.primaryStateUnknown);
    expect(router.stats().probes.failed).toBe(1);
  });
});
