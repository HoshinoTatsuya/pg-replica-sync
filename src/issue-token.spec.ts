import { REPLICA_SYNC_DEFAULTS } from './constants/replica-sync-defaults.constant';
import { ROUTE_REASON } from './constants/route-reason.constant';
import { InvalidReplicaSyncOptionsError } from './invalid-replica-sync-options.error';
import { parseLsn } from './parse-lsn';
import { ReplicaRouter } from './replica-router';
import { SPEC_SECRET } from './testing/spec-secret';
import { TokenCodec } from './token-codec';
import { TransactionNotCommittedError } from './transaction-not-committed.error';
import { TransactionNotOpenError } from './transaction-not-open.error';
import type { RouteReason } from './types/route-reason.type';
import type { SqlCommandExecutor } from './types/sql-command-executor.type';
import type { SqlQueryExecutor } from './types/sql-query-executor.type';

/**
 * Выдача токена без базы: соединение задаёт вызывающий (подделка), адреса
 * узлов не используются — маршрутизатор не открывает ни одного соединения.
 */
jest.setTimeout(10_000);

const AT = 1_700_000_000_000;
const UNUSED = 'postgres://app:app@127.0.0.1:1/postgres';
const routers: ReplicaRouter<string>[] = [];

const makeRouter = (options: { probeTimeoutMs?: number } = {}): ReplicaRouter<string> => {
  const router = new ReplicaRouter<string>({
    primary: { name: 'primary', connection: UNUSED, target: 'primary' },
    replicas: [{ name: 'r1', connection: UNUSED, target: 'r1' }],
    secrets: [SPEC_SECRET],
    wallClock: () => AT,
    ...options,
  });
  routers.push(router);
  return router;
};

/** Строка зонда мастера после COMMIT. */
const primaryRow = (patch: Record<string, unknown> = {}): Record<string, unknown> => ({
  in_recovery: false,
  system_id: '7708384681250484264',
  started_at: '2026-11-16 10:00:00+00',
  insert_lsn: '0/5002100',
  wal_file: '000000010000000000000005',
  write_pending: false,
  has_stats: true,
  wal_layout: [8, 8192, 16_777_216],
  ...patch,
});

const executorOf = (row: Record<string, unknown>, calls: string[] = []): SqlQueryExecutor => ({
  query: async (text: string) => {
    calls.push(text);
    return { rows: [row] };
  },
});

const decode = (token: string) => new TokenCodec([SPEC_SECRET]).decode(token);

afterEach(async () => {
  await Promise.all(routers.splice(0).map((router) => router.close()));
});

describe('токен после записи', () => {
  it('без executor — отказ: соединение зонда не видит транзакцию другого соединения', async () => {
    const router = makeRouter();
    const call = router.issueToken as unknown as (executor?: unknown) => Promise<string>;
    await expect(call.call(router)).rejects.toThrow(TypeError);
    await expect(call.call(router, null)).rejects.toThrow(TypeError);
    await expect(call.call(router, {})).rejects.toThrow(TypeError);
  });

  it('позиция, линия времени, кластер и момент выдачи — из строки соединения записи', async () => {
    const token = await makeRouter().issueToken(executorOf(primaryRow()));
    expect(decode(token)).toEqual({
      kind: 'position',
      position: { systemId: '7708384681250484264', timeline: 1, lsn: parseLsn('0/5002100') },
      issuedAt: AT,
    });
  });

  it('позиция вставки сразу за заголовком страницы — токен на границе страницы', async () => {
    const token = await makeRouter().issueToken(executorOf(primaryRow({ insert_lsn: '0/5002018' })));
    expect(decode(token)).toMatchObject({ kind: 'position', position: { lsn: parseLsn('0/5002000') } });
    const segment = await makeRouter().issueToken(executorOf(primaryRow({ insert_lsn: '0/6000028' })));
    expect(decode(segment)).toMatchObject({ kind: 'position', position: { lsn: parseLsn('0/6000000') } });
  });

  it('незакоммиченная запись на этом соединении, узел в recovery — токен «только мастер» и хук', async () => {
    const unresolved: string[] = [];
    const router = new ReplicaRouter<string>({
      primary: { name: 'primary', connection: UNUSED, target: 'primary' },
      replicas: [],
      secrets: [SPEC_SECRET],
      wallClock: () => AT,
      observer: { tokenUnresolved: ({ error }) => unresolved.push(error.message) },
    });
    routers.push(router);
    expect(decode(await router.issueToken(executorOf(primaryRow({ write_pending: true }))))).toEqual({
      kind: 'unresolved',
      issuedAt: AT,
    });
    expect(decode(await router.issueToken(executorOf(primaryRow({ in_recovery: true }))))).toEqual({
      kind: 'unresolved',
      issuedAt: AT,
    });
    expect(unresolved).toEqual([
      'транзакция с записью ещё не закоммичена: позиция её коммита неизвестна',
      'узел primary в recovery: это не мастер',
    ]);
  });

  it('соединение записи не отвечает — токен «только мастер» по потолку зонда, а не зависание', async () => {
    const router = makeRouter({ probeTimeoutMs: 100 });
    const silent: SqlQueryExecutor = { query: () => new Promise(() => undefined) };
    const token = await router.issueToken(silent);
    expect(decode(token)).toEqual({ kind: 'unresolved', issuedAt: AT });
  });
});

describe('COMMIT и токен одним вызовом', () => {
  /** Подделка соединения: SAVEPOINT и COMMIT отвечают как Postgres в заданном состоянии транзакции. */
  const fakeClient = (calls: string[], state: 'open' | 'none' | 'failed'): SqlCommandExecutor => ({
    query: async (text: string) => {
      calls.push(text);
      if (text.startsWith('SAVEPOINT')) {
        if (state === 'none') {
          throw Object.assign(new Error('SAVEPOINT can only be used in transaction blocks'), {
            code: '25P01',
          });
        }
        if (state === 'failed') {
          throw Object.assign(new Error('current transaction is aborted'), { code: '25P02' });
        }
        return { rows: [], command: 'SAVEPOINT' };
      }
      if (text === 'COMMIT') {
        return { rows: [], command: state === 'failed' ? 'ROLLBACK' : 'COMMIT' };
      }
      return { rows: [primaryRow()], command: 'SELECT' };
    },
  });

  it('на соединении открыта транзакция: SAVEPOINT, COMMIT, потом позиция — на нём же и в этом порядке', async () => {
    const calls: string[] = [];
    const token = await makeRouter().commitAndIssueToken(fakeClient(calls, 'open'));
    expect(calls.slice(0, 2)).toEqual(['SAVEPOINT pg_replica_sync_commit', 'COMMIT']);
    expect(calls.length).toBe(3);
    expect(decode(token)).toMatchObject({ kind: 'position', position: { lsn: parseLsn('0/5002100') } });
  });

  it('транзакции на соединении нет (пул, обёртка над пулом, запись без BEGIN) — отказ, COMMIT не отправлен', async () => {
    const calls: string[] = [];
    await expect(makeRouter().commitAndIssueToken(fakeClient(calls, 'none'))).rejects.toThrow(
      TransactionNotOpenError,
    );
    expect(calls).toEqual(['SAVEPOINT pg_replica_sync_commit']);
  });

  it('транзакция в ошибке: завершается ROLLBACK — отказ, токена нет, COMMIT не отправлен', async () => {
    const calls: string[] = [];
    await expect(makeRouter().commitAndIssueToken(fakeClient(calls, 'failed'))).rejects.toThrow(
      TransactionNotCommittedError,
    );
    expect(calls).toEqual(['SAVEPOINT pg_replica_sync_commit', 'ROLLBACK']);
  });

  /** Обёртка слоя доступа: свой текст, отказ драйвера — в `cause` (код самой обёртки — не SQLSTATE). */
  const wrapped = (client: SqlCommandExecutor, depth: number): SqlCommandExecutor => ({
    query: async (text: string) => {
      try {
        return await client.query(text);
      } catch (error) {
        let outer: unknown = error;
        for (let i = 0; i < depth; i += 1) {
          outer = Object.assign(new Error(`обёртка ${i}`, { cause: outer }), { code: 'ERR_WRAPPED' });
        }
        throw outer;
      }
    },
  });

  it.each([1, 3])(
    'SQLSTATE в цепочке cause (обёрток: %i): нет транзакции — TransactionNotOpenError, транзакция в ошибке — ROLLBACK',
    async (depth) => {
      const none: string[] = [];
      await expect(
        makeRouter().commitAndIssueToken(wrapped(fakeClient(none, 'none'), depth)),
      ).rejects.toThrow(TransactionNotOpenError);
      expect(none).toEqual(['SAVEPOINT pg_replica_sync_commit']);
      const failed: string[] = [];
      await expect(
        makeRouter().commitAndIssueToken(wrapped(fakeClient(failed, 'failed'), depth)),
      ).rejects.toThrow(TransactionNotCommittedError);
      expect(failed).toEqual(['SAVEPOINT pg_replica_sync_commit', 'ROLLBACK']);
    },
  );

  it('цепочка cause с циклом и бросающим геттером — «кода нет»: исключение наружу, без зависания', async () => {
    const looped = new Error('цикл') as Error & { cause?: unknown };
    looped.cause = looped;
    const getter = Object.defineProperty(new Error('геттер'), 'code', {
      get(): never {
        throw new Error('геттер кода упал');
      },
    });
    for (const failure of [looped, getter]) {
      const calls: string[] = [];
      const client: SqlCommandExecutor = {
        query: async (text: string) => {
          calls.push(text);
          throw failure;
        },
      };
      await expect(makeRouter().commitAndIssueToken(client)).rejects.toBe(failure);
      expect(calls).toEqual(['SAVEPOINT pg_replica_sync_commit']);
    }
  });

  it('драйвер без тега ответа (command): исправная транзакция после COMMIT — токен, а не «откачена» (повтор записал бы дубль)', async () => {
    const calls: string[] = [];
    const client: SqlCommandExecutor = {
      query: async (text: string) => {
        calls.push(text);
        return text.startsWith('SELECT') ? { rows: [primaryRow()] } : { rows: [] };
      },
    };
    const token = await makeRouter().commitAndIssueToken(client);
    expect(calls.slice(0, 2)).toEqual(['SAVEPOINT pg_replica_sync_commit', 'COMMIT']);
    expect(decode(token)).toMatchObject({ kind: 'position', position: { lsn: parseLsn('0/5002100') } });
  });

  it('COMMIT ответил тегом ROLLBACK — отказ, токена нет (двойник: тег COMMIT — токен)', async () => {
    const reply = (tag: string): SqlCommandExecutor => ({
      query: async (text: string) =>
        text === 'COMMIT' ? { rows: [], command: tag } : { rows: [primaryRow()], command: 'SELECT' },
    });
    await expect(makeRouter().commitAndIssueToken(reply('ROLLBACK'))).rejects.toThrow(
      TransactionNotCommittedError,
    );
    expect(decode(await makeRouter().commitAndIssueToken(reply('COMMIT'))).kind).toBe('position');
  });

  it('иной отказ SAVEPOINT — его исключение наружу, COMMIT не отправлен', async () => {
    const calls: string[] = [];
    const failure = Object.assign(new Error('connection lost'), { code: '08006' });
    const client: SqlCommandExecutor = {
      query: async (text: string) => {
        calls.push(text);
        throw failure;
      },
    };
    await expect(makeRouter().commitAndIssueToken(client)).rejects.toBe(failure);
    expect(calls).toEqual(['SAVEPOINT pg_replica_sync_commit']);
  });

  it('отказ COMMIT — его исключение наружу, токена нет', async () => {
    const failure = new Error('could not serialize access');
    const client: SqlCommandExecutor = {
      query: async (text: string) => {
        if (text === 'COMMIT') {
          throw failure;
        }
        return { rows: [], command: 'SAVEPOINT' };
      },
    };
    await expect(makeRouter().commitAndIssueToken(client)).rejects.toBe(failure);
  });
});

describe('закрытый маршрутизатор: запись не роняется', () => {
  it('commitAndIssueToken после close(): COMMIT отправлен (транзакция не остаётся открытой), токен «только мастер», хук', async () => {
    const unresolved: string[] = [];
    const router = new ReplicaRouter<string>({
      primary: { name: 'primary', connection: UNUSED, target: 'primary' },
      replicas: [],
      secrets: [SPEC_SECRET],
      wallClock: () => AT,
      observer: { tokenUnresolved: ({ error }) => unresolved.push(error.message) },
    });
    await router.close();
    const calls: string[] = [];
    const client: SqlCommandExecutor = {
      query: async (text: string) => {
        calls.push(text);
        return { rows: [primaryRow()], command: text.split(' ')[0] ?? '' };
      },
    };
    const token = await router.commitAndIssueToken(client);
    expect(calls).toEqual(['SAVEPOINT pg_replica_sync_commit', 'COMMIT']);
    expect(decode(token)).toEqual({ kind: 'unresolved', issuedAt: AT });
    expect(unresolved).toEqual(['ReplicaRouter закрыт: токен «только мастер»']);
  });

  it('issueToken после close(): токен «только мастер» без запроса; route() — отказ (новое чтение не начато)', async () => {
    const router = makeRouter();
    await router.close();
    const calls: string[] = [];
    expect(decode(await router.issueToken(executorOf(primaryRow(), calls)))).toEqual({
      kind: 'unresolved',
      issuedAt: AT,
    });
    expect(calls).toEqual([]);
    await expect(router.route()).rejects.toThrow('ReplicaRouter закрыт');
  });
});

describe('наблюдатель и счётчики', () => {
  it('бросающий геттер хука не роняет route(), issueToken и счёт решений', async () => {
    const observer = Object.defineProperties(
      {},
      Object.fromEntries(
        ['routed', 'probed', 'tokenUnresolved', 'confirmed'].map((key) => [
          key,
          {
            get(): never {
              throw new Error(`геттер ${key} упал`);
            },
          },
        ]),
      ),
    );
    const router = new ReplicaRouter<string>({
      primary: { name: 'primary', connection: UNUSED, target: 'primary' },
      replicas: [{ name: 'r1', connection: UNUSED, target: 'r1' }],
      secrets: [SPEC_SECRET],
      wallClock: () => AT,
      observer,
    });
    routers.push(router);
    expect(await router.route('мусор')).toMatchObject({ role: 'primary', reason: ROUTE_REASON.tokenInvalid });
    expect(decode(await router.issueToken(executorOf(primaryRow({ write_pending: true }))))).toMatchObject({
      kind: 'unresolved',
    });
    expect(router.stats().reads.primary).toBe(1);
  });

  it('отставание каждой реплики известно с создания как null (мастера в списке нет); stats() сериализуется', () => {
    const router = new ReplicaRouter<string>({
      primary: { name: 'primary', connection: UNUSED, target: 'primary' },
      replicas: [
        { name: 'r1', connection: UNUSED, target: 'r1' },
        { name: 'r2', connection: UNUSED, target: 'r2' },
      ],
      secrets: [SPEC_SECRET],
    });
    routers.push(router);
    expect(router.stats().lagBytes).toEqual({ r1: null, r2: null });
    expect(Object.keys(router.stats().lagBytes)).toEqual(['r1', 'r2']);
    expect(JSON.parse(JSON.stringify(router.stats()))).toEqual(router.stats());
  });
});

describe('настройки', () => {
  it.each([
    ['clock — NaN', { clock: () => Number.NaN }],
    ['clock — undefined', { clock: () => undefined as unknown as number }],
    ['clock — не функция', { clock: 5 as unknown as () => number }],
    ['wallClock — Infinity', { wallClock: () => Number.POSITIVE_INFINITY }],
    ['connectTimeoutMs — 0', { connectTimeoutMs: 0 }],
    ['connectTimeoutMs — 2³¹', { connectTimeoutMs: 2 ** 31 }],
  ])('%s — отказ при создании', (_label, patch) => {
    expect(
      () =>
        new ReplicaRouter<string>({
          primary: { name: 'primary', connection: UNUSED, target: 'primary' },
          replicas: [],
          secrets: [SPEC_SECRET],
          ...patch,
        }),
    ).toThrow(InvalidReplicaSyncOptionsError);
  });

  it('wallClock, испортившийся после создания (не число, отрицательный), не роняет выдачу токена после записи: момент 0', async () => {
    const readings = [AT, Number.NaN, -5];
    const router = new ReplicaRouter<string>({
      primary: { name: 'primary', connection: UNUSED, target: 'primary' },
      replicas: [],
      secrets: [SPEC_SECRET],
      wallClock: () => readings.shift() ?? AT,
    });
    routers.push(router);
    for (let i = 0; i < 2; i += 1) {
      expect(decode(await router.issueToken(executorOf(primaryRow())))).toMatchObject({
        kind: 'position',
        issuedAt: 0,
      });
    }
  });

  it('необязательные поля, переданные как undefined, — умолчания (exactOptionalPropertyTypes)', () => {
    const router = new ReplicaRouter<string>({
      primary: { name: 'primary', connection: UNUSED, target: 'primary', balanced: undefined },
      replicas: [],
      secrets: [SPEC_SECRET],
      stateTtlMs: undefined,
      probeTimeoutMs: undefined,
      connectTimeoutMs: undefined,
      observer: undefined,
      clock: undefined,
      wallClock: undefined,
    });
    routers.push(router);
    expect(router.stats().expiredTokens).toBe(0);
  });

  it('stateTtlMs выше потолка, отрицательные интервалы и срок токена — отказ при создании', () => {
    const make = (patch: Record<string, number>) => () =>
      new ReplicaRouter<string>({
        primary: { name: 'primary', connection: UNUSED, target: 'primary' },
        replicas: [],
        secrets: [SPEC_SECRET],
        ...patch,
      });
    expect(make({ stateTtlMs: 1_001 })).toThrow(InvalidReplicaSyncOptionsError);
    expect(make({ stateTtlMs: 0 })).toThrow(InvalidReplicaSyncOptionsError);
    expect(make({ minProbeIntervalMs: -1 })).toThrow(InvalidReplicaSyncOptionsError);
    expect(make({ tokenTtlMs: 0 })).toThrow(InvalidReplicaSyncOptionsError);
    expect(make({ tokenTtlMs: 1.5 })).toThrow(InvalidReplicaSyncOptionsError);
    // Значения таймеров не больше 2³¹−1: больше — Node сработал бы через 1 мс.
    expect(make({ probeTimeoutMs: 2 ** 31 })).toThrow(InvalidReplicaSyncOptionsError);
    expect(make({ catchUpPollMs: 2 ** 31 })).toThrow(InvalidReplicaSyncOptionsError);
    expect(make({ waitForCatchUpMs: 2 ** 31 - 1_000 })).toThrow(InvalidReplicaSyncOptionsError);
    expect(make({ probeTimeoutMs: 2 ** 31 - 1, waitForCatchUpMs: 1 })).toThrow(
      InvalidReplicaSyncOptionsError,
    );
    // Контроль: на границах — принимается (и ничего не открывает).
    const accepted = new ReplicaRouter<string>({
      primary: { name: 'primary', connection: UNUSED, target: 'primary' },
      replicas: [],
      secrets: [SPEC_SECRET],
      stateTtlMs: 1_000,
      probeTimeoutMs: 1_000,
      waitForCatchUpMs: 2 ** 31 - 1 - 1_000,
      catchUpPollMs: 2 ** 31 - 1,
      minProbeIntervalMs: 0,
      tokenTtlMs: 1,
    });
    routers.push(accepted);
    expect(accepted.stats().expiredTokens).toBe(0);
  });
});

describe('память о позициях токенов для потолка частоты зондов', () => {
  const memoryOf = (router: ReplicaRouter<string>): Map<string, number> =>
    (router as unknown as { seenPositions: Map<string, number> }).seenPositions;
  const closedRouter = (): ReplicaRouter<string> => {
    const router = new ReplicaRouter<string>({
      primary: { name: 'primary', connection: UNUSED, target: 'primary' },
      // Узел за закрытым портом: первый зонд отказывает сразу, отказ живёт в кэше — дальше без зондов.
      replicas: [{ name: 'r1', connection: UNUSED, target: 'r1' }],
      secrets: [SPEC_SECRET],
      wallClock: () => AT,
      unavailableRetryMs: 600_000,
    });
    routers.push(router);
    return router;
  };
  const tokenAt = (lsn: number, issuedAt = AT): string =>
    new TokenCodec([SPEC_SECRET]).encode({ systemId: '1', timeline: 1, lsn: BigInt(lsn) }, issuedAt);

  it('не больше POSITION_MEMORY позиций: ключи приходят от клиентов, вытесняется давно не встречавшаяся', async () => {
    const router = closedRouter();
    const total = REPLICA_SYNC_DEFAULTS.POSITION_MEMORY + 100;
    for (let i = 0; i < total; i += 1) {
      await router.route(tokenAt(i));
    }
    expect(memoryOf(router).size).toBe(REPLICA_SYNC_DEFAULTS.POSITION_MEMORY);
    expect(memoryOf(router).has('1/1/0')).toBe(false);
    expect(memoryOf(router).has(`1/1/${(total - 1).toString(16)}`)).toBe(true);
  });

  it('LRU: позиция, которую читают, остаётся при потоке новых (FIFO вытеснил бы её первой)', async () => {
    const router = closedRouter();
    const hot = tokenAt(0);
    await router.route(hot);
    for (let i = 1; i <= REPLICA_SYNC_DEFAULTS.POSITION_MEMORY * 2; i += 1) {
      await router.route(tokenAt(i));
      if (i % 100 === 0) {
        await router.route(hot);
      }
    }
    expect(memoryOf(router).has('1/1/0')).toBe(true);
    expect(memoryOf(router).size).toBe(REPLICA_SYNC_DEFAULTS.POSITION_MEMORY);
  });

  it('токены одной позиции (разные моменты выдачи) — одна запись памяти', async () => {
    const router = closedRouter();
    for (let i = 0; i < 2_000; i += 1) {
      await router.route(tokenAt(i % 10, AT + i));
    }
    expect(memoryOf(router).size).toBe(10);
  });
});

describe('какие причины «мастер» стареют', () => {
  it('таблица по ВСЕМ значениям ROUTE_REASON: стареют только failover, подмена кластера и «впереди мастера»', () => {
    const unsatisfiable = (ReplicaRouter as unknown as { UNSATISFIABLE: ReadonlySet<string> }).UNSATISFIABLE;
    const expected: Record<RouteReason, boolean> = {
      'replica-caught-up': false,
      'replica-within-lag': false,
      'no-replicas': false,
      'token-invalid': false,
      // Позиция неизвестна — «как без токена» могло бы увести на реплику без записи.
      'token-unresolved': false,
      'token-other-timeline': true,
      // Только по зонду мастера, начатому после первой встречи с позицией (fallbackReason).
      'token-ahead-of-primary': true,
      'token-foreign': true,
      'no-replica-eligible': false,
      'primary-state-unknown': false,
    };
    expect(Object.keys(expected).sort()).toEqual(Object.values(ROUTE_REASON).sort());
    expect(
      Object.fromEntries(Object.values(ROUTE_REASON).map((reason) => [reason, unsatisfiable.has(reason)])),
    ).toEqual(expected);
  });
});
