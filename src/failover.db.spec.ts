import { Pool } from 'pg';

import { EXCLUSION_REASON } from './constants/exclusion-reason.constant';
import { NODE_ROLE } from './constants/node-role.constant';
import { ROUTE_REASON } from './constants/route-reason.constant';
import { ReplicaRouter } from './replica-router';
import { adminQuery } from './testing/admin-query';
import { asRole } from './testing/as-role';
import { createSharedTable } from './testing/create-shared-table';
import { replayLsn } from './testing/replay-lsn';
import { replicationEnv } from './testing/replication-env';
import { SPEC_SECRET } from './testing/spec-secret';
import { waitForReplicas } from './testing/wait-for-replicas';
import { TokenCodec } from './token-codec';

/**
 * Промоция на настоящей репликации: третья реплика (расходная) становится
 * мастером новой линии времени (`pg_promote`), первая продолжает следовать за
 * исходным мастером. Спеки идут по порядку: вторая опирается на промоцию из первой.
 *
 * Повторный прогон на ТОЙ ЖЕ топологии (своя топология, мутационный прогон):
 * третья реплика уже мастер линии 2, а вернуть её в реплики SQL не умеет. Тогда
 * первая спека вместо «до промоции r3 годится» утверждает это известное
 * состояние (не в recovery, линия 2), а дальнейшие утверждения те же: прогон
 * зелёный на исправном коде и при повторе, а не красный на любом коде.
 */
jest.setTimeout(90_000);

const SECRET = SPEC_SECRET;
const env = replicationEnv();
const APP = {
  primary: asRole(env.primary, 'app'),
  r1: asRole(env.replica1, 'app'),
  r3: asRole(env.replica3, 'app'),
};

let table: string;
let now = 0;
/** Третья реплика ещё реплика (первый прогон на топологии), а не мастер от прошлого прогона. */
let replica3Fresh = false;
const routers: ReplicaRouter<string>[] = [];
const pools: Pool[] = [];

/** Пул узла под ролью приложения: токен после COMMIT, который уже вернулся. */
const executor = (url: string): Pool => {
  const created = new Pool({ connectionString: url, max: 1 });
  created.on('error', () => undefined);
  pools.push(created);
  return created;
};

const makeRouter = (
  primary: { name: string; connection: string },
  replicas: readonly { name: string; connection: string }[],
): ReplicaRouter<string> => {
  const router = new ReplicaRouter<string>({
    primary: { ...primary, target: primary.name },
    replicas: replicas.map((replica) => ({ ...replica, target: replica.name })),
    secrets: [SECRET],
    clock: () => now,
  });
  routers.push(router);
  return router;
};

const positionOf = (token: string) => {
  const decoded = new TokenCodec([SECRET]).decode(token);
  if (decoded.kind !== 'position') {
    throw new Error(`токен без позиции: ${decoded.kind}`);
  }
  return decoded.position;
};

beforeAll(async () => {
  const [state] = await adminQuery<{ recovery: boolean }>(
    env.replica3,
    'SELECT pg_is_in_recovery() AS recovery',
  );
  replica3Fresh = state?.recovery === true;
  table = await createSharedTable(env.primary, replica3Fresh ? [env.replica1, env.replica3] : [env.replica1]);
});

afterAll(async () => {
  await Promise.all(routers.splice(0).map((router) => router.close()));
  await Promise.all(pools.splice(0).map((created) => created.end()));
});

describe('failover: реплика стала мастером', () => {
  it('pg_promote — узел перестаёт считаться репликой (promoted) и с токеном, и без', async () => {
    const router = makeRouter({ name: 'primary', connection: APP.primary }, [
      { name: 'r1', connection: APP.r1 },
      { name: 'r3', connection: APP.r3 },
    ]);
    await adminQuery(env.primary, `INSERT INTO ${table} (id) VALUES (1)`);
    const token = await router.issueToken(executor(APP.primary));
    if (replica3Fresh) {
      await waitForReplicas(env.primary, [env.replica1, env.replica3]);
      const before = [await router.route(token), await router.route(token)];
      expect(before.map((decision) => decision.node).sort()).toEqual(['r1', 'r3']);
      const [promoted] = await adminQuery<{ ok: boolean }>(env.replica3, 'SELECT pg_promote(true, 60) AS ok');
      expect(promoted?.ok).toBe(true);
    } else {
      // Повторный прогон: r3 промотирована прошлым — утверждается это состояние.
      const [state] = await adminQuery<{ recovery: boolean; tli: string }>(
        env.replica3,
        'SELECT pg_is_in_recovery() AS recovery, substr(pg_walfile_name(pg_current_wal_insert_lsn()), 1, 8) AS tli',
      );
      expect(state).toEqual({ recovery: false, tli: '00000002' });
      await waitForReplicas(env.primary, [env.replica1]);
    }
    now += 10_000;

    for (const decision of [await router.route(token), await router.route(token), await router.route()]) {
      expect(decision.node).toBe('r1');
      expect(decision.excluded).toEqual([{ node: 'r3', reason: EXCLUSION_REASON.promoted }]);
    }
  });

  it('токен новой линии времени: реплика старой линии с БОЛЬШЕЙ позицией — не «догнала», а мастер', async () => {
    // Новый мастер (r3, линия 2) — запись и токен.
    const promotedRouter = makeRouter({ name: 'r3', connection: APP.r3 }, [
      { name: 'r1', connection: APP.r1 },
    ]);
    // Своя таблица на новом мастере: при повторном прогоне таблица спеки создана после
    // промоции и до r3 не доходит.
    const tl2Table = await createSharedTable(env.replica3, []);
    await adminQuery(env.replica3, `INSERT INTO ${tl2Table} (id) VALUES (2)`);
    const tokenTl2 = await promotedRouter.issueToken(executor(APP.r3));
    const position = positionOf(tokenTl2);
    expect(position.timeline).toBe(2);

    // Старая линия уходит дальше по номеру: r1 воспроизводит позицию БОЛЬШЕ позиции токена.
    // Переключение сегмента уводит позицию старой линии к границе следующих 16 МБ.
    await adminQuery(env.primary, `INSERT INTO ${table} (id) VALUES (1000)`);
    for (let i = 0; i < 4 && (await replayLsn(env.replica1)) <= position.lsn; i += 1) {
      await adminQuery(env.primary, 'SELECT pg_switch_wal()');
      await adminQuery(env.primary, "SELECT pg_logical_emit_message(true, 'spec', 'after-switch')");
      await waitForReplicas(env.primary, [env.replica1]);
    }
    expect((await replayLsn(env.replica1)) > position.lsn).toBe(true);

    // Маршрутизатор старого мастера: токен с линии 2 — мастер, r1 — другая линия времени.
    const oldRouter = makeRouter({ name: 'primary', connection: APP.primary }, [
      { name: 'r1', connection: APP.r1 },
    ]);
    const decision = await oldRouter.route(tokenTl2);
    expect(decision.role).toBe(NODE_ROLE.primary);
    expect(decision.reason).toBe(ROUTE_REASON.tokenOtherTimeline);
    expect(decision.excluded).toEqual([{ node: 'r1', reason: EXCLUSION_REASON.timelineMismatch }]);

    // Маршрутизатор нового мастера: r1 (линия 1) не годится и для чтения без токена.
    const noToken = await promotedRouter.route();
    expect(noToken.role).toBe(NODE_ROLE.primary);
    expect(noToken.excluded).toEqual([{ node: 'r1', reason: EXCLUSION_REASON.timelineMismatch }]);
    // Токен старой линии: r1 следует за старым мастером и запись этой линии видит —
    // читать её с r1 корректно, даже если маршрутизатор настроен на новый мастер.
    const oldToken = await oldRouter.issueToken(executor(APP.primary));
    await waitForReplicas(env.primary, [env.replica1]);
    const legacy = await promotedRouter.route(oldToken);
    expect(legacy.node).toBe('r1');
    expect(legacy.reason).toBe(ROUTE_REASON.replicaCaughtUp);
  });
});
