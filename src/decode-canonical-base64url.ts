/** base64url только в канонической форме: иначе разные строки давали бы один и тот же токен. */
export function decodeCanonicalBase64Url(text: string): Buffer | null {
  const bytes = Buffer.from(text, 'base64url');
  return bytes.toString('base64url') === text ? bytes : null;
}
