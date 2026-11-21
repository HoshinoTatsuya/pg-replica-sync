# Changelog

All notable changes to this package are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the package uses
[Semantic Versioning](https://semver.org/) (before 1.0 a breaking change bumps the minor version).

## 0.2.2 — 2026-11-21

First public release as `@hoshinotatsuya/pg-replica-sync`, MIT; documentation in English and Russian; no
functional changes.

- README examples (English and Russian, the same blocks) are compiled by `readme-examples.spec.ts` under
  `strict`, `exactOptionalPropertyTypes` and `noUncheckedIndexedAccess`.
- CI moved to GitHub Actions (PostgreSQL 15–18 on a real replication stand); development dependencies bumped
  (arch-gates 0.12.2, jest-groups 0.7.2, fault-kit 0.3.1).

## 0.2.1 — 2026-11-21

### Fixed

- Converting a rejection of a user executor to an `Error` no longer throws on a value without a prototype or with
  a throwing `toString`: the token path that must not throw used to reject, and the observer got no error. Now it
  is an `Error` with a text and the original value in `cause`.

## 0.2.0 — 2026-11-17

Fixes found on a real replication stand (primary, streaming, cascading and archive-only replicas). Breaking
changes — see *Migration*.

### Changed

- **A token only from the write connection.** `issueToken()` without an argument took the position on the probe
  connection, which does not see the caller's transaction — inside an open transaction it issued a token without
  the write. Now `issueToken(executor)` requires the connection, and `commitAndIssueToken(client)` sends COMMIT
  and takes the position on the same connection, after checking that a transaction is open there (`SAVEPOINT`):
  a pool, a wrapper around a pool or a connection without `BEGIN` → `TransactionNotOpenError` (COMMIT not sent); a
  failed transaction → ROLLBACK and `TransactionNotCommittedError`.
- **Load-balanced nodes**: `ReplicaNode.balanced`, `RouteDecision.mustConfirm`, `router.confirm(decision,
  readConnection)`, `stats().confirms`, hook `observer.confirmed`. Without it a balancer address gave 5 of 10
  reads without the write.
- **Replica restart**: a probe connection dropped from outside evicts the node from the cache at once, and
  `stateTtlMs` is capped at 1000 ms (the replay position rolls back on restart).
- A token right after a WAL page header is aligned to the page boundary, so an idle primary does not delay it.
- **Unavailable primary**: with the WAL receiver stopped, the timeline last reported by the same replica
  instance is used, so reads with a token keep going to replicas.
- **Token lifetime** (`tokenTtlMs`, 60 s; the issue time is in the token, `wallClock`): a token of another
  timeline, another cluster or ahead of the primary keeps reads on the primary at most that long, then reads as
  without a token (`stats().expiredTokens`). Only a **proven** unsatisfiable token expires — by a primary probe
  started after the process first met the token's position — so clock skew never expires a legitimate token.
- **Cost and ceilings**: `minProbeIntervalMs` (10 ms) per token position (LRU memory of 1024 positions, probe
  sequence numbers instead of clocks): 203 probes/s instead of 2647/s with lagging replicas; `route()` stays within
  `probeTimeoutMs + waitForCatchUpMs`; timers above 2³¹−1 ms are rejected; a probe query over `probeTimeoutMs` no
  longer drops the connection before `connectTimeoutMs` (10 s, new option), so a slow but live replica is usable.
- **Connections and hooks**: a late failure of an old probe no longer closes the new connection; `close()`
  interrupts running `route()` and no probe connection is reopened after it; failures of async hooks and throwing
  hook getters are swallowed; clocks stepping back or returning non-numbers evict the cache; `stats()` is
  JSON-serializable (lag is a number, not `bigint`).
- **Token format `v2`** (issue time in the payload, signing domain `pg-replica-sync/token/v2`); weak keys
  (repeated chunks, few distinct bytes, near-repeats, non-string/non-bytes) are rejected; the key check is linear.

### Migration

- `router.issueToken()` without an argument → `router.commitAndIssueToken(client)` instead of your own COMMIT, or
  `router.issueToken(pool)` **after** the transaction returned.
- `v1` tokens read as `token-invalid` (primary) until the client's next write; old instances treat `v2` tokens the
  same way during a rolling deploy — primary only, the guarantee holds.
- `stateTtlMs` above 1000, timers above 2³¹−1 ms, weak signing keys and clocks not returning finite numbers are
  rejected with `InvalidReplicaSyncOptionsError`.
- `TokenCodec.encode(position, issuedAt)` — the second argument is required; `DecodedToken` has `issuedAt`.
- `RouterStats.lagBytes` is `number | null` instead of `bigint | null`.
- `commitAndIssueToken(pool)` is a type error (`NotAPool`); roll back in your `catch` on any exception.
- After `close()`: `issueToken`/`commitAndIssueToken` return a primary-only token (COMMIT is sent), `confirm` returns
  `false`; `route()` still throws.
- Mark balancer addresses `balanced: true` and confirm their decisions.

## 0.1.1 — 2026-11-16

### Fixed

- Test flakiness: the specs waited for a target the replica could not reach after `pg_switch_wal` (the insert
  position right after a new segment header); they now wait for a reachable target and with a time ceiling. The
  router code did not change.

## 0.1.0 — 2026-11-15

First release: a signed WAL position token (HMAC-SHA256, key rotation, primary-only token), a router excluding
replicas by pause, promotion, cluster, timeline and position, a lag ceiling without a token, a bounded state cache
with eviction, waiting for catch-up with a ceiling, a probe with its own connection and timeout, metrics and hooks;
`parseLsn`/`formatLsn`/`compareLsn`.
