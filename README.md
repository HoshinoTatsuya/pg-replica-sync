# @hoshinotatsuya/pg-replica-sync

[![npm](https://img.shields.io/npm/v/@hoshinotatsuya/pg-replica-sync.svg)](https://www.npmjs.com/package/@hoshinotatsuya/pg-replica-sync)
[![CI](https://github.com/HoshinoTatsuya/pg-replica-sync/actions/workflows/ci.yml/badge.svg)](https://github.com/HoshinoTatsuya/pg-replica-sync/actions/workflows/ci.yml)

[Русская версия](README.ru.md) · [Changelog](CHANGELOG.md)

Reads from PostgreSQL replicas with a **read-your-writes** guarantee, by WAL position. After a write the client
gets a signed position token. A read carrying the token goes to a replica only when it is **proven** that the
replica has replayed that position on the same timeline of the same cluster; otherwise it goes to the primary.
Anything that cannot be established also sends the read to the primary, never to a replica.

**The problem it solves.** With asynchronous streaming replication a user saves a profile, reloads the page — and
the change is not there, because the read hit a lagging replica. The usual fixes are guesses ("all reads go to the
primary for N seconds after a write", which breaks when lag exceeds N) or giving up ("all reads to the primary",
so replicas offload nothing). This package routes each read by the actual replay position of each replica.

**When you do not need it:** without replicas; with synchronous replication and `synchronous_commit =
remote_apply` (every commit already waits for the replica); or when "not older than N" is enough for the read —
then reads without a token and the lag ceiling (`maxLagBytes`) suffice.

## Install

```sh
pnpm add @hoshinotatsuya/pg-replica-sync pg
pnpm add -D @types/pg   # optional, for TypeScript
```

Peer dependencies: `pg` `^8.18.0`, `@types/pg` `>=8.15.0` (optional). No other runtime dependencies. CommonJS with
ESM type declarations; checked with `commonjs`, `node16`, `nodenext` and `bundler` resolution.

The **probe role** (the user in each node's `connection`) needs membership in `pg_monitor` or at least
`pg_read_all_stats`: without it the replica's timeline is invisible, every replica is excluded as
`no-stats-privilege` and all reads go to the primary (the reason is named so that "everything on the primary" does
not look like healthy operation).

## Quick start

```ts
import { ReplicaRouter } from '@hoshinotatsuya/pg-replica-sync';
import { Pool } from 'pg';

/** A required environment variable: missing means a startup failure, not `undefined` in the options. */
const required = (key: string): string => {
  const value = process.env[key];
  if (value === undefined || value === '') {
    throw new Error(`${key} is not set`);
  }
  return value;
};

const primaryPool = new Pool({ connectionString: required('PRIMARY_URL') });
const replica1Pool = new Pool({ connectionString: required('REPLICA1_URL') });
const replica2Pool = new Pool({ connectionString: required('REPLICA2_URL') });

export const router = new ReplicaRouter<Pool>({
  // `connection` is what the router's own probe connects to; `target` is what you read with.
  primary: { name: 'primary', connection: required('PRIMARY_URL'), target: primaryPool },
  replicas: [
    { name: 'r1', connection: required('REPLICA1_URL'), target: replica1Pool },
    { name: 'r2', connection: required('REPLICA2_URL'), target: replica2Pool },
  ],
  // >= 32 RANDOM bytes (openssl rand -base64 32); to rotate, put the new key first
  secrets: [required('REPLICA_TOKEN_KEY')],
});

// Write: COMMIT and the token in one call, on the transaction's own connection.
export async function renameProfile(id: number, name: string): Promise<string> {
  const client = await primaryPool.connect();
  try {
    await client.query('BEGIN');
    await client.query('UPDATE profiles SET name = $1 WHERE id = $2', [name, id]);
    return await router.commitAndIssueToken(client); // give it to the client: a cookie, a header
  } catch (error) {
    // An exception means "no write, or unknown": end the transaction HERE, otherwise the connection
    // goes back to the pool with an open transaction and somebody else's COMMIT commits it.
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

// Read: with the token of the client's last write (undefined when there is none).
export async function loadProfile(id: number, token: string | undefined) {
  const { target, role, reason } = await router.route(token);
  const { rows } = await target.query('SELECT * FROM profiles WHERE id = $1', [id]);
  return { rows, servedBy: role, reason }; // role: 'primary' | 'replica'
}
```

Every `ts` block of this README (and of `README.ru.md`) is compiled by the spec `readme-examples.spec.ts` under
`strict`, `exactOptionalPropertyTypes` and `noUncheckedIndexedAccess` against the package sources; objects of
your application that a block does not declare itself (pools, `router`, `token`, `work`, …) are declared by the
spec's prelude.

`target` is whatever you read a node with (a `pg` pool, drizzle, anything); the package never touches it. Node
state is probed by the router's **own** connections, one per node, so a probe can be cut off by its timeout
without touching your pool. `router.close()` (or `await using`) closes only those.

## API

### `new ReplicaRouter<TTarget>(options)`

| Option | Default | Meaning |
|---|---|---|
| `primary`, `replicas` | — | `{ name, connection, target, balanced? }`; `connection` — URL or `pg` `ClientConfig` for the probe; `balanced: true` — the address is a load balancer over several servers (see below) |
| `secrets` | — | signing keys, newest first (rotation): ≥ 32 random bytes; keys that are guessable by shape (repeated chunks, few distinct bytes, near-repeats) are rejected |
| `stateTtlMs` | 250 (≤ 1000) | lifetime of a cached node state |
| `probeTimeoutMs` | 1 000 | ceiling of one probe |
| `connectTimeoutMs` | 10 000 | a probe connection that stays silent this long is dropped and reopened |
| `unavailableRetryMs` | 2 000 | how long a failed probe is remembered |
| `maxLagBytes` | 1 048 576 | lag ceiling for reads **without** a token, in WAL bytes |
| `waitForCatchUpMs` | 0 | how long a read with a token may wait for a lagging replica |
| `catchUpPollMs` | 10 | poll interval while waiting |
| `minProbeIntervalMs` | 10 | a lagging replica is re-probed at most this often for the same token position |
| `tokenTtlMs` | 60 000 | lifetime of a token that is **proven** unsatisfiable (other timeline/cluster, ahead of the primary) |
| `observer` | — | hooks `routed`, `probed`, `tokenUnresolved`, `confirmed` (may be async; failures are swallowed) |
| `clock`, `wallClock` | `performance.now`, `Date.now` | for tests |

Invalid options throw `InvalidReplicaSyncOptionsError` at construction (timers above 2³¹−1 ms included).
Defaults are exported as `REPLICA_SYNC_DEFAULTS`.

### Tokens after a write

The token must take the position **after** COMMIT, otherwise a replica could "catch up" with it without the write.

- **`commitAndIssueToken(client)`** → `Promise<string>` — sends COMMIT on the transaction's connection and takes
  the position from it. Before COMMIT it verifies that a transaction is open **on this connection** (`SAVEPOINT`):
  a pool, a wrapper around a pool or a connection without `BEGIN` → `TransactionNotOpenError`, and COMMIT is not
  sent. A failed transaction is ended with ROLLBACK → `TransactionNotCommittedError`. A pool is also rejected by
  the type (`NotAPool`). **Any exception means "no write or unknown"**: roll back in your `catch` (as in the quick
  start). After COMMIT went through it never throws: a token with the position, or a primary-only token.
- **`issueToken(executor)`** → `Promise<string>` — when somebody else commits (an ORM, a transaction helper): call
  it **after** COMMIT returned, with that connection or any primary connection (the insert position is monotonic).
  An open transaction with writes on this connection → a primary-only token (`write_pending`). A transaction on
  ANOTHER connection is invisible: prefer `commitAndIssueToken` when you can.

`issueToken` does not throw on node failures: when the position cannot be determined (node in recovery, timeout,
closed router) it returns a **primary-only** token — reads with it go to the primary (`token-unresolved`) until the
next write. The position is `pg_current_wal_insert_lsn()` (correct even with `synchronous_commit = off`), aligned
to a WAL page boundary when it sits right after a page header.

### `route(token?)` → `Promise<RouteDecision>`

`{ role, node, target, reason, excluded, catchUpPolls, mustConfirm }`. Bounded in time by
`probeTimeoutMs + waitForCatchUpMs`. A malformed, truncated, foreign-key-signed, old-format or too long
(> 256 chars) token gives `token-invalid` and the primary — it never fails the request.

**With a token** a replica is eligible only if **every** condition holds; otherwise it is excluded with a reason
(`EXCLUSION_REASON`):

| Condition | How | Otherwise |
|---|---|---|
| the probe answered in time | own connection, `probeTimeoutMs` | `unavailable` |
| the node is a replica | `pg_is_in_recovery()` | `promoted` |
| replay is not paused | `pg_get_wal_replay_pause_state()` | `paused` |
| same cluster | `pg_control_system().system_identifier` | `other-cluster` / `state-unknown` |
| same timeline | `pg_stat_wal_receiver.received_tli` | `timeline-mismatch` / `timeline-unknown` / `no-stats-privilege` |
| caught up | `pg_last_wal_replay_lsn() >= token position` | `behind` |

Several eligible replicas are used round-robin. None → the primary, with the reason (`ROUTE_REASON`):
`token-other-timeline` (failover happened), `token-ahead-of-primary`, `token-foreign` (other cluster) or
`no-replica-eligible`.

**Without a token** a replica is eligible under the same conditions, but instead of "caught up" it must lag the
primary's insert position by at most `maxLagBytes` (`replica-within-lag`); if the primary's state is unknown, the
read goes to the primary (`primary-state-unknown`). Lag is measured in WAL bytes, not seconds — a replica with
`recovery_min_apply_delay` may be an hour behind within the byte ceiling, so such replicas are not suitable for
reads without a token.

### Load-balanced nodes — `confirm(decision, readConnection)` → `Promise<boolean>`

A node address must lead to **one** server: the probe proves the state of the server it is connected to. If the
address is a balancer over several replicas (a Kubernetes read-only service, a proxy, a cloud reader endpoint),
mark it `balanced: true`; its decisions come with `mustConfirm: true` and are confirmed **on the read connection**:

```ts
const decision = await router.route(token);
const client = await decision.target.connect();
try {
  // `confirm` runs the same probe on THIS connection; `false` means read from the primary.
  const reader = (await router.confirm(decision, client)) ? client : primaryPool;
  await reader.query('SELECT 1');
} finally {
  client.release();
}
```

The read role then needs the same privileges as the probe role. A failure, a timeout or "cannot determine" is
`false`; a primary decision needs no confirmation (`true`). With a connection-level balancer (TCP, a Kubernetes
service, PgBouncer in session mode) the connection is pinned to the server; with a transaction pooler over several
servers call `confirm` as the **first statement inside the read transaction** and read in it. Statement-mode
pooling is not supported.

### Other exports

- `stats()` → `RouterStats` — reads per role, `ROUTE_REASON` and `EXCLUSION_REASON` counters, probes ok/failed,
  last measured lag per replica (number or `null`), expired tokens, confirm results; serializable with
  `JSON.stringify`.
- `close()` / `[Symbol.asyncDispose]` — closes probe connections; later `route()` throws, `issueToken` and
  `commitAndIssueToken` return primary-only tokens (COMMIT is still sent), `confirm` returns `false`.
- `parseLsn`, `formatLsn`, `compareLsn` — WAL positions as 64-bit numbers (`'10/0' > '9/0'`, unlike strings);
  `InvalidLsnError`.
- `TokenCodec` — the token format on its own (`encode(position, issuedAt)`, `decode(token)`), `TOKEN_FORMAT`.
- `PROBE_SQL`, `NODE_ROLE`, `ROUTE_REASON`, `EXCLUSION_REASON`, `REPLICA_SYNC_DEFAULTS`.
- Errors: `InvalidReplicaSyncOptionsError`, `TransactionNotOpenError`, `TransactionNotCommittedError`,
  `ProbeTimeoutError`, `ProbeConnectionClosedError`, `InvalidLsnError`.

### Metrics and tuning

```ts
import { ReplicaRouter } from '@hoshinotatsuya/pg-replica-sync';

const key = process.env.REPLICA_TOKEN_KEY;
if (key === undefined) {
  throw new Error('REPLICA_TOKEN_KEY is not set');
}
const observed = new ReplicaRouter<Pool>({
  primary: { name: 'primary', connection: 'postgres://app@primary/app', target: primaryPool },
  replicas: [{ name: 'r1', connection: 'postgres://app@replica-1/app', target: replica1Pool }],
  secrets: [key],
  waitForCatchUpMs: 20, // wait up to 20 ms for a lagging replica before falling back to the primary
  observer: {
    routed: (decision) => console.log('route', decision.role, decision.reason, decision.excluded),
    probed: (event) => console.log('probe', event.node, event.outcome, event.durationMs),
  },
});
// Plain numbers, safe for JSON.stringify: reads per role, reasons, exclusions, probes, lag per replica.
setInterval(() => console.log(JSON.stringify(observed.stats())), 60_000);
```

### With a transaction helper

The router returns `target`; the caller opens the transaction (here `transactionKeepingFailure` from
`@hoshinotatsuya/pg-runtime`):

```ts
// read: a read-only transaction on the chosen node
const { target } = await router.route(token);
await transactionKeepingFailure(target, work, { readOnly: true });

// write: on the primary; the token after the transaction returned (COMMIT is done), any primary connection
await transactionKeepingFailure(primaryDb, work);
const next = await router.issueToken(primaryPool);
```

## Guarantees and limits

- **Read-your-writes for the bearer of the token.** A read with a token sees everything committed before the
  token was issued (within the token's cluster and timeline). Writes of others made later may be invisible: this
  is not linearizability; for "the latest value" read from the primary.
- **Causality between clients only by passing the token** (in a message, a header). Without it the other client
  gets only "lag ≤ `maxLagBytes`".
- **Monotonic reads relative to the token only**: two reads with one token may hit different replicas. For
  monotonic reads advance the token (issue a new one after reading) or stick to one replica.
- **Cost**: node state is cached (`stateTtlMs`, evicted on every access; keys are only configured nodes), and
  concurrent reads share one probe. The extra query per read appears only right after the client's own write
  (fresh token ahead of the cache) — then all replicas are probed at once; lagging replicas are re-probed at most
  every `minProbeIntervalMs` per token position (positions remembered: 1024, LRU). Measured on a laptop
  (`bench/cost.cjs`, PostgreSQL 17, primary + 2 replicas): a probe p50 0.26 ms; the same token for 5000 reads —
  2 probes in total; write → read with a new token — 2 probes, and 999 of 1000 such reads went to a replica.
- Not detected: a token taken before COMMIT on **another** connection; a balancer without `balanced: true`; two
  independent promotions to the same timeline number (split history — fencing is the orchestrator's job); a
  replica that switched timelines from the archive while its WAL receiver was stopped.
- The cache ceiling is the window in which a node may change its role unnoticed when a dropped probe connection
  has not reached the client: at most `stateTtlMs` ≤ 1 s. Safe for read-your-writes; `paused`, unavailability and
  a restart (replay position rolls back) are noticed up to that late.

## Failure behavior

Fails toward the primary:

- unknown state, timeout, missing privilege, unknown timeline, unknown primary state → the primary, with a named
  reason;
- an invalid or foreign token → `token-invalid`, the primary; it never fails the request;
- a token that no replica can ever satisfy (failover, other cluster, ahead of the primary) keeps reads on the
  primary for `tokenTtlMs`, then is treated as no token; only a **proven** unsatisfiable token expires, so clock
  skew between processes never expires a legitimate token;
- **after failover** the replica that became primary is excluded as `promoted`; tokens of the old timeline go to
  the primary (`token-other-timeline`); updating the primary address in the options is the caller's job;
- when the primary is down, reads with a token still go to a replica that replayed it on the timeline this
  replica instance last reported; reads without a token go to the primary (`primary-state-unknown`);
- a throwing or rejecting observer hook never breaks routing or the process.

## Compatibility

- Node.js ≥ 24.
- PostgreSQL 15, 16, 17, 18 (the full suite runs on each, `PG_TEST_IMAGE`). Older versions are not supported.
- Load balancing checked with PgBouncer 1.26 in transaction mode over two replicas.
- `pg` 8.18+.

## Testing and development

```sh
pnpm install
pnpm typecheck
pnpm lint
pnpm test             # needs Docker: a real streaming-replication stand (see below)
pnpm test:consumers   # packs the build into throwaway commonjs/node16/nodenext/ESM projects
pnpm build
```

`pnpm test` starts **real streaming replication** (`scripts/with-replication.sh`): a primary with a WAL archive,
three replicas of `postgres:17-alpine` (`PG_TEST_IMAGE` for another; 15, 16 and 18 are tested) via
`pg_basebackup -R` with physical slots, a cascading replica, an archive-only replica and PgBouncer in transaction
mode over the first two (`PG_BOUNCER_IMAGE`, pinned by digest). The application role `app` (`pg_monitor`, no
superuser) routes and reads; pause, apply delay, stopping the WAL receiver and promotion are done as superuser.
Specs change the shared topology, so groups run in one worker (`JEST_GROUP_WORKERS=1`) through `jest-groups`
(at most 300 tests per group, groups one after another). Containers and the network are removed on exit.

## License

[MIT](LICENSE) © 2026 Hoshino Tatsuya
