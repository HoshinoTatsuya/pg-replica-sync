/**
 * Вызвать хук наблюдателя; его отказ маршрутизацию не роняет. Хук может быть
 * `async`: тогда отказ приходит отклонённым промисом, а не исключением, и без
 * обработчика стал бы `unhandledRejection` — по умолчанию это падение процесса.
 * Поэтому у возвращённого промиса (любого thenable) отказ тоже глушится.
 * Хук читается функцией `read` ВНУТРИ защиты: свойство наблюдателя может быть
 * геттером (прокси, ленивый объект метрик), и его исключение — тоже отказ
 * наблюдателя, а не решения.
 */
export function notify<T>(read: () => ((event: T) => unknown) | undefined, event: T): void {
  try {
    const hook = read();
    if (typeof hook !== 'function') {
      return;
    }
    const result = hook(event);
    if (
      typeof result === 'object' &&
      result !== null &&
      typeof (result as PromiseLike<unknown>).then === 'function'
    ) {
      (result as PromiseLike<unknown>).then(undefined, () => undefined);
    }
  } catch {
    // наблюдатель — не часть решения
  }
}
