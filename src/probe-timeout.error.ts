/** Зонд узла не уложился в потолок: соединение оборвано, узел считается недоступным. */
export class ProbeTimeoutError extends Error {
  override readonly name = 'ProbeTimeoutError';

  constructor(
    readonly node: string,
    readonly timeoutMs: number,
  ) {
    super(`зонд узла ${node} не ответил за ${timeoutMs} мс`);
  }
}
