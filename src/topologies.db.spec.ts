import { Pool } from 'pg';

import { EXCLUSION_REASON } from './constants/exclusion-reason.constant';
import { NODE_ROLE } from './constants/node-role.constant';
import { ROUTE_REASON } from './constants/route-reason.constant';
import { ReplicaRouter } from './replica-router';
import { adminQuery } from './testing/admin-query';
import { asRole } from './testing/as-role';
import { createSharedTable } from './testing/create-shared-table';
import { replicationEnv } from './testing/replication-env';
import { SPEC_SECRET } from './testing/spec-secret';
import { waitForReplay } from './testing/wait-for-replay';
import { waitForReplicas } from './testing/wait-for-replicas';
import { TokenCodec } from './token-codec';

/**
 * Топологии кроме «реплика мастера»: каскадная реплика (реплика реплики) и
 * реплика только через архив WAL. Каскадная видит линию времени своим
 * приёмником WAL и годится; архивная приёмника не имеет — линия времени не
 * доказана, и она исключается, даже воспроизведя позицию токена.
 */
jest.setTimeout(60_000);

const env = replicationEnv();
const APP = {
  primary: asRole(env.primary, 'app'),
  cascade: asRole(env.cascade, 'app'),
  archive: asRole(env.archive, 'app'),
};

let table: string;
const routers: ReplicaRouter<string>[] = [];
const pools: Pool[] = [];

const makeRouter = (replicas: readonly { name: string; connection: string }[]): ReplicaRouter<string> => {
  const router = new ReplicaRouter<string>({
    primary: { name: 'primary', connection: APP.primary, target: 'primary' },
    replicas: replicas.map((replica) => ({ ...replica, target: replica.name })),
    secrets: [SPEC_SECRET],
  });
  routers.push(router);
  return router;
};

const writeAndToken = async (router: ReplicaRouter<string>, id: number): Promise<string> => {
  const primary = new Pool({ connectionString: APP.primary, max: 1 });
  primary.on('error', () => undefined);
  pools.push(primary);
  const client = await primary.connect();
  try {
    await client.query('BEGIN');
    await client.query(`INSERT INTO ${table} (id) VALUES ($1)`, [id]);
    return await router.commitAndIssueToken(client);
  } finally {
    client.release();
  }
};

const lsnOf = (token: string): bigint => {
  const decoded = new TokenCodec([SPEC_SECRET]).decode(token);
  if (decoded.kind !== 'position') {
    throw new Error(`токен без позиции: ${decoded.kind}`);
  }
  return decoded.position.lsn;
};

beforeAll(async () => {
  table = await createSharedTable(env.primary, [env.replica1, env.cascade]);
});

afterEach(async () => {
  await Promise.all(routers.splice(0).map((router) => router.close()));
  await Promise.all(pools.splice(0).map((created) => created.end()));
});

describe('каскадная реплика и реплика через архив WAL', () => {
  it('каскадная реплика воспроизвела токен — чтение на неё, и запись там видна', async () => {
    const router = makeRouter([{ name: 'cascade', connection: APP.cascade }]);
    const token = await writeAndToken(router, 1);
    await waitForReplicas(env.primary, [env.replica1, env.cascade]);

    const decision = await router.route(token);
    expect(decision).toMatchObject({
      role: NODE_ROLE.replica,
      node: 'cascade',
      reason: ROUTE_REASON.replicaCaughtUp,
    });
    const [row] = await adminQuery<{ found: boolean }>(
      env.cascade,
      `SELECT EXISTS (SELECT 1 FROM ${table} WHERE id = 1) AS found`,
    );
    expect(row?.found).toBe(true);
    expect((await router.route()).node).toBe('cascade');
  });

  it('реплика только через архив воспроизвела позицию токена — всё равно исключена: линия времени без приёмника WAL не доказана', async () => {
    const router = makeRouter([{ name: 'archive', connection: APP.archive }]);
    const token = await writeAndToken(router, 2);
    // Сегмент с записью уходит в архив только после переключения.
    await adminQuery(env.primary, 'SELECT pg_switch_wal()');
    await waitForReplay(env.archive, lsnOf(token), 30_000);

    for (const decision of [await router.route(token), await router.route()]) {
      expect(decision.role).toBe(NODE_ROLE.primary);
      expect(decision.excluded).toEqual([{ node: 'archive', reason: EXCLUSION_REASON.timelineUnknown }]);
    }
  });
});
