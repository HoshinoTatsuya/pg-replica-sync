import { createHmac, randomBytes } from 'node:crypto';

import { TOKEN_FORMAT } from './constants/token-format.constant';
import { InvalidReplicaSyncOptionsError } from './invalid-replica-sync-options.error';
import { parseLsn } from './parse-lsn';
import { TokenCodec } from './token-codec';

const KEY_A = 'key-a-0123456789abcdefghijklmnopqrstuv';
const KEY_B = 'key-b-0123456789abcdefghijklmnopqrstuv';
const AT = 1_700_000_000_123;
const POSITION = { systemId: '7708384681250484264', timeline: 3, lsn: parseLsn('1/0') };

const forge = (
  key: string,
  payload: string,
  domain: string = TOKEN_FORMAT.DOMAIN,
  version: string = TOKEN_FORMAT.VERSION,
): string => {
  const body = Buffer.from(payload).toString('base64url');
  const mac = createHmac('sha256', key).update(`${domain}\n${body}`).digest('base64url');
  return `${version}.${body}.${mac}`;
};

describe('токен позиции', () => {
  it('позиция, «без позиции» и момент выдачи переживают кодирование', () => {
    const codec = new TokenCodec([KEY_A]);
    expect(codec.decode(codec.encode(POSITION, AT))).toEqual({
      kind: 'position',
      position: POSITION,
      issuedAt: AT,
    });
    expect(codec.decode(codec.encode(null, AT))).toEqual({ kind: 'unresolved', issuedAt: AT });
    expect(codec.decode(codec.encode(null, 0))).toEqual({ kind: 'unresolved', issuedAt: 0 });
  });

  it('подпись чужим ключом — invalid', () => {
    const token = new TokenCodec([KEY_B]).encode(POSITION, AT);
    expect(new TokenCodec([KEY_A]).decode(token)).toMatchObject({ kind: 'invalid' });
  });

  it('ротация: старый ключ вторым принимает выданные им токены, подписывает первый', () => {
    const old = new TokenCodec([KEY_A]).encode(POSITION, AT);
    const rotated = new TokenCodec([KEY_B, KEY_A]);
    expect(rotated.decode(old)).toEqual({ kind: 'position', position: POSITION, issuedAt: AT });
    expect(new TokenCodec([KEY_A]).decode(rotated.encode(POSITION, AT))).toMatchObject({ kind: 'invalid' });
  });

  it('каждая порча любого символа — invalid, ни одна не даёт другой позиции', () => {
    const codec = new TokenCodec([KEY_A]);
    const token = codec.encode(POSITION, AT);
    const results = [...token].map((char, index) => {
      const replacement = char === 'A' ? 'B' : 'A';
      return codec.decode(`${token.slice(0, index)}${replacement}${token.slice(index + 1)}`).kind;
    });
    expect(results.length).toBe(token.length);
    expect(results.every((kind) => kind === 'invalid')).toBe(true);
  });

  it('подделка позиции без ключа (нагрузка переписана, подпись прежняя) — invalid', () => {
    const codec = new TokenCodec([KEY_A]);
    const [version, , mac] = codec.encode(POSITION, AT).split('.');
    const forgedBody = Buffer.from(`p:${POSITION.systemId}:3:0/0:${AT}`).toString('base64url');
    expect(codec.decode(`${version}.${forgedBody}.${mac}`)).toMatchObject({ kind: 'invalid' });
  });

  it('токен прежней версии (v1, домен v1, без момента выдачи) — invalid, даже подписанный тем же ключом', () => {
    const v1 = forge(KEY_A, `p:${POSITION.systemId}:3:1/0`, 'pg-replica-sync/token/v1', 'v1');
    expect(new TokenCodec([KEY_A]).decode(v1)).toMatchObject({ kind: 'invalid' });
    // Нагрузка v1 под подписью v2 тоже не разбирается: момента выдачи нет.
    expect(new TokenCodec([KEY_A]).decode(forge(KEY_A, `p:${POSITION.systemId}:3:1/0`))).toMatchObject({
      kind: 'invalid',
    });
  });

  it.each([
    '',
    'garbage',
    'v2..',
    'v2.x.y',
    'v3.a.b',
    `${'v2.'}${'A'.repeat(TOKEN_FORMAT.MAX_LENGTH)}.x`,
    'v2.a.b.c',
  ])('неразборчивое — invalid, не исключение: %j', (text) => {
    expect(new TokenCodec([KEY_A]).decode(text)).toMatchObject({ kind: 'invalid' });
  });

  it.each([
    `p:123:0:0/0:${AT}`,
    `p:123:01:0/0:${AT}`,
    `p:123:4294967296:0/0:${AT}`,
    `p:abc:1:0/0:${AT}`,
    `p:123:1:0/G:${AT}`,
    `p:123:1:0/0:${AT}:extra`,
    `q:123:1:0/0:${AT}`,
    'p:123:1:0/0',
    'p:123:1:0/0:',
    'p:123:1:0/0:01',
    'p:123:1:0/0:-1',
    'p:123:1:0/0:1.5',
    'p:123:1:0/0:9007199254740993',
    'u',
    'u:',
    'u:01',
    `u:${AT}:x`,
    'unresolved',
  ])('подписанная, но кривая нагрузка — invalid: %s', (payload) => {
    expect(new TokenCodec([KEY_A]).decode(forge(KEY_A, payload))).toMatchObject({ kind: 'invalid' });
  });

  it('линия времени на границе: 2³²−1 принимается, 2³² — нет', () => {
    const codec = new TokenCodec([KEY_A]);
    expect(codec.decode(forge(KEY_A, `p:123:4294967295:0/0:${AT}`))).toEqual({
      kind: 'position',
      position: { systemId: '123', timeline: 4_294_967_295, lsn: 0n },
      issuedAt: AT,
    });
    expect(codec.decode(forge(KEY_A, `p:123:4294967296:0/0:${AT}`))).toMatchObject({ kind: 'invalid' });
    expect(codec.decode(codec.encode({ ...POSITION, timeline: 4_294_967_295 }, AT))).toMatchObject({
      kind: 'position',
    });
    expect(() => codec.encode({ ...POSITION, timeline: 4_294_967_296 }, AT)).toThrow(RangeError);
  });

  it('base64url только каноничный: другая запись тех же байтов подписи — invalid', () => {
    const codec = new TokenCodec([KEY_A]);
    const token = codec.encode(POSITION, AT);
    const [version, body, mac] = token.split('.') as [string, string, string];
    // Подпись 32 байта = 43 символа base64url: в последнем значимы 4 бита, младшие 2 — нули.
    // Поднять младший бит последнего символа — те же байты при нестрогом разборе.
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const last = alphabet.indexOf(mac.at(-1) as string);
    const sloppyMac = `${mac.slice(0, -1)}${alphabet[last | 1]}`;
    expect(sloppyMac).not.toBe(mac);
    expect(Buffer.from(sloppyMac, 'base64url').equals(Buffer.from(mac, 'base64url'))).toBe(true);
    expect(codec.decode(`${version}.${body}.${sloppyMac}`)).toMatchObject({ kind: 'invalid' });
    // С дополнением «=» — тоже другая строка тех же байтов.
    expect(codec.decode(`${version}.${body}.${mac}=`)).toMatchObject({ kind: 'invalid' });
    expect(codec.decode(token)).toMatchObject({ kind: 'position' });
  });

  it('нижняя граница линии времени: 1 кодируется и разбирается, 0 — нет', () => {
    const codec = new TokenCodec([KEY_A]);
    expect(codec.decode(codec.encode({ ...POSITION, timeline: 1 }, AT))).toEqual({
      kind: 'position',
      position: { ...POSITION, timeline: 1 },
      issuedAt: AT,
    });
    expect(() => codec.encode({ ...POSITION, timeline: 0 }, AT)).toThrow(RangeError);
  });

  it('лишняя часть через точку после верного токена — invalid, хотя первые три части подписаны верно', () => {
    const codec = new TokenCodec([KEY_A]);
    const token = codec.encode(POSITION, AT);
    expect(codec.decode(`${token}.x`)).toMatchObject({ kind: 'invalid' });
    expect(codec.decode(`${token}.`)).toMatchObject({ kind: 'invalid' });
  });

  it('нагрузка в неканоничном base64url, подписанная как есть, — invalid: другая запись тех же байтов', () => {
    const codec = new TokenCodec([KEY_A]);
    // Длина нагрузки не кратна 3: младшие биты последнего символа base64url незначащие.
    const payload = `p:${POSITION.systemId}:3:1/0:${AT}`;
    expect(payload.length % 3).not.toBe(0);
    const canonical = Buffer.from(payload).toString('base64url');
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const last = alphabet.indexOf(canonical.at(-1) as string);
    const sloppy = `${canonical.slice(0, -1)}${alphabet[last | 1]}`;
    expect(sloppy).not.toBe(canonical);
    expect(Buffer.from(sloppy, 'base64url').equals(Buffer.from(canonical, 'base64url'))).toBe(true);
    const mac = createHmac('sha256', KEY_A).update(`${TOKEN_FORMAT.DOMAIN}\n${sloppy}`).digest('base64url');
    expect(codec.decode(`${TOKEN_FORMAT.VERSION}.${sloppy}.${mac}`)).toEqual({
      kind: 'invalid',
      detail: 'нагрузка не в форме',
    });
  });

  it('потолок длины: подписанный токен длиннее 256 символов — invalid до разбора; не длиннее — разбирается', () => {
    const codec = new TokenCodec([KEY_A]);
    const base = `p:${POSITION.systemId}:3:1/0:${AT}`;
    const padded = (pad: number): string => forge(KEY_A, `${base}${'0'.repeat(pad)}`);
    let pad = 0;
    while (padded(pad + 1).length <= TOKEN_FORMAT.MAX_LENGTH) {
      pad += 1;
    }
    expect(padded(pad).length).toBeLessThanOrEqual(TOKEN_FORMAT.MAX_LENGTH);
    expect(padded(pad + 1).length).toBeGreaterThan(TOKEN_FORMAT.MAX_LENGTH);
    // Не длиннее потолка — дошёл до разбора нагрузки (момент выдачи с нулями — другая причина отказа).
    expect(codec.decode(padded(pad))).toEqual({ kind: 'invalid', detail: 'момент выдачи не разбирается' });
    expect(codec.decode(padded(pad + 1))).toEqual({
      kind: 'invalid',
      detail: `длиннее ${TOKEN_FORMAT.MAX_LENGTH} символов`,
    });
  });

  it('ключ короче 32 байт, пустой список, не строка и не байты, ключ из одного байта — отказ при создании', () => {
    expect(() => new TokenCodec([])).toThrow(InvalidReplicaSyncOptionsError);
    expect(() => new TokenCodec(['short-key'])).toThrow(InvalidReplicaSyncOptionsError);
    expect(() => new TokenCodec([KEY_A, KEY_B.slice(0, 31)])).toThrow(InvalidReplicaSyncOptionsError);
    expect(() => new TokenCodec([undefined as unknown as string])).toThrow(InvalidReplicaSyncOptionsError);
    expect(() => new TokenCodec([null as unknown as string])).toThrow(InvalidReplicaSyncOptionsError);
    expect(() => new TokenCodec([42 as unknown as string])).toThrow(InvalidReplicaSyncOptionsError);
    expect(() => new TokenCodec(undefined as unknown as string[])).toThrow(InvalidReplicaSyncOptionsError);
    expect(() => new TokenCodec([new Uint8Array(32)])).toThrow('повторение куска из 1 байт');
    expect(() => new TokenCodec(['k'.repeat(32)])).toThrow('повторение куска из 1 байт');
    expect(() => new TokenCodec(['ab'.repeat(16)])).toThrow('повторение куска из 2 байт');
    expect(() => new TokenCodec(['0123456789abcdef'.repeat(2)])).toThrow('повторение куска из 16 байт');
    expect(() => new TokenCodec([KEY_A, new Uint8Array(64)])).toThrow(InvalidReplicaSyncOptionsError);
    // Контроль: ключ, где хоть один байт другой, повтором не считается (отказ — по другой причине).
    expect(() => new TokenCodec([`${'k'.repeat(31)}j`])).toThrow('мало разных байтов');
  });

  it.each([
    ['один байт иной', `${'a'.repeat(31)}b`, 'мало разных байтов'],
    ['hex: нули и единица', `${'0'.repeat(63)}1`, 'мало разных байтов'],
    ['случайная строка из двух символов', 'abbabaabbbababbaabababbbaabbabab', 'мало разных байтов'],
    ['две половины из одного символа', `${'a'.repeat(16)}${'b'.repeat(16)}`, 'мало разных байтов'],
    ['почти-повтор куска из 8 байт', 'abcdefghabcdefghabcdXfghabcdefgh', 'сжимается'],
  ])('слабый ключ — отказ при создании: %s', (_label, key, reason) => {
    expect(() => new TokenCodec([key])).toThrow(InvalidReplicaSyncOptionsError);
    expect(() => new TokenCodec([key])).toThrow(reason);
  });

  it.each([
    ['32 случайных байта', () => randomBytes(32)],
    ['hex от 16 случайных байт (openssl rand -hex 16)', () => randomBytes(16).toString('hex')],
    ['base64 от 24 случайных байт', () => randomBytes(24).toString('base64')],
    ['base64url от 32 случайных байт', () => randomBytes(32).toString('base64url')],
  ])('ближайший законный двойник — случайный ключ принимается: %s (500 ключей)', (_label, make) => {
    for (let i = 0; i < 500; i += 1) {
      expect(() => new TokenCodec([make()])).not.toThrow();
    }
  });

  it('ключ, который проверка не различает, назван в README: словарный и перебор алфавита принимаются', () => {
    // Граница проверки, а не дефект: энтропию строки не измерить, ключ обязан быть случайным.
    expect(() => new TokenCodec(['password1234567890password1234567'])).not.toThrow();
    expect(() => new TokenCodec(['abcdefghijklmnopqrstuvwxyz012345'])).not.toThrow();
  });

  it('длинный ключ (64 КиБ) проверяется и принимается; повтор длинного куска в нём находится', () => {
    expect(() => new TokenCodec([randomBytes(1 << 16)])).not.toThrow();
    // Повтор длинного куска в длинном ключе — по-прежнему находится.
    const chunk = randomBytes(1 << 12);
    expect(() => new TokenCodec([Buffer.concat([chunk, chunk, chunk])])).toThrow(
      'повторение куска из 4096 байт',
    );
  }, 10_000);

  it('позиция и момент выдачи вне формы не кодируются', () => {
    const codec = new TokenCodec([KEY_A]);
    expect(() => codec.encode({ ...POSITION, timeline: 0 }, AT)).toThrow(RangeError);
    expect(() => codec.encode({ ...POSITION, systemId: 'x' }, AT)).toThrow(RangeError);
    expect(() => codec.encode(POSITION, -1)).toThrow(RangeError);
    expect(() => codec.encode(POSITION, 1.5)).toThrow(RangeError);
    expect(() => codec.encode(null, Number.NaN)).toThrow(RangeError);
  });
});
