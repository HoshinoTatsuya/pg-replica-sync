import { Pool } from 'pg';

import { NODE_ROLE } from './constants/node-role.constant';
import { parseLsn } from './parse-lsn';
import { ReplicaRouter } from './replica-router';
import { adminQuery } from './testing/admin-query';
import { asRole } from './testing/as-role';
import { createSharedTable } from './testing/create-shared-table';
import { replicationEnv } from './testing/replication-env';
import { SPEC_SECRET } from './testing/spec-secret';
import { waitForReplay } from './testing/wait-for-replay';
import { waitForReplicas } from './testing/wait-for-replicas';
import { TokenCodec } from './token-codec';
import { tokenLsn } from './token-lsn';
import { TransactionNotCommittedError } from './transaction-not-committed.error';
import { TransactionNotOpenError } from './transaction-not-open.error';

/**
 * Позиция токена на настоящем мастере: не меньше конца COMMIT и при
 * `synchronous_commit = off`; COMMIT и токен одним вызовом; токен на
 * простаивающем мастере сразу после переключения сегмента реплика проходит без
 * ожидания чужой записи WAL.
 */
jest.setTimeout(60_000);

const env = replicationEnv();
const APP = { primary: asRole(env.primary, 'app'), r1: asRole(env.replica1, 'app') };
const LAYOUT = { maxAlign: 8, blockSize: 8192, segmentSize: 16 * 1024 * 1024 };

let table: string;
const routers: ReplicaRouter<string>[] = [];
const pools: Pool[] = [];

const makeRouter = (): ReplicaRouter<string> => {
  const router = new ReplicaRouter<string>({
    primary: { name: 'primary', connection: APP.primary, target: 'primary' },
    replicas: [{ name: 'r1', connection: APP.r1, target: 'r1' }],
    secrets: [SPEC_SECRET],
  });
  routers.push(router);
  return router;
};

const pool = (): Pool => {
  const created = new Pool({ connectionString: APP.primary, max: 1 });
  created.on('error', () => undefined);
  pools.push(created);
  return created;
};

const lsnOf = (token: string): bigint => {
  const decoded = new TokenCodec([SPEC_SECRET]).decode(token);
  if (decoded.kind !== 'position') {
    throw new Error(`токен без позиции: ${decoded.kind}`);
  }
  return decoded.position.lsn;
};

beforeAll(async () => {
  table = await createSharedTable(env.primary, [env.replica1]);
});

afterEach(async () => {
  await Promise.all(routers.splice(0).map((router) => router.close()));
  await Promise.all(pools.splice(0).map((created) => created.end()));
});

describe('позиция токена', () => {
  it('synchronous_commit = off: каждый токен не меньше позиции вставки сразу после COMMIT (а значит, конца COMMIT)', async () => {
    const router = makeRouter();
    const client = await pool().connect();
    const below: string[] = [];
    try {
      await client.query('SET synchronous_commit = off');
      for (let i = 0; i < 50; i += 1) {
        await client.query('BEGIN');
        await client.query(`INSERT INTO ${table} (id) VALUES ($1)`, [10_000 + i]);
        await client.query('COMMIT');
        const after = (await client.query<{ lsn: string }>('SELECT pg_current_wal_insert_lsn()::text AS lsn'))
          .rows[0];
        const floor = tokenLsn(parseLsn(after?.lsn ?? ''), LAYOUT);
        const token = lsnOf(await router.issueToken(client));
        if (token < floor) {
          below.push(`${i}: токен ${token} < ${floor}`);
        }
      }
    } finally {
      client.release();
    }
    expect(below).toEqual([]);
  });

  it('COMMIT и токен одним вызовом: запись видна на реплике, выбранной по токену', async () => {
    const router = makeRouter();
    const client = await pool().connect();
    let token: string;
    try {
      await client.query('BEGIN');
      await client.query(`INSERT INTO ${table} (id) VALUES (1)`);
      token = await router.commitAndIssueToken(client);
    } finally {
      client.release();
    }
    await waitForReplicas(env.primary, [env.replica1]);
    const decision = await router.route(token);
    expect(decision.role).toBe(NODE_ROLE.replica);
    const [row] = await adminQuery<{ found: boolean }>(
      env.replica1,
      `SELECT EXISTS (SELECT 1 FROM ${table} WHERE id = 1) AS found`,
    );
    expect(row?.found).toBe(true);
  });

  it('закрытый маршрутизатор (выключение): шаблон README — COMMIT прошёл, токен «только мастер», следующий из пула без чужой транзакции', async () => {
    const router = makeRouter();
    await router.close();
    const shared = pool();
    const client = await shared.connect();
    let token = '';
    try {
      await client.query('BEGIN');
      await client.query(`INSERT INTO ${table} (id) VALUES (20)`);
      token = await router.commitAndIssueToken(client);
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
    expect(new TokenCodec([SPEC_SECRET]).decode(token).kind).toBe('unresolved');
    const next = await shared.connect();
    try {
      const [state] = (
        await next.query<{ open: boolean }>('SELECT pg_current_xact_id_if_assigned() IS NOT NULL AS open')
      ).rows;
      expect(state?.open).toBe(false);
      // Запись закоммичена САМИМ вызовом, а не чужим COMMIT следующего из пула.
      expect((await next.query(`SELECT 1 FROM ${table} WHERE id = 20`)).rowCount).toBe(1);
    } finally {
      next.release();
    }
  });

  it('обёртка слоя доступа переносит отказ драйвера в cause: транзакция в ошибке опознана и завершена — пул не отравлен', async () => {
    const router = makeRouter();
    const shared = pool();
    const client = await shared.connect();
    const wrapped = {
      query: async (text: string) => {
        try {
          return await client.query(text);
        } catch (error) {
          throw new Error(`слой доступа: ${(error as Error).message}`, { cause: error });
        }
      },
    };
    try {
      await client.query('BEGIN');
      await client.query(`INSERT INTO ${table} (id) VALUES (21)`);
      await expect(client.query('SELECT 1 / 0')).rejects.toThrow('division by zero');
      await expect(router.commitAndIssueToken(wrapped)).rejects.toThrow(TransactionNotCommittedError);
    } finally {
      client.release();
    }
    const next = await shared.connect();
    try {
      expect((await next.query('SELECT 1 AS ok')).rows).toEqual([{ ok: 1 }]);
      expect((await next.query(`SELECT 1 FROM ${table} WHERE id = 21`)).rowCount).toBe(0);
    } finally {
      next.release();
    }
  });

  it('транзакция в ошибке: завершается ROLLBACK — отказ, записи нет, соединение снова годно', async () => {
    const router = makeRouter();
    const client = await pool().connect();
    try {
      await client.query('BEGIN');
      await client.query(`INSERT INTO ${table} (id) VALUES (2)`);
      await expect(client.query('SELECT 1 / 0')).rejects.toThrow('division by zero');
      await expect(router.commitAndIssueToken(client)).rejects.toThrow(TransactionNotCommittedError);
      expect((await client.query(`SELECT 1 FROM ${table} WHERE id = 2`)).rowCount).toBe(0);
    } finally {
      client.release();
    }
  });

  it('пул, обёртка над пулом и соединение без BEGIN: транзакции на этом соединении нет — отказ, COMMIT не отправлен, транзакция записи цела', async () => {
    const router = makeRouter();
    const shared = pool();
    const writer = await pool().connect();
    try {
      await writer.query('BEGIN');
      await writer.query(`INSERT INTO ${table} (id) VALUES (4)`);
      const wrapper = { query: (text: string) => shared.query(text) };
      await expect(router.commitAndIssueToken(wrapper)).rejects.toThrow(TransactionNotOpenError);
      // Пул тип отвергает (NotAPool); в рантайме — тот же отказ, если тип обошли.
      await expect(router.commitAndIssueToken(shared as never)).rejects.toThrow(TransactionNotOpenError);
      // Транзакция записи по-прежнему открыта, и запись снаружи не видна.
      expect(
        (await writer.query<{ open: boolean }>('SELECT pg_current_xact_id_if_assigned() IS NOT NULL AS open'))
          .rows[0]?.open,
      ).toBe(true);
      expect((await shared.query(`SELECT 1 FROM ${table} WHERE id = 4`)).rowCount).toBe(0);
      // Настоящий клиент транзакции — токен, и запись видна.
      const token = await router.commitAndIssueToken(writer);
      expect(new TokenCodec([SPEC_SECRET]).decode(token).kind).toBe('position');
      expect((await shared.query(`SELECT 1 FROM ${table} WHERE id = 4`)).rowCount).toBe(1);
      // Запись без BEGIN — транзакционного блока нет: отказ (для неё — issueToken).
      await writer.query(`INSERT INTO ${table} (id) VALUES (5)`);
      await expect(router.commitAndIssueToken(writer)).rejects.toThrow(TransactionNotOpenError);
    } finally {
      writer.release();
    }
  });

  it('законные двойники: транзакция без записи и транзакция со своей точкой сохранения — токен с позицией', async () => {
    const router = makeRouter();
    const client = await pool().connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT count(*) FROM ${table}`);
      expect(new TokenCodec([SPEC_SECRET]).decode(await router.commitAndIssueToken(client)).kind).toBe(
        'position',
      );
      await client.query('BEGIN');
      await client.query('SAVEPOINT pg_replica_sync_commit');
      await client.query(`INSERT INTO ${table} (id) VALUES (6)`);
      await client.query('SAVEPOINT mine');
      await client.query(`INSERT INTO ${table} (id) VALUES (7)`);
      expect(new TokenCodec([SPEC_SECRET]).decode(await router.commitAndIssueToken(client)).kind).toBe(
        'position',
      );
      expect((await client.query(`SELECT id FROM ${table} WHERE id IN (6, 7) ORDER BY id`)).rows).toEqual([
        { id: 6 },
        { id: 7 },
      ]);
    } finally {
      client.release();
    }
  });

  it('простаивающий мастер сразу после переключения сегмента: токен без новой записи реплика проходит за 3 с', async () => {
    const router = makeRouter();
    await adminQuery(env.primary, `INSERT INTO ${table} (id) VALUES (3)`);
    await adminQuery(env.primary, 'SELECT pg_switch_wal()');
    const token = lsnOf(await router.issueToken(pool()));
    // Без сведения к границе страницы токен стоял бы за заголовком сегмента (+40 байт),
    // где записи нет, и реплика проходила бы его только со следующей записью WAL
    // (фоновый снимок транзакций — раз в 15 с, и только если мастер не простаивал).
    await waitForReplay(env.replica1, token, 3_000);
  });
});
