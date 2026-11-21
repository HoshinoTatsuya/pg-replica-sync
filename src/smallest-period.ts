/**
 * Наименьший период байтов: наименьшее `p ≥ 1`, при котором `bytes[i] === bytes[i % p]`
 * для всех i (`bytes.length`, если короче не нашлось). Префикс-функция
 * Кнута — Морриса — Пратта: O(n). Прежний перебор периодов был O(n²) — ключ
 * 64 КБ проверялся 10 с, и длинный ключ из настройки вешал старт процесса.
 */
export function smallestPeriod(bytes: Uint8Array): number {
  const n = bytes.length;
  if (n === 0) {
    return 0;
  }
  const border = new Uint32Array(n);
  for (let i = 1; i < n; i += 1) {
    let k = border[i - 1] ?? 0;
    while (k > 0 && bytes[i] !== bytes[k]) {
      k = border[k - 1] ?? 0;
    }
    if (bytes[i] === bytes[k]) {
      k += 1;
    }
    border[i] = k;
  }
  return n - (border[n - 1] ?? 0);
}
