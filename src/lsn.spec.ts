import { compareLsn } from './compare-lsn';
import { formatLsn } from './format-lsn';
import { InvalidLsnError } from './invalid-lsn.error';
import { parseLsn } from './parse-lsn';

/**
 * Позиции WAL — 64-битные числа `X·2³² + Y`. Пары ниже выбраны так, что
 * лексикографическое сравнение текста даёт ОБРАТНЫЙ ответ: мутация «сравнить
 * строкой» краснеет на каждой.
 */
describe('позиция WAL как 64-битное число', () => {
  it.each([
    ['9/0', '10/0'],
    ['F/FFFFFFFF', '10/0'],
    ['A/0', '1F/0'],
    ['0/9', '0/10'],
    ['0/FFFFFFF', '0/10000000'],
    ['FFFFFFF/0', '10000000/0'],
    ['a/0', 'B/0'],
  ])('%s < %s, хотя строкой наоборот', (lower, higher) => {
    expect(lower > higher).toBe(true);
    expect(compareLsn(lower, higher)).toBe(-1);
    expect(compareLsn(higher, lower)).toBe(1);
    expect(compareLsn(parseLsn(lower), parseLsn(higher))).toBe(-1);
  });

  it('границы 32 бит: младшая половина переполняется в старшую ровно на единицу', () => {
    expect(parseLsn('0/FFFFFFFF') + 1n).toBe(parseLsn('1/0'));
    expect(parseLsn('1/0')).toBe(4_294_967_296n);
    expect(parseLsn('FFFFFFFF/FFFFFFFF')).toBe((1n << 64n) - 1n);
    expect(parseLsn('0/0')).toBe(0n);
  });

  it('регистр не важен, равные позиции равны', () => {
    expect(compareLsn('16/b374d848', '16/B374D848')).toBe(0);
    expect(compareLsn('0/00000010', '0/10')).toBe(0);
  });

  it('format — обратное к parse, в форме Postgres', () => {
    for (const text of ['0/0', '0/FFFFFFFF', '1/0', '16/B374D848', 'FFFFFFFF/FFFFFFFF']) {
      expect(formatLsn(parseLsn(text))).toBe(text);
    }
    expect(() => formatLsn(-1n)).toThrow(RangeError);
    expect(() => formatLsn(1n << 64n)).toThrow(RangeError);
  });

  it.each([
    '',
    '0',
    '0/',
    '/0',
    '1/2/3',
    '123456789/0',
    '0/123456789',
    'G/0',
    ' 0/0',
    '0/0 ',
    '-1/0',
    '0x1/0',
  ])('не позиция — отказ, а не ноль: %j', (text) => {
    expect(() => parseLsn(text)).toThrow(InvalidLsnError);
  });
});
