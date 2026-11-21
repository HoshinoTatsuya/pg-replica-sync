import { Client, type ClientConfig } from 'pg';

import { REPLICA_SYNC_DEFAULTS } from './constants/replica-sync-defaults.constant';
import { destroyClient } from './destroy-client';
import { ProbeConnectionClosedError } from './probe-connection-closed.error';
import { ProbeTimeoutError } from './probe-timeout.error';

/**
 * Своё соединение зонда к узлу: ленивое, одно. У зонда два потолка:
 *
 * - `timeoutMs` — потолок ОДНОГО зонда (установка соединения и запрос вместе):
 *   не уложился — отказ этого зонда;
 * - `connectTimeoutMs` — потолок жизни соединения, которое не установилось или
 *   запрос на котором не ответил (с начала установки или запроса). Зонд, отказавший
 *   по своему потолку, соединение НЕ рвёт: установка и запрос доживают до этого
 *   потолка. Медленная, но живая реплика (установка — несколько RTT, дольше
 *   потолка зонда) так получает готовое соединение к следующему зонду, а не
 *   начинает установку заново навсегда; замёрзшая не отвечает и к этому потолку —
 *   соединение рвётся, следующий зонд открывает новое.
 *
 * Отказ соединения (не потолок) — закрывается именно ТО соединение, на котором
 * был запрос: отказ старого запроса не рвёт уже новое здоровое. Потеря соединения
 * не по нашей воле (сервер перезапущен, сеть оборвана) — `onLost`: состояние,
 * снятое через него, больше ничего не доказывает. После `close()` соединение
 * больше не открывается: запрос — отказ сразу.
 */
export class ProbeConnection {
  private client: Client | null = null;
  private ready: Promise<Client> | null = null;
  private closed = false;

  constructor(
    private readonly node: string,
    private readonly connection: string | ClientConfig,
    private readonly timeoutMs: number,
    private readonly onLost: () => void = () => undefined,
    private readonly connectTimeoutMs: number = REPLICA_SYNC_DEFAULTS.CONNECT_TIMEOUT_MS,
  ) {}

  async query(text: string): Promise<readonly unknown[]> {
    if (this.closed) {
      throw new ProbeConnectionClosedError(this.node);
    }
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new ProbeTimeoutError(this.node, this.timeoutMs)), this.timeoutMs);
    });
    const { client, ready } = this.connected();
    let pending: Promise<unknown> | null = null;
    try {
      const connected = await Promise.race([ready, deadline]);
      const running = connected.query(text);
      pending = running;
      const result = await Promise.race([running, deadline]);
      return result.rows;
    } catch (error) {
      if (!(error instanceof ProbeTimeoutError)) {
        this.discard(client);
      } else if (pending !== null) {
        this.expireIfSilent(client, pending);
      }
      // Потолок зонда во время установки: установку ограничивает свой таймер (`connected`).
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Закрыть и больше не открывать. Идущая установка соединения тоже обрывается. */
  async close(): Promise<void> {
    this.closed = true;
    const client = this.client;
    this.client = null;
    this.ready = null;
    if (client === null) {
      return;
    }
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, this.timeoutMs);
    });
    try {
      await Promise.race([client.end().catch(() => undefined), deadline]);
    } finally {
      clearTimeout(timer);
      destroyClient(client);
    }
  }

  /**
   * Запрос не уложился в потолок зонда: соединение живёт, пока запрос не ответит,
   * но не дольше `connectTimeoutMs` с его начала (потолок зонда уже прошёл).
   */
  private expireIfSilent(client: Client, pending: Promise<unknown>): void {
    const timer = setTimeout(() => this.discard(client), Math.max(0, this.connectTimeoutMs - this.timeoutMs));
    // Таймер уборки не держит процесс: соединение и так закроет close().
    timer.unref();
    const settle = (): void => clearTimeout(timer);
    pending.then(settle, settle);
  }

  private connected(): { client: Client; ready: Promise<Client> } {
    if (this.client !== null && this.ready !== null) {
      return { client: this.client, ready: this.ready };
    }
    const config: ClientConfig =
      typeof this.connection === 'string'
        ? { connectionString: this.connection, application_name: REPLICA_SYNC_DEFAULTS.APPLICATION_NAME }
        : { application_name: REPLICA_SYNC_DEFAULTS.APPLICATION_NAME, ...this.connection };
    const client = new Client(config);
    // Обрыв простаивающего соединения сервером — событие error: без слушателя оно роняет процесс.
    client.on('error', () => this.lose(client));
    client.on('end', () => this.lose(client));
    this.client = client;
    // Установка, не завершившаяся за свой потолок, обрывается (замёрзший узел).
    const connectTimer = setTimeout(() => this.discard(client), this.connectTimeoutMs);
    connectTimer.unref();
    const ready = client.connect().then(() => client);
    // Отказ установки после потолка зонда некому принять: без обработчика — unhandled rejection.
    ready.then(
      () => clearTimeout(connectTimer),
      () => {
        clearTimeout(connectTimer);
        this.discard(client);
      },
    );
    this.ready = ready;
    return { client, ready };
  }

  /** Соединение потеряно не по нашей воле: сообщить, если это было текущее соединение. */
  private lose(target: Client): void {
    const current = this.client === target;
    this.discard(target);
    if (current && !this.closed) {
      this.onLost();
    }
  }

  /** Закрыть ровно `target`; текущим оно перестаёт быть, только если им и было. */
  private discard(target: Client): void {
    if (this.client === target) {
      this.client = null;
      this.ready = null;
    }
    destroyClient(target);
  }
}
