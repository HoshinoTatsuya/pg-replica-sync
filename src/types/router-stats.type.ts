import type { ExclusionReason } from './exclusion-reason.type';
import type { RouteReason } from './route-reason.type';

/**
 * Счётчики с момента создания маршрутизатора: доля чтений с реплик и мастера,
 * причины, отставание. Отставание — последнее измеренное (байт WAL от позиции
 * вставки мастера, число; больше 2⁵³ − 1 — этот потолок), `null` — ещё не
 * измерено или не определилось. Объект сериализуется `JSON.stringify` как есть.
 */
export interface RouterStats {
  readonly reads: { readonly replica: number; readonly primary: number };
  readonly reasons: Readonly<Partial<Record<RouteReason, number>>>;
  readonly exclusions: Readonly<Partial<Record<ExclusionReason, number>>>;
  readonly probes: { readonly ok: number; readonly failed: number };
  readonly lagBytes: Readonly<Record<string, number | null>>;
  /** Токены старше `tokenTtlMs`, которые иначе держали бы чтение на мастере, — прочитаны как без токена. */
  readonly expiredTokens: number;
  /**
   * `confirm` на соединении чтения: подтверждено / отклонено и почему. Решение
   * «реплика», отклонённое здесь, в `reads.replica` уже посчитано — чтение
   * ушло на мастер; без этого счётчика доля мастера была бы не видна.
   */
  readonly confirms: {
    readonly confirmed: number;
    readonly rejected: number;
    readonly reasons: Readonly<Partial<Record<ExclusionReason, number>>>;
  };
}
