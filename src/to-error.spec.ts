import { toError } from './to-error';

/**
 * Брошенное значение, у которого `String()` бросает (без прототипа, бросающий
 * `toString`), превращается в Error, а не в TypeError посреди разбора отказа:
 * `tokenAfterCommit` по контракту не бросает, а наблюдатель получает ошибку.
 */
describe('toError', () => {
  it.each([
    ['без прототипа', (): unknown => Object.create(null)],
    [
      'с бросающим toString',
      (): unknown => ({
        toString: () => {
          throw new Error('toString');
        },
      }),
    ],
  ])('значение %s — Error с текстом и исходным значением в cause', (_label, make) => {
    const value = make();
    const error = toError(value);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe('[object Object]');
    expect(error.cause).toBe(value);
  });

  it('Error — как есть; строка — её текст', () => {
    const original = new Error('x');
    expect(toError(original)).toBe(original);
    expect(toError('отказ').message).toBe('отказ');
  });
});
