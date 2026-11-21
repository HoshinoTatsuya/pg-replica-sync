import { createHmac, timingSafeEqual } from 'node:crypto';

import { TOKEN_FORMAT } from './constants/token-format.constant';
import { WAL_FORMAT } from './constants/wal-format.constant';
import { decodeCanonicalBase64Url } from './decode-canonical-base64url';
import { formatLsn } from './format-lsn';
import { InvalidReplicaSyncOptionsError } from './invalid-replica-sync-options.error';
import { parseLsn } from './parse-lsn';
import { secretWeakness } from './secret-weakness';
import type { DecodedToken } from './types/decoded-token.type';
import type { WalPosition } from './types/wal-position.type';

/**
 * Токен позиции WAL для передачи клиенту (заголовок, cookie, контекст):
 * подписан HMAC-SHA256, поэтому подделанная или испорченная позиция
 * не принимается. Всё, что не разобралось, — `invalid`, и маршрутизатор
 * читает с мастера: неразборчивый токен не роняет запрос и не уводит его на
 * реплику. Токен не шифруется — позиция WAL не секрет, но и не данные клиента.
 *
 * Токен несёт момент выдачи (мс эпохи Unix, часы выдавшего процесса): по нему
 * маршрутизатор ограничивает, сколько токен, который ни одна реплика выполнить
 * не может (без позиции, с другой линии времени), держит клиента на мастере.
 */
export class TokenCodec {
  private readonly keys: readonly Buffer[];

  constructor(secrets: readonly (string | Uint8Array)[]) {
    if (!Array.isArray(secrets) || secrets.length === 0) {
      throw new InvalidReplicaSyncOptionsError('secrets: нужен хотя бы один ключ подписи токена');
    }
    this.keys = secrets.map((secret: unknown, index) => {
      if (typeof secret !== 'string' && !(secret instanceof Uint8Array)) {
        throw new InvalidReplicaSyncOptionsError(
          `secrets[${index}]: ожидается строка или Uint8Array, получено ${secret === null ? 'null' : typeof secret}`,
        );
      }
      const key = Buffer.from(secret);
      if (key.length < TOKEN_FORMAT.MIN_SECRET_BYTES) {
        throw new InvalidReplicaSyncOptionsError(
          `secrets[${index}]: ключ короче ${TOKEN_FORMAT.MIN_SECRET_BYTES} байт (${key.length})`,
        );
      }
      // Ключ — повторение куска, почти-повтор или горсть разных байтов — не ключ:
      // его подбирают перебором. Словарный ключ отсюда не обнаружить (secretWeakness).
      const weakness = secretWeakness(key);
      if (weakness !== null) {
        throw new InvalidReplicaSyncOptionsError(`secrets[${index}]: ${weakness} — не ключ`);
      }
      return key;
    });
  }

  /**
   * Позиция → токен; `null` — токен «позиция неизвестна»: такой клиент читает с
   * мастера. `issuedAt` — момент выдачи, целые мс эпохи Unix.
   */
  encode(position: WalPosition | null, issuedAt: number): string {
    if (!Number.isSafeInteger(issuedAt) || issuedAt < 0) {
      throw new RangeError(`момент выдачи не целое неотрицательное число мс: ${issuedAt}`);
    }
    let payload = `${TOKEN_FORMAT.UNRESOLVED_TAG}:${issuedAt}`;
    if (position !== null) {
      if (!WAL_FORMAT.SYSTEM_ID.test(position.systemId)) {
        throw new RangeError(`systemId не число: ${JSON.stringify(position.systemId)}`);
      }
      if (
        !Number.isInteger(position.timeline) ||
        position.timeline < 1 ||
        position.timeline > WAL_FORMAT.MAX_TIMELINE
      ) {
        throw new RangeError(`линия времени вне 1..2³²−1: ${position.timeline}`);
      }
      payload = `${TOKEN_FORMAT.POSITION_TAG}:${position.systemId}:${position.timeline}:${formatLsn(position.lsn)}:${issuedAt}`;
    }
    const body = Buffer.from(payload, 'utf8').toString('base64url');
    const [signing] = this.keys;
    if (signing === undefined) {
      throw new InvalidReplicaSyncOptionsError('secrets: нет ключа подписи');
    }
    return `${TOKEN_FORMAT.VERSION}.${body}.${this.sign(signing, body).toString('base64url')}`;
  }

  decode(token: string): DecodedToken {
    if (token.length > TOKEN_FORMAT.MAX_LENGTH) {
      return TokenCodec.invalid(`длиннее ${TOKEN_FORMAT.MAX_LENGTH} символов`);
    }
    const parts = token.split('.');
    const [version, body, signature] = parts;
    if (parts.length !== 3 || version === undefined || body === undefined || signature === undefined) {
      return TokenCodec.invalid('не три части через точку');
    }
    if (version !== TOKEN_FORMAT.VERSION) {
      return TokenCodec.invalid(`версия ${JSON.stringify(version.slice(0, 8))}`);
    }
    const mac = decodeCanonicalBase64Url(signature);
    if (mac === null || mac.length !== TOKEN_FORMAT.MAC_BYTES) {
      return TokenCodec.invalid('подпись не в форме');
    }
    if (!this.keys.some((key) => timingSafeEqual(this.sign(key, body), mac))) {
      return TokenCodec.invalid('подпись не сходится');
    }
    const payloadBytes = decodeCanonicalBase64Url(body);
    if (payloadBytes === null) {
      return TokenCodec.invalid('нагрузка не в форме');
    }
    return this.parsePayload(payloadBytes.toString('utf8'));
  }

  private static invalid(detail: string): DecodedToken {
    return { kind: 'invalid', detail };
  }

  private static issuedAtOf(text: string | undefined): number | null {
    if (text === undefined || !TOKEN_FORMAT.ISSUED_AT_TEXT.test(text)) {
      return null;
    }
    const value = Number(text);
    return Number.isSafeInteger(value) ? value : null;
  }

  private sign(key: Buffer, body: string): Buffer {
    return createHmac('sha256', key).update(`${TOKEN_FORMAT.DOMAIN}\n${body}`).digest();
  }

  private parsePayload(payload: string): DecodedToken {
    const fields = payload.split(':');
    if (fields[0] === TOKEN_FORMAT.UNRESOLVED_TAG) {
      const issuedAt = TokenCodec.issuedAtOf(fields[1]);
      return fields.length === 2 && issuedAt !== null
        ? { kind: 'unresolved', issuedAt }
        : TokenCodec.invalid('нагрузка не разбирается');
    }
    const [tag, systemId, timelineText, lsnText, issuedAtText] = fields;
    if (
      fields.length !== 5 ||
      tag !== TOKEN_FORMAT.POSITION_TAG ||
      systemId === undefined ||
      !WAL_FORMAT.SYSTEM_ID.test(systemId)
    ) {
      return TokenCodec.invalid('нагрузка не разбирается');
    }
    const timeline = Number(timelineText);
    if (!WAL_FORMAT.TIMELINE_TEXT.test(timelineText ?? '') || timeline > WAL_FORMAT.MAX_TIMELINE) {
      return TokenCodec.invalid('линия времени не разбирается');
    }
    const issuedAt = TokenCodec.issuedAtOf(issuedAtText);
    if (issuedAt === null) {
      return TokenCodec.invalid('момент выдачи не разбирается');
    }
    try {
      return {
        kind: 'position',
        position: { systemId, timeline, lsn: parseLsn(lsnText ?? '') },
        issuedAt,
      };
    } catch {
      return TokenCodec.invalid('позиция не разбирается');
    }
  }
}
