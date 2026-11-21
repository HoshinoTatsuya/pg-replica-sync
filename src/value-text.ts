/**
 * Текст брошенного значения, который сам не бросает. Обычное значение — как
 * `String(value)` (у ошибки — «Имя: сообщение»), но `String()` на значении без
 * прототипа (`Object.create(null)`) или с бросающим `toString` /
 * `Symbol.toPrimitive` бросает TypeError — в ветке, которая разбирает отказ.
 * Тогда — `message`, если это строка, иначе тег объекта.
 */
export function valueText(value: unknown): string {
  try {
    return String(value);
  } catch {
    try {
      const message = (value as { message?: unknown } | null)?.message;
      return typeof message === 'string' ? message : Object.prototype.toString.call(value);
    } catch {
      return '[значение без текста]';
    }
  }
}
