import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

import { FaultProxy } from '@hoshinotatsuya/fault-kit/tcp';
import { Pool } from 'pg';

import { NODE_ROLE } from './constants/node-role.constant';
import { ProbeConnection } from './probe-connection';
import { ProbeConnectionClosedError } from './probe-connection-closed.error';
import { ReplicaRouter } from './replica-router';
import { asRole } from './testing/as-role';
import { countBackends } from './testing/count-backends';
import { createSharedTable } from './testing/create-shared-table';
import { replicationEnv } from './testing/replication-env';
import { setApplyDelay } from './testing/set-apply-delay';
import { SPEC_SECRET } from './testing/spec-secret';
import { terminateBackends } from './testing/terminate-backends';
import { untilChanged } from './testing/until-changed';
import { waitForReplicas } from './testing/wait-for-replicas';

/**
 * Жизненный цикл соединений зонда: отказ одного запроса не закрывает уже новое
 * соединение; `close()` закрывает всё и не даёт открыть снова, в том числе
 * идущим `route()`. Каждая спека в конце обрывает свои соединения на сервере:
 * код, который забыл их закрыть, краснеет утверждением, а не держит jest.
 */
jest.setTimeout(60_000);

const env = replicationEnv();
const APP = { primary: asRole(env.primary, 'app'), r1: asRole(env.replica1, 'app') };

let table: string;
const names: string[] = [];
const proxies: FaultProxy[] = [];
const pools: Pool[] = [];

const appName = (): string => {
  const name = `spec-life-${randomUUID().slice(0, 8)}`;
  names.push(name);
  return name;
};

const backendsOf = async (name: string): Promise<{ primary: number; r1: number }> => ({
  primary: await countBackends(env.primary, name),
  r1: await countBackends(env.replica1, name),
});

beforeAll(async () => {
  table = await createSharedTable(env.primary, [env.replica1]);
});

afterEach(async () => {
  for (const proxy of proxies.splice(0)) {
    proxy.thaw();
    await proxy.close();
  }
  await setApplyDelay(env.replica1, null);
  await waitForReplicas(env.primary, [env.replica1]);
  await Promise.all(pools.splice(0).map((created) => created.end()));
  for (const name of names.splice(0)) {
    await terminateBackends(env.primary, name);
    await terminateBackends(env.replica1, name);
  }
});

describe('соединение зонда', () => {
  it('потолок зонда соединение не рвёт; молчащее дольше connectTimeoutMs — рвётся, следующий запрос на новом', async () => {
    const target = new URL(env.primary);
    const proxy = await FaultProxy.start({ host: target.hostname, port: Number(target.port) });
    proxies.push(proxy);
    const via = new URL(APP.primary);
    via.hostname = '127.0.0.1';
    via.port = String(proxy.port);
    // Потолок зонда 1 с, жизни молчащего соединения — 4 с.
    const connection = new ProbeConnection(
      'primary',
      { connectionString: via.toString(), application_name: appName() },
      1_000,
      () => undefined,
      4_000,
    );
    const pid = async (): Promise<unknown> => {
      const [row] = (await connection.query('SELECT pg_backend_pid() AS pid')) as { pid?: unknown }[];
      return row?.pid;
    };
    const outcome = (query: Promise<unknown>) =>
      query.then(
        () => 'ok',
        (error: Error) => error.message,
      );
    try {
      const first = await pid();
      expect(typeof first).toBe('number');
      // Запрос не уложился в потолок зонда — отказ зонда, но соединение живо: после
      // восстановления сети следующий запрос идёт на ТОМ ЖЕ сервере-процессе.
      proxy.freeze();
      expect(await outcome(connection.query('SELECT 1 AS a'))).toContain('не ответил за 1000 мс');
      proxy.thaw();
      expect(await pid()).toBe(first);
      // Молчит дольше connectTimeoutMs — соединение снято; следующий запрос — новое.
      proxy.freeze();
      expect(await outcome(connection.query('SELECT 1 AS b'))).toContain('не ответил за 1000 мс');
      await sleep(3_500);
      proxy.thaw();
      const second = await pid();
      expect(typeof second).toBe('number');
      expect(second).not.toBe(first);
    } finally {
      await connection.close();
    }
  });

  it('после close() запрос — отказ сразу, соединение не открывается', async () => {
    const name = appName();
    const connection = new ProbeConnection('r1', { connectionString: APP.r1, application_name: name }, 1_000);
    await connection.query('SELECT 1');
    expect(await countBackends(env.replica1, name)).toBe(1);
    await connection.close();
    await expect(connection.query('SELECT 1')).rejects.toThrow(ProbeConnectionClosedError);
    expect(
      await untilChanged(
        () => countBackends(env.replica1, name),
        (count) => count > 0,
      ),
    ).toBe(0);
  });
});

describe('close() маршрутизатора', () => {
  const makeRouter = (
    name: string,
    options: { waitForCatchUpMs?: number; catchUpPollMs?: number } = {},
  ): ReplicaRouter<string> =>
    new ReplicaRouter<string>({
      primary: {
        name: 'primary',
        connection: { connectionString: APP.primary, application_name: name },
        target: 'primary',
      },
      replicas: [
        { name: 'r1', connection: { connectionString: APP.r1, application_name: name }, target: 'r1' },
      ],
      secrets: [SPEC_SECRET],
      catchUpPollMs: 50,
      ...options,
    });

  it('закрывает соединения зондов всех узлов', async () => {
    const name = appName();
    const router = makeRouter(name);
    expect((await router.route()).role).toBe(NODE_ROLE.replica);
    expect(await backendsOf(name)).toEqual({ primary: 1, r1: 1 });
    await router.close();
    expect(
      await untilChanged(
        () => backendsOf(name),
        (count) => count.primary + count.r1 > 0,
      ),
    ).toEqual({
      primary: 0,
      r1: 0,
    });
    await expect(router.route()).rejects.toThrow('закрыт');
  });

  it('решение «реплика», полученное до close(): confirm после — false без запроса (чтение с мастера), не исключение', async () => {
    const name = appName();
    const router = makeRouter(name);
    const decision = await router.route();
    expect(decision.role).toBe(NODE_ROLE.replica);
    await router.close();
    const calls: string[] = [];
    const reader = {
      query: async (text: string) => {
        calls.push(text);
        return { rows: [] };
      },
    };
    await expect(router.confirm(decision, reader)).resolves.toBe(false);
    expect(calls).toEqual([]);
    expect(router.stats().confirms).toEqual({ confirmed: 0, rejected: 1, reasons: { unavailable: 1 } });
  });

  it('route(), ждущий догоняния во время close(), не открывает соединения снова и не ждёт свой потолок', async () => {
    const name = appName();
    await setApplyDelay(env.replica1, '1h');
    // Пауза между опросами (20 с) длиннее потолка проверки: дождаться её — красный.
    const router = makeRouter(name, { waitForCatchUpMs: 60_000, catchUpPollMs: 20_000 });
    const primary = new Pool({ connectionString: APP.primary, max: 1 });
    pools.push(primary);
    const client = await primary.connect();
    let token: string;
    try {
      await client.query('BEGIN');
      await client.query(`INSERT INTO ${table} (id) VALUES (1)`);
      token = await router.commitAndIssueToken(client);
    } finally {
      client.release();
    }
    let polls = -1;
    const pending = router.route(token).then((decision) => {
      polls = decision.catchUpPolls;
      return decision;
    });
    await sleep(300);
    await router.close();
    // Без прерывания ожидание шло бы до конца паузы (20 с) — дольше потолка этой проверки.
    const decision = await untilChanged(
      async () => (polls === -1 ? null : pending),
      (value) => value === null,
      3_000,
    );
    expect(decision?.role).toBe(NODE_ROLE.primary);
    await sleep(300);
    expect(
      await untilChanged(
        () => backendsOf(name),
        (count) => count.primary + count.r1 > 0,
      ),
    ).toEqual({
      primary: 0,
      r1: 0,
    });
  });
});
