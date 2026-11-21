import type { CacheEntry } from './types/cache-entry.type';
import type { Clock } from './types/clock.type';
import type { ProbeOutcome } from './types/probe-outcome.type';

/**
 * Кэш состояния узлов с потолком жизни. Потолок проверяется не только на
 * чтении: просроченные записи ВЫСЕЛЯЮТСЯ при каждом обращении, а ключи — только
 * узлы из настройки, поэтому кэш не растёт ни от времени, ни от ввода.
 * Отказ зонда живёт своё время (`failureTtlMs`): недоступный узел не опрашивается
 * на каждом чтении, и замёрзший узел не задерживает каждый запрос на потолок зонда.
 * `delete` — соединение зонда узла потеряно (перезапуск сервера): снятое через
 * него состояние больше ничего не доказывает и не доживает до потолка.
 *
 * Часы кэша приходят снаружи (опция `clock`) и могут шагнуть назад (NTP, часы
 * стенда) или вернуть не-число. Потолок записи отсчитан по прежним часам, и после
 * шага назад на час она жила бы лишний час — пауза или промоция узла не
 * замечались бы. Поэтому шаг назад и не-число выселяют ВСЕ записи, а запись по
 * не-числу не кладётся: кэша нет, пока часы не вернут конечное значение.
 */
export class StateCache {
  private readonly entries = new Map<string, CacheEntry>();
  private last = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly nodes: ReadonlySet<string>,
    private readonly successTtlMs: number,
    private readonly failureTtlMs: number,
    private readonly clock: Clock,
  ) {}

  get(node: string): CacheEntry | undefined {
    this.evictExpired();
    return this.entries.get(node);
  }

  set(
    node: string,
    outcome: ProbeOutcome,
    probe: { readonly seq: number; readonly startedAt: number },
  ): void {
    if (!this.nodes.has(node)) {
      throw new Error(`узел ${JSON.stringify(node)} не из настройки маршрутизатора`);
    }
    const now = this.evictExpired();
    if (now === null) {
      return;
    }
    const ttl = outcome.ok ? this.successTtlMs : this.failureTtlMs;
    this.entries.set(node, {
      outcome,
      expiresAt: now + ttl,
      seq: probe.seq,
      startedAt: probe.startedAt,
    });
  }

  delete(node: string): void {
    this.entries.delete(node);
  }

  /** Число живых записей — для спек: выселение видно без доступа к внутренностям. */
  get size(): number {
    this.evictExpired();
    return this.entries.size;
  }

  /** Выселить просроченное; вернуть «сейчас» по часам кэша или `null`, если часы не дали числа. */
  private evictExpired(): number | null {
    const now = this.clock();
    if (!Number.isFinite(now)) {
      this.entries.clear();
      return null;
    }
    if (now < this.last) {
      this.entries.clear();
    }
    this.last = now;
    for (const [node, entry] of this.entries) {
      if (entry.expiresAt <= now) {
        this.entries.delete(node);
      }
    }
    return now;
  }
}
