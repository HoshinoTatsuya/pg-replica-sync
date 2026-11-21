import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import * as ts from 'typescript';

/**
 * Примеры README компилируются под строгими настройками потребителя (`strict`,
 * `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`) против исходников
 * пакета. Объекты приложения (пулы, запрос, ответ) примеры не создают — их
 * объявляет пролог, и только те, что пример не объявил сам. Рядом — проверки
 * типов, которых README обещает: пул в `commitAndIssueToken` не принимается,
 * необязательное поле принимает `undefined`, `stats()` — без `bigint`.
 */
jest.setTimeout(60_000);

const ROOT = resolve(__dirname, '..');
const PACKAGE_ENTRY = join(ROOT, 'src', 'index.ts');

/** Имена приложения, которые примеры берут готовыми, и их объявления. */
const APP_DECLARATIONS: Readonly<Record<string, string>> = {
  primaryPool: 'declare const primaryPool: Pool;',
  replica1Pool: 'declare const replica1Pool: Pool;',
  replica2Pool: 'declare const replica2Pool: Pool;',
  request: 'declare const request: { readonly cookies: Readonly<Record<string, string | undefined>> };',
  response: 'declare const response: { cookie(name: string, value: string): void };',
  name: 'declare const name: string;',
  id: 'declare const id: number;',
  token: 'declare const token: string | undefined;',
  router: 'declare const router: PreludeRouter<Pool>;',
  primaryDb: 'declare const primaryDb: unknown;',
  work: 'declare const work: () => Promise<void>;',
  transactionKeepingFailure:
    'declare function transactionKeepingFailure(db: unknown, work: () => Promise<void>, options?: { readonly readOnly?: boolean }): Promise<void>;',
};

const readmeBlocks = (file: string): string[] => {
  const readme = readFileSync(join(ROOT, file), 'utf8');
  return [...readme.matchAll(/```ts\n([\s\S]*?)```/g)].map((match) => match[1] ?? '');
};

const declaredIn = (code: string): Set<string> =>
  new Set(
    [...code.matchAll(/\b(?:const|let|function|class)\s+([A-Za-z_$][\w$]*)/g)].map((match) => match[1] ?? ''),
  );

const withPrelude = (code: string): string => {
  const own = declaredIn(code);
  const prelude = [
    // Пример, сам импортирующий из pg (быстрый старт создаёт пулы), получает свой импорт, а не двойной.
    ...(/from 'pg';/.test(code) ? [] : ["import type { Pool } from 'pg';"]),
    "import type { ReplicaRouter as PreludeRouter } from '@hoshinotatsuya/pg-replica-sync';",
    ...Object.entries(APP_DECLARATIONS)
      .filter(([identifier]) => !own.has(identifier))
      .map(([, declaration]) => declaration),
  ];
  return `${prelude.join('\n')}\n${code}\nexport {};\n`;
};

/** Диагностики компиляции набора файлов в памяти (пути — внутри пакета, импорт пакета — на исходники). */
const compile = (files: Readonly<Record<string, string>>): string[] => {
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2023,
    lib: ['lib.es2023.d.ts'],
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    strict: true,
    exactOptionalPropertyTypes: true,
    noUncheckedIndexedAccess: true,
    noEmit: true,
    skipLibCheck: true,
    types: ['node'],
    typeRoots: [join(ROOT, 'node_modules', '@types')],
    baseUrl: ROOT,
    paths: { '@hoshinotatsuya/pg-replica-sync': [PACKAGE_ENTRY] },
  };
  const host = ts.createCompilerHost(options);
  const virtual = new Map(Object.entries(files).map(([name, text]) => [join(ROOT, 'src', name), text]));
  const getSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (fileName, languageVersion, onError, shouldCreate) => {
    const text = virtual.get(fileName);
    return text === undefined
      ? getSourceFile(fileName, languageVersion, onError, shouldCreate)
      : ts.createSourceFile(fileName, text, languageVersion, true);
  };
  const fileExists = host.fileExists.bind(host);
  host.fileExists = (fileName) => virtual.has(fileName) || fileExists(fileName);
  const readFile = host.readFile.bind(host);
  host.readFile = (fileName) => virtual.get(fileName) ?? readFile(fileName);
  const program = ts.createProgram([...virtual.keys()], options, host);
  return ts
    .getPreEmitDiagnostics(program)
    .filter((diagnostic) => diagnostic.file === undefined || virtual.has(diagnostic.file.fileName))
    .map((diagnostic) => {
      const where = diagnostic.file?.fileName.split('/').pop() ?? '';
      const line =
        diagnostic.file === undefined || diagnostic.start === undefined
          ? 0
          : diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start).line + 1;
      return `${where}:${line} TS${diagnostic.code} ${ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')}`;
    });
};

describe('примеры README', () => {
  // Выборка не выродилась: число блоков ts в каждом README названо явно (быстрый старт, балансировщик,
  // вместе с pg-runtime, метрики); README.ru.md — те же примеры.
  it.each([
    ['README.md', 4],
    ['README.ru.md', 4],
  ])(
    '%s: каждый блок ts компилируется под strict + exactOptionalPropertyTypes + noUncheckedIndexedAccess',
    (file, count) => {
      const blocks = readmeBlocks(file);
      expect(blocks.length).toBe(count);
      const files = Object.fromEntries(
        blocks.map((code, index) => [`__readme_example_${index}.ts`, withPrelude(code)]),
      );
      expect(compile(files)).toEqual([]);
    },
  );

  it('README.ru.md приводит те же примеры, что README.md', () => {
    expect(readmeBlocks('README.ru.md')).toEqual(readmeBlocks('README.md'));
  });

  it('обещания типов: пул в commitAndIssueToken — ошибка, undefined в необязательном поле — нет, stats() без bigint', () => {
    const contract = `
import { Pool, type PoolClient } from 'pg';
import { ReplicaRouter, type RouterStats } from '@hoshinotatsuya/pg-replica-sync';
declare const pool: Pool;
declare const client: PoolClient;
declare const cfg: { readonly balanced?: boolean; readonly stateTtlMs?: number };
const router = new ReplicaRouter<Pool>({
  primary: { name: 'p', connection: 'postgres://p', target: pool },
  replicas: [{ name: 'r', connection: 'postgres://r', target: pool, balanced: cfg.balanced }],
  secrets: ['k'],
  stateTtlMs: cfg.stateTtlMs,
});
export const viaClient: Promise<string> = router.commitAndIssueToken(client);
// @ts-expect-error — пул не клиент транзакции: COMMIT ушёл бы на случайное соединение
export const viaPool = router.commitAndIssueToken(pool);
type HasBigint<T> = T extends bigint ? true : T extends object ? { [K in keyof T]: HasBigint<T[K]> }[keyof T] : false;
export const noBigint: true extends HasBigint<RouterStats> ? never : true = true;
`;
    expect(compile({ '__type_contract.ts': contract })).toEqual([]);
    // Контроль: без @ts-expect-error пул — ошибка именно о пуле (проверка видит тип, а не молчит).
    const errors = compile({
      '__type_contract_control.ts': contract.replace('// @ts-expect-error', '//'),
    });
    expect(errors.length).toBe(1);
    expect(errors[0]).toContain('totalCount');
  });
});
