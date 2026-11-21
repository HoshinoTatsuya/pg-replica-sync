import { createServer } from 'node:net';

/** Порт, на котором заведомо никто не слушает: занять и отпустить. */
export async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (address === null || typeof address === 'string') {
    throw new Error('порт не определился');
  }
  return address.port;
}
