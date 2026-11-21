import { randomBytes } from 'node:crypto';

import { smallestPeriod } from './smallest-period';

/** Сверка с определением «`b[i] === b[i % p]` для всех i» перебором — на всех строках до длины 9 над {a, b}. */
const byDefinition = (bytes: Buffer): number => {
  for (let period = 1; period < bytes.length; period += 1) {
    if (bytes.every((byte, index) => byte === bytes[index % period])) {
      return period;
    }
  }
  return bytes.length;
};

describe('наименьший период', () => {
  it('совпадает с определением на каждой строке до длины 9 над двумя символами', () => {
    let checked = 0;
    for (let length = 1; length <= 9; length += 1) {
      for (let mask = 0; mask < 2 ** length; mask += 1) {
        const bytes = Buffer.from(Array.from({ length }, (_, i) => ((mask >> i) & 1 ? 98 : 97)));
        expect([bytes.toString(), smallestPeriod(bytes)]).toEqual([bytes.toString(), byDefinition(bytes)]);
        checked += 1;
      }
    }
    expect(checked).toBe(1_022);
  });

  it('пустой ключ — 0, без периода — длина, неполный последний повтор — период', () => {
    expect(smallestPeriod(Buffer.alloc(0))).toBe(0);
    expect(smallestPeriod(Buffer.from('abcd'))).toBe(4);
    expect(smallestPeriod(Buffer.from('abcab'))).toBe(3);
  });

  it('линейна: на 4096 случайных байтах — не больше 4n чтений байта (перебор периодов — ≈ n²/2)', () => {
    // Обычный массив за прокси: и индексы, и обобщённые методы массива читают байты через get — счёт полный.
    const bytes = Array.from(randomBytes(4_096));
    let reads = 0;
    const counted = new Proxy(bytes, {
      get(target, key, receiver) {
        if (typeof key === 'string' && /^[0-9]+$/.test(key)) {
          reads += 1;
          return target[Number(key)];
        }
        const value = Reflect.get(target, key, receiver);
        return typeof value === 'function' ? value.bind(receiver) : value;
      },
    });
    expect(smallestPeriod(counted as unknown as Uint8Array)).toBe(4_096);
    expect(reads).toBeGreaterThan(4_096);
    expect(reads).toBeLessThanOrEqual(4 * 4_096);
  });
});
