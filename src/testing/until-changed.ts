import { setTimeout as sleep } from 'node:timers/promises';

/**
 * Повторять `read`, пока `still(значение)` верно, но не дольше `ceilingMs`;
 * вернуть последнее значение. Для того, что доходит асинхронно (обрыв
 * соединения сервером — до клиента). Потолок по времени, а не по числу опытов;
 * не дождались — возвращается прежнее значение, и утверждение спеки краснеет
 * им, а не таймаутом jest.
 */
export async function untilChanged<T>(
  read: () => Promise<T>,
  still: (value: T) => boolean,
  ceilingMs = 3_000,
): Promise<T> {
  const deadline = Date.now() + ceilingMs;
  let value = await read();
  while (still(value) && Date.now() < deadline) {
    await sleep(50);
    value = await read();
  }
  return value;
}
