import { parseLsn } from './parse-lsn';
import { tokenLsn } from './token-lsn';

const SEGMENT = 16 * 1024 * 1024;
const BLOCK = 8192;
const LAYOUT_8 = { maxAlign: 8, blockSize: BLOCK, segmentSize: SEGMENT };
const LAYOUT_4 = { maxAlign: 4, blockSize: BLOCK, segmentSize: SEGMENT };

/**
 * Позиция вставки сразу за заголовком страницы WAL сводится к границе
 * страницы — концу последней записи, который реплика воспроизводит; любая
 * другая позиция — как есть.
 */
describe('позиция токена по позиции вставки', () => {
  it('сразу за длинным заголовком первой страницы сегмента (40 байт) — начало сегмента', () => {
    expect(tokenLsn(parseLsn('0/5000028'), LAYOUT_8)).toBe(parseLsn('0/5000000'));
    expect(tokenLsn(parseLsn('1/28'), LAYOUT_8)).toBe(parseLsn('1/0'));
  });

  it('сразу за коротким заголовком страницы (24 байта) — граница страницы', () => {
    expect(tokenLsn(parseLsn('0/5002018'), LAYOUT_8)).toBe(parseLsn('0/5002000'));
    expect(tokenLsn(parseLsn('0/5FFE018'), LAYOUT_8)).toBe(parseLsn('0/5FFE000'));
  });

  it('позиция внутри записи или после неё — как есть', () => {
    for (const lsn of [
      '0/5000029',
      '0/5000030',
      '0/5002019',
      '0/5002017',
      '0/5001FF8',
      '0/5000000',
      '0/5002000',
    ]) {
      expect(tokenLsn(parseLsn(lsn), LAYOUT_8)).toBe(parseLsn(lsn));
    }
  });

  it('24 байта от начала СЕГМЕНТА — внутри длинного заголовка, не короткий: как есть', () => {
    expect(tokenLsn(parseLsn('0/5000018'), LAYOUT_8)).toBe(parseLsn('0/5000018'));
  });

  it('выравнивание 4 (32-битная сборка): заголовки 20 и 36 байт', () => {
    expect(tokenLsn(parseLsn('0/5000024'), LAYOUT_4)).toBe(parseLsn('0/5000000'));
    expect(tokenLsn(parseLsn('0/5002014'), LAYOUT_4)).toBe(parseLsn('0/5002000'));
    expect(tokenLsn(parseLsn('0/5002018'), LAYOUT_4)).toBe(parseLsn('0/5002018'));
    expect(tokenLsn(parseLsn('0/5000028'), LAYOUT_4)).toBe(parseLsn('0/5000028'));
  });

  it('раскладка не определилась или выравнивание не 4 и не 8 — как есть (ошибка в сторону мастера)', () => {
    expect(tokenLsn(parseLsn('0/5000028'), null)).toBe(parseLsn('0/5000028'));
    expect(tokenLsn(parseLsn('0/5000028'), { ...LAYOUT_8, maxAlign: 16 })).toBe(parseLsn('0/5000028'));
    expect(tokenLsn(parseLsn('0/5002018'), { ...LAYOUT_8, maxAlign: 2 })).toBe(parseLsn('0/5002018'));
  });

  it('другие размеры страницы и сегмента — по раскладке сервера', () => {
    const layout = { maxAlign: 8, blockSize: 32_768, segmentSize: 64 * 1024 * 1024 };
    expect(tokenLsn(parseLsn('0/4000028'), layout)).toBe(parseLsn('0/4000000'));
    expect(tokenLsn(parseLsn('0/4008018'), layout)).toBe(parseLsn('0/4008000'));
    // 8 КиБ — не граница страницы при странице 32 КиБ.
    expect(tokenLsn(parseLsn('0/4002018'), layout)).toBe(parseLsn('0/4002018'));
  });
});
