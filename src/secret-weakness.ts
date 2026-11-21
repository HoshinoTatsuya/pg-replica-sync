import { deflateRawSync } from 'node:zlib';

import { TOKEN_FORMAT } from './constants/token-format.constant';
import { smallestPeriod } from './smallest-period';

/**
 * Почему ключ подписи — не ключ (`null` — признаков слабости не найдено).
 * Три признака, каждый — оценка СВЕРХУ того, что подбирается перебором:
 *
 * - повторение короткого куска (`'k'.repeat(32)`, `'ab'.repeat(16)`, нулевой буфер):
 *   период не больше половины длины;
 * - мало разных байтов (`'a'×31+'b'`, `'0'×63+'1'`, случайная строка из двух
 *   символов): эмпирическая энтропия гистограммы байтов × длина меньше
 *   `MIN_SECRET_HISTOGRAM_BITS`;
 * - почти-повтор (`'abcdefgh'×4` с одной заменой): ключ сжимается (deflate) до
 *   меньше `MIN_SECRET_COMPRESSED_BITS`.
 *
 * Пороги взяты так, что случайные ключи проходят с запасом: 20 000 случайных
 * ключей каждой формы (32 байта, hex от 16 байт, base64 от 24 байт) — минимум
 * 93 бита по гистограмме и 240 бит после сжатия. Словарный ключ, перебор
 * алфавита по порядку, ключ из пароля этим не обнаруживаются: энтропию строки
 * отсюда не измерить — ключ обязан быть случайными байтами.
 */
export function secretWeakness(key: Uint8Array): string | null {
  const period = smallestPeriod(key);
  if (period <= key.length / 2) {
    return `ключ — повторение куска из ${period} байт`;
  }
  const counts = new Map<number, number>();
  for (const byte of key) {
    counts.set(byte, (counts.get(byte) ?? 0) + 1);
  }
  let bitsPerByte = 0;
  for (const count of counts.values()) {
    const share = count / key.length;
    bitsPerByte -= share * Math.log2(share);
  }
  const histogramBits = Math.floor(bitsPerByte * key.length);
  if (histogramBits < TOKEN_FORMAT.MIN_SECRET_HISTOGRAM_BITS) {
    return `в ключе мало разных байтов: ≈ ${histogramBits} бит по гистограмме, нужно не меньше ${TOKEN_FORMAT.MIN_SECRET_HISTOGRAM_BITS}`;
  }
  const compressedBits = deflateRawSync(key, { level: 9 }).length * 8;
  if (compressedBits < TOKEN_FORMAT.MIN_SECRET_COMPRESSED_BITS) {
    return `ключ сжимается до ${compressedBits} бит (почти-повтор), нужно не меньше ${TOKEN_FORMAT.MIN_SECRET_COMPRESSED_BITS}`;
  }
  return null;
}
