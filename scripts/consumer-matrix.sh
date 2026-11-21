#!/usr/bin/env bash
# Матрица потребителей: собранный пакет (npm pack) ставится в одноразовые
# проекты с разными настройками модулей (commonjs, node16, nodenext, ESM с
# bundler и nodenext). В каждом: tsc над кодом, который передаёт `pg.Pool` и
# `PoolClient` потребителя в API пакета (структурные типы должны принять вторую
# копию `pg`), проверка «ни один экспорт не стал any», рантайм того условия
# exports, которое выбирают декларации (import для ESM, require для CJS), и
# ts-jest там, где потребитель его гоняет.
#
# Запуск: scripts/consumer-matrix.sh. Каталоги — из mkdtemp, удаляются в конце.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/pg-replica-sync-consumers-XXXXXX")"
cleanup() {
  case "${WORK}" in
    "${TMPDIR:-/tmp}"/pg-replica-sync-consumers-*) rm -rf "${WORK}" ;;
  esac
}
trap cleanup EXIT

(cd "${ROOT}" && pnpm build >/dev/null && npm pack --silent --pack-destination "${WORK}" >/dev/null)
TARBALL="$(ls "${WORK}"/hoshinotatsuya-pg-replica-sync-*.tgz)"

CONSUMER_TS="import { Pool } from 'pg';
import { compareLsn, parseLsn, ReplicaRouter, ROUTE_REASON, TokenCodec, type RouteDecision } from '@hoshinotatsuya/pg-replica-sync';

// skipLibCheck прячет ошибки в декларациях пакета, а нерезолвящийся импорт в них
// молча становится any. Утверждение ниже не компилируется, если хоть один экспорт стал any.
type IsAny<T> = 0 extends 1 & T ? true : false;
type NotAny<T> = IsAny<T> extends true ? never : true;
export const typed: [
  NotAny<typeof ReplicaRouter>, NotAny<typeof TokenCodec>, NotAny<typeof compareLsn>,
  NotAny<RouteDecision<Pool>>, NotAny<typeof ROUTE_REASON>,
] = [true, true, true, true, true];

export const order = compareLsn('9/0', '10/0');
export const position: bigint = parseLsn('1/0');
export const makeRouter = (primary: Pool, replica: Pool) =>
  new ReplicaRouter<Pool>({
    primary: { name: 'primary', connection: 'postgres://app@primary/app', target: primary },
    replicas: [{ name: 'r1', connection: { host: 'replica', user: 'app' }, target: replica }],
    secrets: ['consumer-key-0123456789abcdefghijkl'],
  });
// Необязательные поля из необязательной настройки — под exactOptionalPropertyTypes.
declare const cfg: { readonly balanced?: boolean; readonly stateTtlMs?: number };
export const fromOptionalConfig = (primary: Pool, replica: Pool) =>
  new ReplicaRouter<Pool>({
    primary: { name: 'primary', connection: 'postgres://app@primary/app', target: primary },
    replicas: [{ name: 'r1', connection: 'postgres://app@replica/app', target: replica, balanced: cfg.balanced }],
    secrets: ['consumer-key-0123456789abcdefghijkl'],
    stateTtlMs: cfg.stateTtlMs,
  });
// Пул — не клиент транзакции: тип отвергает его в commitAndIssueToken.
export const rejectsPool = (router: ReplicaRouter<Pool>, primary: Pool) =>
  // @ts-expect-error — COMMIT через пул ушёл бы на случайное соединение
  router.commitAndIssueToken(primary);
// Отставание — число: счётчики сериализуются JSON.stringify.
export const lagOf = (router: ReplicaRouter<Pool>): Readonly<Record<string, number | null>> => router.stats().lagBytes;
export const readAfterWrite = async (router: ReplicaRouter<Pool>, primary: Pool) => {
  const client = await primary.connect();
  try {
    await client.query('BEGIN');
    await client.query('INSERT INTO t VALUES (1)');
    const token: string = await router.commitAndIssueToken(client);
    const later: string = await router.issueToken(primary);
    const decision = await router.route(token ?? later);
    const reader = await decision.target.connect();
    try {
      const confirmed: boolean = decision.mustConfirm ? await router.confirm(decision, reader) : true;
      return (confirmed ? reader : primary).query('SELECT 1');
    } finally {
      reader.release();
    }
  } finally {
    client.release();
  }
};
"

SPEC_TS="import { order, position } from './consumer';

it('сравнение позиций — 64-битное, и пакет грузится в раннере потребителя', () => {
  expect(order).toBe(-1);
  expect(position).toBe(4294967296n);
});
"

failures=0
run_case() {
  local label="$1" module="$2" resolution="$3" type="$4" jest="$5"
  local dir="${WORK}/${label}"
  mkdir -p "${dir}/src"
  cat >"${dir}/package.json" <<JSON
{
  "name": "consumer-${label}",
  "private": true,
  "type": "${type}",
  "dependencies": {
    "@hoshinotatsuya/pg-replica-sync": "file:${TARBALL}",
    "pg": "8.21.0"
  },
  "devDependencies": {
    "@types/jest": "30.0.0",
    "@types/node": "24.0.15",
    "@types/pg": "8.23.1",
    "jest": "30.4.2",
    "ts-jest": "29.4.11",
    "typescript": "6.0.3"
  }
}
JSON
  local resolution_line=""
  if [[ -n "${resolution}" ]]; then
    resolution_line="\"moduleResolution\": \"${resolution}\","
  fi
  cat >"${dir}/tsconfig.json" <<JSON
{
  "compilerOptions": {
    "module": "${module}",
    ${resolution_line}
    "target": "ES2024",
    "strict": true,
    "exactOptionalPropertyTypes": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "types": ["jest", "node"],
    "noEmit": true
  },
  "include": ["src"]
}
JSON
  printf '%s' "${CONSUMER_TS}" >"${dir}/src/consumer.ts"
  # ESM с nodenext требует расширение в относительном импорте; CJS-раннер jest — без него.
  if [[ "${type}" == "module" && "${resolution}" == "nodenext" ]]; then
    printf '%s' "${SPEC_TS}" | sed "s#'./consumer'#'./consumer.js'#" >"${dir}/src/consumer.spec.ts"
  else
    printf '%s' "${SPEC_TS}" >"${dir}/src/consumer.spec.ts"
  fi
  cat >"${dir}/jest.config.js" <<'JS'
module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  transform: { '^.+\\.ts$': ['ts-jest', { tsconfig: 'tsconfig.json' }] },
  maxWorkers: 2,
};
JS
  (cd "${dir}" && pnpm install --prefer-offline --silent >"${dir}/install.log" 2>&1) || {
    echo "${label}: установка не прошла"; tail -5 "${dir}/install.log"; failures=$((failures + 1)); return
  }
  if (cd "${dir}" && node_modules/.bin/tsc -p tsconfig.json >"${dir}/tsc.log" 2>&1); then
    echo "${label}: tsc — зелёный"
  else
    echo "${label}: tsc — КРАСНЫЙ"; head -5 "${dir}/tsc.log"; failures=$((failures + 1))
  fi
  local runtime='const m = require("@hoshinotatsuya/pg-replica-sync"); if (typeof m.ReplicaRouter !== "function" || m.compareLsn("9/0", "10/0") !== -1) process.exit(1);'
  if [[ "${type}" == "module" ]]; then
    runtime='const m = await import("@hoshinotatsuya/pg-replica-sync"); if (typeof m.ReplicaRouter !== "function" || m.compareLsn("9/0", "10/0") !== -1) process.exit(1);'
  fi
  if (cd "${dir}" && node --input-type="$([[ "${type}" == "module" ]] && echo module || echo commonjs)" -e "${runtime}" >"${dir}/runtime.log" 2>&1); then
    echo "${label}: рантайм входа — зелёный"
  else
    echo "${label}: рантайм входа — КРАСНЫЙ"; head -5 "${dir}/runtime.log"; failures=$((failures + 1))
  fi
  if [[ "${jest}" == "jest" ]]; then
    if (cd "${dir}" && node_modules/.bin/jest --maxWorkers=2 >"${dir}/jest.log" 2>&1); then
      echo "${label}: ts-jest — зелёный ($(grep -E '^Tests:' "${dir}/jest.log"))"
    else
      echo "${label}: ts-jest — КРАСНЫЙ"; grep -E 'TS[0-9]+|Tests:' "${dir}/jest.log" | head -5; failures=$((failures + 1))
    fi
  fi
}

run_case commonjs commonjs "" commonjs jest
run_case node16 node16 node16 commonjs jest
run_case nodenext nodenext nodenext commonjs jest
run_case bundler-esm esnext bundler module tsc-only
run_case nodenext-esm nodenext nodenext module tsc-only

if [[ "${failures}" -gt 0 ]]; then
  echo "матрица потребителей: красных ${failures}"
  exit 1
fi
echo "матрица потребителей: все зелёные"
