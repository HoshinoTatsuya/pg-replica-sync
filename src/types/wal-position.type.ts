/**
 * Позиция в WAL конкретного кластера на конкретной линии времени. Одна позиция
 * без линии времени после failover ничего не значит: на новой линии те же
 * номера означают другие записи.
 */
export interface WalPosition {
  /** `pg_control_system().system_identifier` — общий у мастера и его реплик. */
  readonly systemId: string;
  readonly timeline: number;
  /** 64-битная позиция (`X/Y` → X·2³² + Y). */
  readonly lsn: bigint;
}
