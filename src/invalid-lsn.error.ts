/** Текст не является позицией WAL в форме `X/Y` (по 1–8 шестнадцатеричных цифр). */
export class InvalidLsnError extends Error {
  override readonly name = 'InvalidLsnError';

  constructor(readonly input: string) {
    super(
      `не позиция WAL: ${JSON.stringify(input.slice(0, 40))} (ожидается X/Y, по 1–8 шестнадцатеричных цифр)`,
    );
  }
}
