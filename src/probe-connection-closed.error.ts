/** Зонд после `close()`: соединение больше не открывается. */
export class ProbeConnectionClosedError extends Error {
  override readonly name = 'ProbeConnectionClosedError';

  constructor(readonly node: string) {
    super(`соединение зонда узла ${node} закрыто: маршрутизатор закрыт`);
  }
}
