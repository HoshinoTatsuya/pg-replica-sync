import { setImmediate as yieldMacrotask } from 'node:timers/promises';

import { notify } from './notify';

/**
 * Отказ хука наблюдателя не роняет ни решение, ни процесс: синхронный throw
 * глушится, отказ `async`-хука — тоже (без обработчика он был бы
 * `unhandledRejection`, по умолчанию — падение процесса). Jest сам ловит
 * необработанный отказ и роняет им тест, в котором он случился, поэтому
 * первая проверка краснеет и без слушателя; третья проверяет сам механизм —
 * обработчик отказа у результата хука.
 */
describe('хук наблюдателя', () => {
  const unhandled: unknown[] = [];
  const listener = (reason: unknown): void => {
    unhandled.push(reason);
  };

  beforeEach(() => {
    unhandled.length = 0;
    process.on('unhandledRejection', listener);
  });

  afterEach(() => {
    process.off('unhandledRejection', listener);
  });

  it('async-хук с отказом — ни исключения, ни unhandledRejection', async () => {
    const calls: number[] = [];
    expect(() =>
      notify(
        () => async (value: number) => {
          calls.push(value);
          throw new Error('хук упал');
        },
        7,
      ),
    ).not.toThrow();
    // Отказ промиса и событие unhandledRejection доходят за несколько макрозадач.
    for (let i = 0; i < 5; i += 1) {
      await yieldMacrotask();
    }
    expect(calls).toEqual([7]);
    expect(unhandled).toEqual([]);
  });

  it('синхронный throw — проглочен; хука нет — ничего', async () => {
    expect(() =>
      notify(
        () => () => {
          throw new Error('хук упал');
        },
        1,
      ),
    ).not.toThrow();
    expect(() => notify(() => undefined, 1)).not.toThrow();
    await yieldMacrotask();
    expect(unhandled).toEqual([]);
  });

  it('результат хука не thenable (число, строка, объект с then не функцией, null) — без обращения к нему', () => {
    // biome-ignore lint/suspicious/noThenProperty: then не функция — предмет проверки
    const thenNotFunction = { then: 5 };
    for (const result of [1, 'x', null, thenNotFunction, Object.freeze({})]) {
      expect(() => notify(() => () => result, 1)).not.toThrow();
    }
  });

  it('у результата-thenable хука notify ставит обработчик отказа (иначе его отказ некому принять)', () => {
    const handlers: unknown[] = [];
    const thenable = {
      // biome-ignore lint/suspicious/noThenProperty: подделка thenable — предмет проверки
      then(onFulfilled?: unknown, onRejected?: unknown) {
        handlers.push(onFulfilled, onRejected);
        return thenable;
      },
    };
    notify(() => () => thenable, 1);
    expect(handlers.length).toBe(2);
    expect(typeof handlers[1]).toBe('function');
  });

  it('свойство хука — бросающий геттер: проглочено, хук не вызван', () => {
    const observer = Object.defineProperty({}, 'routed', {
      get(): never {
        throw new Error('геттер упал');
      },
    }) as { readonly routed?: (value: number) => void };
    expect(() => notify(() => observer.routed, 1)).not.toThrow();
  });
});
