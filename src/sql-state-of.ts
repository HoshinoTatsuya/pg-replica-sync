/**
 * SQLSTATE отказа: поле `code` самого исключения или первого в цепочке `cause`,
 * у которого оно — пять символов `[0-9A-Z]`. Обёртки (ORM, свой слой доступа)
 * переносят отказ драйвера в `cause`, а своё `code` ставят иным или не ставят:
 * без обхода цепочки «нет транзакции» и «транзакция в ошибке» не опознавались бы,
 * и вместо их обработки уходил бы повторный бросок. Глубина обхода ограничена
 * (цепочка с циклом не зацикливает); бросающий геттер — «кода нет».
 */
export function sqlStateOf(error: unknown): string | null {
  const maxDepth = 16;
  let current: unknown = error;
  try {
    for (let depth = 0; depth < maxDepth && typeof current === 'object' && current !== null; depth += 1) {
      const code = (current as { code?: unknown }).code;
      if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) {
        return code;
      }
      current = (current as { cause?: unknown }).cause;
    }
  } catch {
    return null;
  }
  return null;
}
