import { performance } from 'node:perf_hooks';
import { setTimeout as sleep } from 'node:timers/promises';

import { compareLsn } from './compare-lsn';
import { EXCLUSION_REASON } from './constants/exclusion-reason.constant';
import { NODE_ROLE } from './constants/node-role.constant';
import { PROBE_SQL } from './constants/probe-sql.constant';
import { REPLICA_SYNC_DEFAULTS } from './constants/replica-sync-defaults.constant';
import { ROUTE_REASON } from './constants/route-reason.constant';
import { evaluateReplica } from './evaluate-replica';
import { InvalidReplicaSyncOptionsError } from './invalid-replica-sync-options.error';
import { lagBytes } from './lag-bytes';
import { notify } from './notify';
import { ProbeConnection } from './probe-connection';
import { readNodeState } from './read-node-state';
import { requireInteger } from './require-integer';
import { sqlStateOf } from './sql-state-of';
import { StateCache } from './state-cache';
import { toError } from './to-error';
import { TokenCodec } from './token-codec';
import { TransactionNotCommittedError } from './transaction-not-committed.error';
import { TransactionNotOpenError } from './transaction-not-open.error';
import type { Clock } from './types/clock.type';
import type { Evaluated } from './types/evaluated.type';
import type { Exclusion } from './types/exclusion.type';
import type { ExclusionReason } from './types/exclusion-reason.type';
import type { NodeState } from './types/node-state.type';
import type { NotAPool } from './types/not-a-pool.type';
import type { ProbeOutcome } from './types/probe-outcome.type';
import type { ProbeSample } from './types/probe-sample.type';
import type { ReplicaNode } from './types/replica-node.type';
import type { ReplicaRequirement } from './types/replica-requirement.type';
import type { ReplicaRouterOptions } from './types/replica-router-options.type';
import type { RouteDecision } from './types/route-decision.type';
import type { RouteReason } from './types/route-reason.type';
import type { RouterObserver } from './types/router-observer.type';
import type { RouterStats } from './types/router-stats.type';
import type { SqlCommandExecutor } from './types/sql-command-executor.type';
import type { SqlQueryExecutor } from './types/sql-query-executor.type';
import type { WalPosition } from './types/wal-position.type';

/**
 * Маршрутизатор чтений «читаешь свои записи»: после записи — токен с
 * соединения, на котором прошёл COMMIT (`issueToken(client)` или
 * `commitAndIssueToken(client)`), чтение с токеном — `route(token)`. Реплика
 * выбирается, только если доказано, что она догнала позицию токена на той же
 * линии времени того же кластера; всё, что не удалось установить, — мастер. Без
 * токена — реплика с отставанием в потолке от позиции вставки мастера.
 *
 * Состояние узлов снимается своими соединениями зонда (по одному на узел) и
 * кэшируется на `stateTtlMs`; одновременные чтения ждут один зонд узла, а новый
 * зонд узла — не чаще `minProbeIntervalMs`. Каждое `route()` укладывается в
 * `probeTimeoutMs + waitForCatchUpMs`.
 */
export class ReplicaRouter<TTarget> {
  /**
   * Причины «мастер», которые после failover или подмены кластера не снимет ни
   * одна реплика: такой токен держит мастер `tokenTtlMs`, затем — как без токена.
   * Истечение — только если причина ДОКАЗАНА состоянием мастера из зонда, начатого
   * после первой встречи процесса с позицией токена (или исключением каждой
   * реплики как чужого кластера). Состояние, снятое раньше, о токене ничего не
   * говорит: свежий законный токен впереди него законно, и истечение по нему
   * отправило бы чтение на реплику без записи. Токен «без позиции» сюда НЕ
   * входит: его позиция неизвестна, и «как без токена» могло бы отправить чтение
   * на реплику без этой записи (с задержкой применения она в потолке отставания) —
   * он держит мастер, пока клиент не получит новый токен.
   */
  private static readonly UNSATISFIABLE: ReadonlySet<RouteReason> = new Set<RouteReason>([
    ROUTE_REASON.tokenOtherTimeline,
    ROUTE_REASON.tokenForeign,
    ROUTE_REASON.tokenAheadOfPrimary,
  ]);

  /** SQLSTATE: команда транзакционного блока вне транзакции. */
  private static readonly NO_ACTIVE_TRANSACTION = '25P01';
  /** SQLSTATE: транзакция в ошибке, команды до её конца отвергаются. */
  private static readonly IN_FAILED_TRANSACTION = '25P02';

  private readonly codec: TokenCodec;
  private readonly primary: ReplicaNode<TTarget>;
  private readonly replicas: readonly ReplicaNode<TTarget>[];
  private readonly connections = new Map<string, ProbeConnection>();
  private readonly inflight = new Map<string, Promise<ProbeSample>>();
  private readonly inflightSeq = new Map<string, number>();
  /**
   * Позиция токена → номер зонда при первой встрече с ней (потолок частоты
   * зондов и доказательство невыполнимости), не больше `POSITION_MEMORY`
   * записей, вытесняется давно не встречавшаяся (LRU).
   */
  private readonly seenPositions = new Map<string, number>();
  /** Последняя линия времени, которую приёмник WAL показал у экземпляра реплики. */
  private readonly lastTimeline = new Map<string, { readonly instance: string; readonly timeline: number }>();
  private readonly requirements = new WeakMap<RouteDecision<TTarget>, ReplicaRequirement>();
  private readonly cache: StateCache;
  private readonly probeTimeoutMs: number;
  private readonly connectTimeoutMs: number;
  private readonly maxLagBytes: bigint;
  private readonly waitForCatchUpMs: number;
  private readonly catchUpPollMs: number;
  private readonly minProbeIntervalMs: number;
  private readonly tokenTtlMs: number;
  private readonly observer: RouterObserver;
  private readonly clock: Clock;
  private readonly wallClock: Clock;
  private readonly closing = new AbortController();
  private seq = 0;
  private turn = 0;
  private closed = false;
  private readonly counters = {
    replica: 0,
    primary: 0,
    probesOk: 0,
    probesFailed: 0,
    expiredTokens: 0,
    confirmed: 0,
    rejected: 0,
    rejections: new Map<ExclusionReason, number>(),
    reasons: new Map<RouteReason, number>(),
    exclusions: new Map<ExclusionReason, number>(),
    lag: new Map<string, bigint | null>(),
  };

  constructor(options: ReplicaRouterOptions<TTarget>) {
    this.codec = new TokenCodec(options.secrets);
    this.primary = options.primary;
    this.replicas = [...options.replicas];
    const names = [this.primary, ...this.replicas].map((node) => node.name);
    for (const name of names) {
      if (typeof name !== 'string' || name.length === 0) {
        throw new InvalidReplicaSyncOptionsError('имя узла пусто');
      }
    }
    if (new Set(names).size !== names.length) {
      throw new InvalidReplicaSyncOptionsError(`имена узлов повторяются: ${names.join(', ')}`);
    }
    const D = REPLICA_SYNC_DEFAULTS;
    const stateTtlMs = requireInteger(
      'stateTtlMs',
      options.stateTtlMs ?? D.STATE_TTL_MS,
      1,
      D.MAX_STATE_TTL_MS,
    );
    this.probeTimeoutMs = requireInteger(
      'probeTimeoutMs',
      options.probeTimeoutMs ?? D.PROBE_TIMEOUT_MS,
      1,
      D.MAX_TIMER_MS,
    );
    this.connectTimeoutMs = requireInteger(
      'connectTimeoutMs',
      options.connectTimeoutMs ?? D.CONNECT_TIMEOUT_MS,
      1,
      D.MAX_TIMER_MS,
    );
    const retryMs = requireInteger(
      'unavailableRetryMs',
      options.unavailableRetryMs ?? D.UNAVAILABLE_RETRY_MS,
      1,
    );
    this.maxLagBytes = BigInt(requireInteger('maxLagBytes', options.maxLagBytes ?? D.MAX_LAG_BYTES, 0));
    this.waitForCatchUpMs = requireInteger(
      'waitForCatchUpMs',
      options.waitForCatchUpMs ?? D.WAIT_FOR_CATCH_UP_MS,
      0,
      D.MAX_TIMER_MS - this.probeTimeoutMs,
    );
    this.catchUpPollMs = requireInteger(
      'catchUpPollMs',
      options.catchUpPollMs ?? D.CATCH_UP_POLL_MS,
      1,
      D.MAX_TIMER_MS,
    );
    this.minProbeIntervalMs = requireInteger(
      'minProbeIntervalMs',
      options.minProbeIntervalMs ?? D.MIN_PROBE_INTERVAL_MS,
      0,
    );
    this.tokenTtlMs = requireInteger('tokenTtlMs', options.tokenTtlMs ?? D.TOKEN_TTL_MS, 1);
    this.observer = options.observer ?? {};
    this.clock = options.clock ?? (() => performance.now());
    this.wallClock = options.wallClock ?? (() => Date.now());
    ReplicaRouter.requireClock('clock', this.clock);
    ReplicaRouter.requireClock('wallClock', this.wallClock);
    this.cache = new StateCache(new Set(names), stateTtlMs, retryMs, this.clock);
    for (const node of [this.primary, ...this.replicas]) {
      this.connections.set(
        node.name,
        new ProbeConnection(
          node.name,
          node.connection,
          this.probeTimeoutMs,
          () => this.cache.delete(node.name),
          this.connectTimeoutMs,
        ),
      );
      this.counters.lag.set(node.name, null);
    }
    this.counters.lag.delete(this.primary.name);
  }

  /**
   * Токен позиции после записи — с `executor`, на котором прошёл COMMIT (или с
   * любым соединением мастера ПОСЛЕ того, как COMMIT вернулся: позиция вставки
   * монотонна). Аргумент обязателен: соединение зонда или пул не видят
   * незакоммиченную транзакцию ДРУГОГО соединения, и токен, взятый ими до
   * COMMIT, оказался бы меньше позиции коммита — реплика «догнала» бы его без
   * этой записи. Позицию определить не смогли (узел в recovery, транзакция с
   * записью на этом соединении не закоммичена, отказ, потолок времени) — токен
   * «только мастер», а не исключение: клиент с ним читает с мастера.
   * Так же после `close()`: запись уже прошла, и исключение выглядело бы её
   * отказом и толкало бы к повтору.
   */
  async issueToken(executor: SqlQueryExecutor): Promise<string> {
    ReplicaRouter.requireExecutor('issueToken', executor);
    return this.tokenAfterCommit(executor);
  }

  /**
   * COMMIT на соединении транзакции записи и токен с него же — порядок «сначала
   * COMMIT, потом позиция» держит пакет, а не вызывающий.
   *
   * До COMMIT проверяется ИНВАРИАНТ, а не форма объекта: на этом соединении
   * открыта транзакция. Проверка — `SAVEPOINT`: вне транзакции Postgres отвечает
   * отказом 25P01, внутри — создаёт точку сохранения, которую COMMIT закоммитит
   * вместе со всем. Пул или обёртка над пулом отправили бы запрос на другое
   * соединение без транзакции — `TransactionNotOpenError`, и COMMIT не
   * отправляется вовсе (транзакция вызывающего остаётся открытой, а не
   * «закоммиченной» предупреждением на чужом соединении). Транзакция в ошибке
   * (25P02) завершается ROLLBACK — `TransactionNotCommittedError`; отказ самого
   * COMMIT — его исключение. SQLSTATE ищется и в цепочке `cause` (обёртки).
   *
   * Исключение значит «записи нет или неизвестно, что с ней»: транзакцию
   * вызывающий обязан завершить (`catch → ROLLBACK`), иначе соединение уйдёт в
   * пул с открытой транзакцией. Закрытый маршрутизатор COMMIT не отменяет:
   * исключение до COMMIT на штатном выключении оставляло бы транзакцию открытой, а
   * её запись закоммитил бы чужой COMMIT из пула. После `close()` — COMMIT как
   * обычно и токен «только мастер». Транзакция, которую SAVEPOINT застал
   * исправной, после COMMIT без исключения закоммичена — и драйвер без тега
   * ответа (`command`) не получает «откачена» (повтор записал бы дубль).
   */
  async commitAndIssueToken(client: SqlCommandExecutor & NotAPool): Promise<string> {
    ReplicaRouter.requireExecutor('commitAndIssueToken', client);
    let failedTransaction = false;
    try {
      await client.query('SAVEPOINT pg_replica_sync_commit');
    } catch (error) {
      const code = sqlStateOf(error);
      if (code === ReplicaRouter.NO_ACTIVE_TRANSACTION) {
        throw new TransactionNotOpenError();
      }
      if (code !== ReplicaRouter.IN_FAILED_TRANSACTION) {
        throw error;
      }
      failedTransaction = true;
    }
    if (failedTransaction) {
      // COMMIT Postgres выполнил бы как ROLLBACK; завершаем явно — соединение без транзакции.
      await client.query('ROLLBACK');
      throw new TransactionNotCommittedError('ROLLBACK');
    }
    const result = await client.query('COMMIT');
    if (result?.command === 'ROLLBACK') {
      throw new TransactionNotCommittedError('ROLLBACK');
    }
    return this.tokenAfterCommit(client);
  }

  /**
   * Куда читать. Токен отсутствует (`undefined`, `null`, пустая строка) —
   * реплика с отставанием в потолке. Токен есть — только догнавшая его реплика;
   * токен не разобрался — мастер. Не бросает на отказах узлов: отказ — это
   * исключение реплики и, в конце концов, мастер. Длится не дольше
   * `probeTimeoutMs + waitForCatchUpMs`.
   */
  async route(token?: string | null): Promise<RouteDecision<TTarget>> {
    this.assertOpen();
    const deadline = performance.now() + this.probeTimeoutMs + this.waitForCatchUpMs;
    return this.decide(await this.resolve(token, deadline));
  }

  /**
   * Подтвердить решение «реплика» на соединении, которым будет чтение: тот же
   * зонд и те же условия, но на сервере чтения. Нужен узлам-балансировщикам
   * (`balanced: true`, `decision.mustConfirm`): зонд маршрутизатора видел один
   * сервер, а соединение чтения могло попасть на другой. Решение «мастер» —
   * `true`. Отказ, потолок времени, «не смогли определить», закрытый
   * маршрутизатор — `false`: читать с мастера.
   */
  async confirm(decision: RouteDecision<TTarget>, executor: SqlQueryExecutor): Promise<boolean> {
    if (decision.role !== NODE_ROLE.replica) {
      return true;
    }
    const requirement = this.requirements.get(decision);
    if (requirement === undefined) {
      throw new TypeError('confirm: решение выдано не этим маршрутизатором');
    }
    ReplicaRouter.requireExecutor('confirm', executor);
    let reason: ExclusionReason | null;
    let failure: Error | undefined;
    try {
      if (this.closed) {
        // Решение получено до close(): чтение не роняется, а уходит на мастер.
        throw new Error('ReplicaRouter закрыт: подтверждения нет');
      }
      const rows = await this.queryWithin(executor);
      const state = this.withLastTimeline(decision.node, readNodeState(rows[0]), false);
      reason = evaluateReplica({ ok: true, state }, requirement);
    } catch (error) {
      failure = toError(error);
      reason = EXCLUSION_REASON.unavailable;
    }
    const confirmed = reason === null;
    if (reason === null) {
      this.counters.confirmed += 1;
    } else {
      this.counters.rejected += 1;
      this.counters.rejections.set(reason, (this.counters.rejections.get(reason) ?? 0) + 1);
    }
    notify(() => this.observer.confirmed, {
      decision: decision as RouteDecision<unknown>,
      confirmed,
      reason,
      ...(failure === undefined ? {} : { error: failure }),
    });
    return confirmed;
  }

  /** Счётчики; результат сериализуется `JSON.stringify` (отставание — число, не `bigint`). */
  stats(): RouterStats {
    return {
      reads: { replica: this.counters.replica, primary: this.counters.primary },
      reasons: Object.fromEntries(this.counters.reasons),
      exclusions: Object.fromEntries(this.counters.exclusions),
      probes: { ok: this.counters.probesOk, failed: this.counters.probesFailed },
      lagBytes: Object.fromEntries(
        [...this.counters.lag].map(([node, lag]) => [
          node,
          lag === null ? null : ReplicaRouter.toSafeNumber(lag),
        ]),
      ),
      expiredTokens: this.counters.expiredTokens,
      confirms: {
        confirmed: this.counters.confirmed,
        rejected: this.counters.rejected,
        reasons: Object.fromEntries(this.counters.rejections),
      },
    };
  }

  /**
   * Закрыть соединения зондов; они больше не открываются. Идущие `route()`
   * перестают ждать и зондировать и решают «мастер» по тому, что уже знают.
   * Соединения `target` принадлежат вызывающему.
   */
  async close(): Promise<void> {
    this.closed = true;
    this.closing.abort();
    await Promise.all([...this.connections.values()].map((connection) => connection.close()));
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }

  private static requireExecutor(method: string, executor: unknown): void {
    if (
      typeof executor !== 'object' ||
      executor === null ||
      typeof (executor as { query?: unknown }).query !== 'function'
    ) {
      throw new TypeError(
        `${method}: нужен executor — соединение мастера, на котором прошёл COMMIT (pg.Client, pg.PoolClient), или пул после возврата COMMIT`,
      );
    }
  }

  /**
   * Часы обязаны давать конечное число уже при создании: часы кэша, вернувшие
   * не-число, сделали бы кэш вечным (или отключили бы его), часы выдачи — токены
   * без срока. Ошибка настройки видна на старте, а не молчанием потолков.
   */
  private static requireClock(name: string, clock: Clock): void {
    if (typeof clock !== 'function') {
      throw new InvalidReplicaSyncOptionsError(`${name}: ожидается функция, получено ${typeof clock}`);
    }
    const value = clock();
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new InvalidReplicaSyncOptionsError(`${name}: часы вернули не конечное число (${String(value)})`);
    }
  }

  /**
   * Номер зонда в момент, когда процесс впервые увидел ПОЗИЦИЮ токена. Зонд с
   * большим номером начат после этого — значит, после выдачи токена с этой
   * позицией: позиция вставки мастера к его началу не меньше позиции токена
   * (если мастер не сменился), а «реплика отстаёт» в нём — не по снимку до
   * записи. Ключ — позиция, а не строка токена: токены одной позиции (разные
   * моменты выдачи) делят одну запись, и это верно — к выдаче любого из них
   * позиция вставки уже дошла до этой. Память ограничена (`POSITION_MEMORY`):
   * ключи приходят от клиентов. Вытесняется давно не встречавшаяся позиция (LRU),
   * а не первая вставленная: горячая позиция не уходит из-за потока новых.
   * Вытесненная при новой встрече считается новой — один лишний зонд и
   * консервативный ответ, а не ошибка.
   */
  private firstSeen(position: WalPosition): number {
    const key = `${position.systemId}/${position.timeline}/${position.lsn.toString(16)}`;
    const known = this.seenPositions.get(key);
    if (known !== undefined) {
      this.seenPositions.delete(key);
      this.seenPositions.set(key, known);
      return known;
    }
    if (this.seenPositions.size >= REPLICA_SYNC_DEFAULTS.POSITION_MEMORY) {
      const oldest = this.seenPositions.keys().next();
      if (oldest.done !== true) {
        this.seenPositions.delete(oldest.value);
      }
    }
    this.seenPositions.set(key, this.seq);
    return this.seq;
  }

  /**
   * Момент выдачи по `wallClock`. Часы, начавшие отдавать не то (не число,
   * отрицательное), не роняют выдачу токена ПОСЛЕ записи: момент — 0, то есть
   * «давно», а истечение всё равно требует доказанной невыполнимости.
   */
  private issuedAt(): number {
    const value = Math.floor(this.wallClock());
    return Number.isSafeInteger(value) && value >= 0 ? value : 0;
  }

  /** Токен после COMMIT: позиция с соединения записи, а при отказе или после `close()` — «только мастер». */
  private async tokenAfterCommit(executor: SqlQueryExecutor): Promise<string> {
    try {
      if (this.closed) {
        throw new Error('ReplicaRouter закрыт: токен «только мастер»');
      }
      const rows = await this.queryWithin(executor);
      return this.codec.encode(this.positionAfterCommit(rows[0]), this.issuedAt());
    } catch (error) {
      notify(() => this.observer.tokenUnresolved, { error: toError(error) });
      return this.codec.encode(null, this.issuedAt());
    }
  }

  private async resolve(token: string | null | undefined, deadline: number): Promise<RouteDecision<TTarget>> {
    if (this.replicas.length === 0) {
      return this.toPrimary(ROUTE_REASON.noReplicas, [], 0);
    }
    if (token === undefined || token === null || token === '') {
      return this.routeWithoutToken(deadline, false);
    }
    const decoded =
      typeof token === 'string'
        ? this.codec.decode(token)
        : { kind: 'invalid' as const, detail: 'не строка' };
    if (decoded.kind === 'invalid') {
      return this.toPrimary(ROUTE_REASON.tokenInvalid, [], 0);
    }
    if (decoded.kind === 'unresolved') {
      return this.toPrimary(ROUTE_REASON.tokenUnresolved, [], 0);
    }
    // Возраст по часам выдавшего и читающего: их расхождение сдвигает срок, но
    // само по себе ничего не решает — истекает только ДОКАЗАННО невыполнимый токен.
    const expired = this.issuedAt() - decoded.issuedAt > this.tokenTtlMs;
    const routed = await this.routeWithPosition(decoded.position, deadline, expired);
    if (expired && routed.unsatisfiable) {
      return this.routeExpired(deadline);
    }
    return routed.decision;
  }

  /** Токен старше `tokenTtlMs`, который после failover ни одна реплика выполнить не может: чтение как без токена. */
  private routeExpired(deadline: number): Promise<RouteDecision<TTarget>> {
    this.counters.expiredTokens += 1;
    return this.routeWithoutToken(deadline, true);
  }

  /**
   * Решение по позиции токена и признак «невыполнимость доказана» (для
   * истечения). `expired` — токен старше срока: тогда причина ухода на мастер
   * устанавливается по зонду мастера, начатому после первой встречи с позицией,
   * даже если в кэше есть более раннее состояние.
   */
  private async routeWithPosition(
    position: WalPosition,
    deadline: number,
    expired: boolean,
  ): Promise<{ readonly decision: RouteDecision<TTarget>; readonly unsatisfiable: boolean }> {
    const requirement: ReplicaRequirement = { kind: 'position', position };
    const seenSince = this.firstSeen(position);
    // Сначала — только кэш: догнавшая по кэшу реплика не требует зонда. Кэш живёт
    // не дольше `stateTtlMs` и теряет узел, соединение зонда которого оборвалось
    // (перезапуск реплики откатывает позицию воспроизведения).
    const cached = this.evaluateAll(requirement, (node) => this.cache.get(node.name)?.outcome);
    const fromCache = this.pick(cached);
    if (fromCache !== null) {
      return {
        decision: this.toReplica(fromCache, ROUTE_REASON.replicaCaughtUp, cached, 0, requirement),
        unsatisfiable: false,
      };
    }
    // Нет в кэше или отстаёт — свежий зонд; прочие исключения кэша живут до своего потолка.
    // Первые зонды ограничены своим потолком (`probeTimeoutMs`): гонка с потолком
    // чтения оборвала бы их ровно на нём же, раньше их собственного итога.
    let evaluated = await this.evaluateFresh(
      requirement,
      Number.POSITIVE_INFINITY,
      (outcome) => evaluateReplica(outcome, requirement) === EXCLUSION_REASON.behind,
      [],
      seenSince,
    );
    let polls = 0;
    let chosen = this.pick(evaluated);
    if (chosen === null && this.waitForCatchUpMs > 0 && this.anyBehind(evaluated)) {
      const waitUntil = Math.min(performance.now() + this.waitForCatchUpMs, deadline);
      while (chosen === null && this.anyBehind(evaluated)) {
        // Пауза прерывается close(): ожидание не тянется до своего потолка после закрытия.
        const pause = sleep(this.catchUpPollMs, undefined, { signal: this.closing.signal }).catch(
          () => undefined,
        );
        if ((await this.within(pause, waitUntil)) === null || this.closing.signal.aborted) {
          break;
        }
        polls += 1;
        const behind = new Set(
          evaluated.filter((entry) => entry.reason === EXCLUSION_REASON.behind).map((entry) => entry.node),
        );
        evaluated = await this.evaluateFresh(
          requirement,
          waitUntil,
          (_outcome, node) => behind.has(node),
          evaluated,
          seenSince,
        );
        chosen = this.pick(evaluated);
      }
    }
    if (chosen !== null) {
      return {
        decision: this.toReplica(chosen, ROUTE_REASON.replicaCaughtUp, evaluated, polls, requirement),
        unsatisfiable: false,
      };
    }
    const fallback = await this.fallbackReason(position, evaluated, deadline, seenSince, expired);
    return {
      decision: this.toPrimary(fallback.reason, this.exclusionsOf(evaluated), polls),
      unsatisfiable: fallback.proven && ReplicaRouter.UNSATISFIABLE.has(fallback.reason),
    };
  }

  /**
   * Без токена: состояние мастера (зонд ограничен своим потолком, а после
   * просроченного токена — остатком потолка чтения), затем реплики — к потолку чтения.
   */
  private async routeWithoutToken(
    deadline: number,
    primaryWithinDeadline: boolean,
  ): Promise<RouteDecision<TTarget>> {
    const sample = await this.within(
      this.state(this.primary),
      primaryWithinDeadline ? deadline : Number.POSITIVE_INFINITY,
    );
    const outcome = sample?.value.outcome;
    const state = outcome?.ok ? outcome.state : null;
    if (
      state === null ||
      state.inRecovery ||
      state.insertLsn === null ||
      state.timeline === null ||
      state.systemId === null
    ) {
      return this.toPrimary(ROUTE_REASON.primaryStateUnknown, [], 0);
    }
    const requirement: ReplicaRequirement = {
      kind: 'lag',
      systemId: state.systemId,
      timeline: state.timeline,
      primaryInsertLsn: state.insertLsn,
      maxLagBytes: this.maxLagBytes,
    };
    const evaluated = await this.evaluateFresh(requirement, deadline, () => false);
    const chosen = this.pick(evaluated);
    if (chosen !== null) {
      return this.toReplica(chosen, ROUTE_REASON.replicaWithinLag, evaluated, 0, requirement);
    }
    return this.toPrimary(ROUTE_REASON.noReplicaEligible, this.exclusionsOf(evaluated), 0);
  }

  /**
   * Почему мастер: по исключениям и (если удаётся) по состоянию мастера.
   * «Токен впереди мастера» называется только по состоянию из зонда, начатого
   * ПОСЛЕ первой встречи процесса с позицией токена: токен выдан до этого, и
   * мастер, снятый раньше, законно позади него. Свежего состояния нет (потолок
   * чтения, отказ) — `no-replica-eligible`, а не ложная тревога.
   *
   * `proven` — причина установлена таким состоянием (или каждая реплика —
   * другой кластер): только тогда просроченный токен истекает. Кэш мастера,
   * снятый до первой встречи с позицией, ничего не доказывает, сколько бы ему ни
   * было и как бы ни расходились часы процессов. `requireFresh` (просроченный
   * токен) — такое состояние добывается зондом, даже если кэш говорит «позади».
   */
  private async fallbackReason(
    position: WalPosition,
    evaluated: readonly Evaluated<TTarget>[],
    deadline: number,
    seenSince: number,
    requireFresh: boolean,
  ): Promise<{ readonly reason: RouteReason; readonly proven: boolean }> {
    if (evaluated.length > 0 && evaluated.every((entry) => entry.reason === EXCLUSION_REASON.otherCluster)) {
      return { reason: ROUTE_REASON.tokenForeign, proven: true };
    }
    const cached = this.cache.get(this.primary.name);
    let state: NodeState | null =
      cached?.outcome.ok && !cached.outcome.state.inRecovery ? cached.outcome.state : null;
    let after = cached !== undefined && cached.seq > seenSince;
    if (state === null || ReplicaRouter.ahead(position, state) || (requireFresh && !after)) {
      const sample = await this.within(
        this.state(this.primary, { maxAgeMs: this.minProbeIntervalMs, startedAfterSeq: seenSince }),
        deadline,
      );
      const outcome = sample?.value.outcome;
      if (sample === null || outcome === undefined || !outcome.ok || outcome.state.inRecovery) {
        return { reason: ROUTE_REASON.noReplicaEligible, proven: false };
      }
      state = outcome.state;
      after = sample.value.seq > seenSince;
    }
    if (state.systemId !== null && state.systemId !== position.systemId) {
      return { reason: ROUTE_REASON.tokenForeign, proven: after };
    }
    if (state.timeline !== null && state.timeline !== position.timeline) {
      return { reason: ROUTE_REASON.tokenOtherTimeline, proven: after };
    }
    if (ReplicaRouter.ahead(position, state) && after) {
      return { reason: ROUTE_REASON.tokenAheadOfPrimary, proven: true };
    }
    return { reason: ROUTE_REASON.noReplicaEligible, proven: false };
  }

  /** Байты отставания числом: JSON-сериализуемо; больше 2⁵³ (8 ПиБ WAL) — потолок, а не потеря точности молча. */
  private static toSafeNumber(value: bigint): number {
    return value > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(value);
  }

  private static ahead(position: WalPosition, primary: NodeState): boolean {
    return (
      primary.systemId === position.systemId &&
      primary.timeline === position.timeline &&
      primary.insertLsn !== null &&
      compareLsn(position.lsn, primary.insertLsn) > 0
    );
  }

  private evaluateAll(
    requirement: ReplicaRequirement,
    outcomeOf: (node: ReplicaNode<TTarget>) => ProbeOutcome | undefined,
  ): Evaluated<TTarget>[] {
    return this.replicas.flatMap((node) => {
      const outcome = outcomeOf(node);
      return outcome === undefined
        ? []
        : [{ node: node.name, replica: node, reason: evaluateReplica(outcome, requirement) }];
    });
  }

  /**
   * Состояние каждой реплики, параллельно: из кэша, или свежим зондом, если в
   * кэше нет или `needsProbe` (с потолком частоты). Отказ, ещё живущий в кэше,
   * не опрашивается заново до своего потолка. Зонд, не успевший к `deadline`,
   * — прежняя оценка узла из `previous` (опрос во время ожидания), а без неё —
   * `unavailable` для этого чтения; сам зонд доживает до своего потолка и
   * попадает в кэш.
   */
  private async evaluateFresh(
    requirement: ReplicaRequirement,
    deadline: number,
    needsProbe: (cached: ProbeOutcome, node: string) => boolean,
    previous: readonly Evaluated<TTarget>[] = [],
    tokenSeenSince?: number,
  ): Promise<Evaluated<TTarget>[]> {
    const outcomes = await Promise.all(
      this.replicas.map(async (node): Promise<ProbeOutcome | null> => {
        const cached = this.cache.get(node.name)?.outcome;
        if (cached !== undefined && (!cached.ok || !needsProbe(cached, node.name))) {
          return cached;
        }
        const sample = await this.within(
          this.state(node, {
            maxAgeMs: this.minProbeIntervalMs,
            ...(tokenSeenSince === undefined ? {} : { startedAfterSeq: tokenSeenSince }),
          }),
          deadline,
        );
        return sample === null ? null : sample.value.outcome;
      }),
    );
    const evaluated = this.replicas.map((node, index): Evaluated<TTarget> => {
      const outcome = outcomes[index] ?? null;
      if (outcome !== null) {
        return { node: node.name, replica: node, reason: evaluateReplica(outcome, requirement) };
      }
      const before = previous.find((entry) => entry.node === node.name);
      return before ?? { node: node.name, replica: node, reason: EXCLUSION_REASON.unavailable };
    });
    this.recordLag(outcomes);
    return evaluated;
  }

  private recordLag(outcomes: readonly (ProbeOutcome | null | undefined)[]): void {
    const primary = this.cache.get(this.primary.name)?.outcome;
    const insertLsn = primary?.ok && !primary.state.inRecovery ? primary.state.insertLsn : null;
    this.replicas.forEach((node, index) => {
      const outcome = outcomes[index];
      const replay = outcome?.ok && outcome.state.inRecovery ? outcome.state.replayLsn : null;
      if (insertLsn !== null && replay !== null) {
        this.counters.lag.set(node.name, lagBytes(insertLsn, replay));
      } else if (outcome !== undefined && outcome !== null && !outcome.ok) {
        this.counters.lag.set(node.name, null);
      }
    });
  }

  /**
   * Состояние узла: из кэша или зонд. Одновременные вызовы по одному узлу ждут
   * ОДИН зонд. `maxAgeMs` — кэш годится, только если его зонд начат не раньше
   * стольких мс назад (потолок частоты: моложе — повторного зонда нет), а с
   * `startedAfterSeq` — ещё и только если зонд начат ПОСЛЕ того, как этот
   * процесс впервые увидел токен: зонд, снятый раньше, о записи токена ничего не
   * говорит, и чтение сразу после своей записи получает свежий зонд, а не
   * «отстаёт» по чужому. То же — для идущего зонда: начатый раньше не годится,
   * его дожидаются и зондируют снова. Часы не участвуют: расхождение часов
   * процессов не снимает потолок и не отдаёт чужой зонд.
   * Отказ из кэша годится всегда — до своего потолка.
   */
  private state(
    node: ReplicaNode<TTarget>,
    freshness: { readonly maxAgeMs?: number; readonly startedAfterSeq?: number } = {},
  ): Promise<ProbeSample> {
    const entry = this.cache.get(node.name);
    if (
      entry !== undefined &&
      (!entry.outcome.ok ||
        freshness.maxAgeMs === undefined ||
        (performance.now() - entry.startedAt < freshness.maxAgeMs &&
          (freshness.startedAfterSeq === undefined || entry.seq > freshness.startedAfterSeq)))
    ) {
      return Promise.resolve({ outcome: entry.outcome, seq: entry.seq });
    }
    const running = this.inflight.get(node.name);
    if (running !== undefined) {
      const runningSeq = this.inflightSeq.get(node.name) ?? 0;
      if (freshness.startedAfterSeq === undefined || runningSeq > freshness.startedAfterSeq) {
        return running;
      }
      // Идущий зонд начат до первой встречи с позицией: о её записи он ничего не
      // говорит. Дождаться его (один зонд узла за раз) и решить заново: следующий
      // начнётся после — или к нему присоединится.
      return running.then(() => this.state(node, freshness));
    }
    this.seq += 1;
    const seq = this.seq;
    const probe = this.probe(node, seq).finally(() => {
      if (this.inflightSeq.get(node.name) === seq) {
        this.inflight.delete(node.name);
        this.inflightSeq.delete(node.name);
      }
    });
    this.inflight.set(node.name, probe);
    this.inflightSeq.set(node.name, seq);
    return probe;
  }

  private async probe(node: ReplicaNode<TTarget>, seq: number): Promise<ProbeSample> {
    const startedAt = performance.now();
    let outcome: ProbeOutcome;
    try {
      const rows = await this.connectionOf(node.name).query(PROBE_SQL.STATE);
      outcome = { ok: true, state: this.withLastTimeline(node.name, readNodeState(rows[0]), true) };
      this.counters.probesOk += 1;
    } catch (error) {
      outcome = { ok: false, error: toError(error) };
      this.counters.probesFailed += 1;
    }
    if (!this.closed) {
      this.cache.set(node.name, outcome, { seq, startedAt });
    }
    notify(() => this.observer.probed, {
      node: node.name,
      outcome,
      durationMs: performance.now() - startedAt,
    });
    return { outcome, seq };
  }

  /**
   * Линия времени реплики, у которой не работает приёмник WAL (мастер лежит или
   * недоступен): та, что приёмник показывал у ЭТОГО ЖЕ экземпляра сервера
   * (перезапуск — другой экземпляр, и прежнее знание не переносится). Сменить
   * линию времени реплика может, только последовав за новым мастером, — то есть
   * после failover, где запись, потерянная при нём, не видна и на новом мастере.
   * Подстановка не зависит от права на `pg_stat_wal_receiver`: без него линия
   * времени не видна никогда, и подставлять нечего — остаётся «нет прав».
   */
  private withLastTimeline(node: string, state: NodeState, remember: boolean): NodeState {
    if (!state.inRecovery || state.instance === null) {
      return state;
    }
    if (state.timeline !== null) {
      if (remember) {
        this.lastTimeline.set(node, { instance: state.instance, timeline: state.timeline });
      }
      return state;
    }
    const known = this.lastTimeline.get(node);
    return known !== undefined && known.instance === state.instance
      ? { ...state, timeline: known.timeline }
      : state;
  }

  /** Позиция после COMMIT на соединении записи: всё «не смогли определить» — исключение. */
  private positionAfterCommit(row: unknown): WalPosition {
    const state = readNodeState(row);
    if (state.inRecovery) {
      throw new Error(`узел ${this.primary.name} в recovery: это не мастер`);
    }
    if (state.writePending) {
      throw new Error('транзакция с записью ещё не закоммичена: позиция её коммита неизвестна');
    }
    if (state.tokenLsn === null || state.timeline === null || state.systemId === null) {
      throw new Error('позиция, линия времени или идентификатор кластера не определились');
    }
    return { systemId: state.systemId, timeline: state.timeline, lsn: state.tokenLsn };
  }

  private async queryWithin(executor: SqlQueryExecutor): Promise<readonly unknown[]> {
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`состояние узла не определилось за ${this.probeTimeoutMs} мс`)),
        this.probeTimeoutMs,
      );
    });
    try {
      return (await Promise.race([executor.query(PROBE_SQL.STATE), deadline])).rows;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * `work` или `null`, если не успело к `deadline` (монотонные часы) или
   * маршрутизатор закрыт. Уже готовое значение успевает и при исчерпанном потолке;
   * бесконечный `deadline` — без таймера (`setTimeout(Infinity)` сработал бы через 1 мс).
   */
  private async within<T>(work: Promise<T>, deadline: number): Promise<{ readonly value: T } | null> {
    if (this.closing.signal.aborted) {
      work.catch(() => undefined);
      return null;
    }
    let timer: NodeJS.Timeout | undefined;
    let abort: (() => void) | undefined;
    const late = new Promise<null>((resolve) => {
      if (Number.isFinite(deadline)) {
        timer = setTimeout(() => resolve(null), Math.max(0, deadline - performance.now()));
      }
      abort = () => resolve(null);
      this.closing.signal.addEventListener('abort', abort, { once: true });
    });
    try {
      return await Promise.race([work.then((value) => ({ value })), late]);
    } finally {
      clearTimeout(timer);
      if (abort !== undefined) {
        this.closing.signal.removeEventListener('abort', abort);
      }
    }
  }

  private connectionOf(name: string): ProbeConnection {
    const connection = this.connections.get(name);
    if (connection === undefined) {
      throw new Error(`нет соединения зонда для узла ${name}`);
    }
    return connection;
  }

  private anyBehind(evaluated: readonly Evaluated<TTarget>[]): boolean {
    return evaluated.some((entry) => entry.reason === EXCLUSION_REASON.behind);
  }

  /** Подходящие — по кругу: нагрузка делится между догнавшими репликами. */
  private pick(evaluated: readonly Evaluated<TTarget>[]): ReplicaNode<TTarget> | null {
    const eligible = evaluated.filter((entry) => entry.reason === null);
    if (eligible.length === 0) {
      return null;
    }
    const chosen = eligible[this.turn % eligible.length];
    this.turn = (this.turn + 1) % Number.MAX_SAFE_INTEGER;
    return chosen?.replica ?? null;
  }

  private exclusionsOf(evaluated: readonly Evaluated<TTarget>[]): Exclusion[] {
    return evaluated.flatMap((entry) =>
      entry.reason === null ? [] : [{ node: entry.node, reason: entry.reason }],
    );
  }

  private toReplica(
    replica: ReplicaNode<TTarget>,
    reason: RouteReason,
    evaluated: readonly Evaluated<TTarget>[],
    polls: number,
    requirement: ReplicaRequirement,
  ): RouteDecision<TTarget> {
    const decision: RouteDecision<TTarget> = {
      role: NODE_ROLE.replica,
      node: replica.name,
      target: replica.target,
      reason,
      excluded: this.exclusionsOf(evaluated),
      catchUpPolls: polls,
      mustConfirm: replica.balanced === true,
    };
    this.requirements.set(decision, requirement);
    return decision;
  }

  private toPrimary(
    reason: RouteReason,
    excluded: readonly Exclusion[],
    polls: number,
  ): RouteDecision<TTarget> {
    return {
      role: NODE_ROLE.primary,
      node: this.primary.name,
      target: this.primary.target,
      reason,
      excluded,
      catchUpPolls: polls,
      mustConfirm: false,
    };
  }

  /** Единственная точка учёта решения: счётчики и хук — ровно по одному разу на `route()`. */
  private decide(decision: RouteDecision<TTarget>): RouteDecision<TTarget> {
    if (decision.role === NODE_ROLE.replica) {
      this.counters.replica += 1;
    } else {
      this.counters.primary += 1;
    }
    this.counters.reasons.set(decision.reason, (this.counters.reasons.get(decision.reason) ?? 0) + 1);
    for (const { reason } of decision.excluded) {
      this.counters.exclusions.set(reason, (this.counters.exclusions.get(reason) ?? 0) + 1);
    }
    notify(() => this.observer.routed, decision as RouteDecision<unknown>);
    return decision;
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new Error('ReplicaRouter закрыт');
    }
  }
}
