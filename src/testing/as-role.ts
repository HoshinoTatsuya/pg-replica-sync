/** Тот же узел под другой ролью (пароль роли совпадает с именем — так их заводят спеки и скрипт). */
export function asRole(url: string, role: string): string {
  const parsed = new URL(url);
  parsed.username = role;
  parsed.password = role;
  return parsed.toString();
}
