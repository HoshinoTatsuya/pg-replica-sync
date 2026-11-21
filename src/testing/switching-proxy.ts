import { connect, createServer, type Server, type Socket } from 'node:net';

/**
 * TCP-прокси, который каждое НОВОЕ соединение отправляет на выбранный сервер:
 * по кругу (`roundRobin` — балансировщик над репликами) или на заданный
 * (`target(i)` — тот же адрес после перезапуска оказался другим сервером).
 * Уже открытые соединения остаются на своём сервере.
 */
export class SwitchingProxy {
  private next = 0;
  private fixed: number | null = null;
  private readonly sockets = new Set<Socket>();

  private constructor(
    private readonly server: Server,
    private readonly targets: readonly { readonly host: string; readonly port: number }[],
  ) {}

  static async start(targetUrls: readonly string[]): Promise<SwitchingProxy> {
    const targets = targetUrls.map((url) => {
      const parsed = new URL(url);
      return { host: parsed.hostname, port: Number(parsed.port) };
    });
    let proxy: SwitchingProxy | undefined;
    const server = createServer((client) => proxy?.pipe(client));
    proxy = new SwitchingProxy(server, targets);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return proxy;
  }

  get port(): number {
    const address = this.server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('прокси не слушает');
    }
    return address.port;
  }

  /** Адрес узла через прокси под другой ролью/базой исходного адреса. */
  urlFor(templateUrl: string): string {
    const parsed = new URL(templateUrl);
    parsed.hostname = '127.0.0.1';
    parsed.port = String(this.port);
    return parsed.toString();
  }

  /** Новые соединения — на сервер с этим номером; `null` — снова по кругу. */
  target(index: number | null): void {
    this.fixed = index;
  }

  async close(): Promise<void> {
    for (const socket of this.sockets) {
      socket.destroy();
    }
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private pipe(client: Socket): void {
    const index = this.fixed ?? this.next++ % this.targets.length;
    const target = this.targets[index];
    if (target === undefined) {
      client.destroy();
      return;
    }
    const upstream = connect(target.port, target.host);
    this.sockets.add(client);
    this.sockets.add(upstream);
    client.pipe(upstream);
    upstream.pipe(client);
    const drop = (): void => {
      client.destroy();
      upstream.destroy();
      this.sockets.delete(client);
      this.sockets.delete(upstream);
    };
    client.on('error', drop);
    upstream.on('error', drop);
    client.on('close', drop);
    upstream.on('close', drop);
  }
}
