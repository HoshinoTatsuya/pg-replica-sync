'use strict';
/**
 * Замер цены маршрутизации на настоящей репликации (мастер + 2 реплики):
 * сколько стоит зонд состояния, сколько зондов приходится на чтение в разных
 * сценариях и сколько добавляет route() к чтению.
 *
 * Запуск: pnpm build && scripts/with-replication.sh node bench/cost.cjs
 * Роль — app (pg_monitor), как у приложения. Цифры — для этой машины и docker
 * на ней: важны отношения (зондов на чтение, доля от чтения), а не абсолютные мс.
 */
const { performance } = require('node:perf_hooks');
const { Client, Pool } = require('pg');
const { ReplicaRouter, PROBE_SQL } = require('../dist');

const asApp = (url) => {
  const parsed = new URL(url);
  parsed.username = 'app';
  parsed.password = 'app';
  return parsed.toString();
};
const PRIMARY = asApp(process.env.PG_PRIMARY_URL);
const R1 = asApp(process.env.PG_REPLICA1_URL);
const R2 = asApp(process.env.PG_REPLICA2_URL);

const SECRET = 'bench-secret-0123456789abcdefghijklmnop';

const quantiles = (samples) => {
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  return { p50: at(0.5).toFixed(3), p99: at(0.99).toFixed(3) };
};

const timed = async (count, work) => {
  const samples = [];
  for (let i = 0; i < count; i += 1) {
    const started = performance.now();
    await work(i);
    samples.push(performance.now() - started);
  }
  return quantiles(samples);
};

async function main() {
  const admin = new Client({ connectionString: process.env.PG_PRIMARY_URL });
  await admin.connect();
  await admin.query('CREATE TABLE IF NOT EXISTS bench (id integer PRIMARY KEY, note text)');
  await admin.query('GRANT SELECT, INSERT ON bench TO app');
  await admin.query('INSERT INTO bench SELECT g, md5(g::text) FROM generate_series(1, 1000) g ON CONFLICT DO NOTHING');
  await admin.end();
  await new Promise((resolve) => setTimeout(resolve, 500));

  const primary = new Pool({ connectionString: PRIMARY, max: 4 });
  const replica = new Pool({ connectionString: R1, max: 4 });
  const probe = new Client({ connectionString: R1 });
  await probe.connect();
  const out = {};

  out.readOnReplica = await timed(2000, (i) => replica.query('SELECT note FROM bench WHERE id = $1', [(i % 1000) + 1]));
  out.probeQuery = await timed(2000, () => probe.query(PROBE_SQL.STATE));

  const makeRouter = (options = {}) =>
    new ReplicaRouter({
      primary: { name: 'primary', connection: PRIMARY, target: primary },
      replicas: [
        { name: 'r1', connection: R1, target: replica },
        { name: 'r2', connection: R2, target: replica },
      ],
      secrets: [SECRET],
      ...options,
    });

  // 1. Чтения с одним и тем же (старым) токеном: позиция в кэше — зондов почти нет.
  {
    const router = makeRouter();
    const token = await router.issueToken(primary);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const route = await timed(5000, () => router.route(token));
    const stats = router.stats();
    out.sameToken = { route, reads: 5000, probes: stats.probes.ok, probesPerRead: (stats.probes.ok / 5000).toFixed(4), toReplica: stats.reads.replica };
    await router.close();
  }

  // 1б. Тот же токен, но чтения растянуты на ~3 с (пауза 1 мс): зонды — раз в потолок кэша, а не на чтение.
  {
    const router = makeRouter();
    const token = await router.issueToken(primary);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const started = performance.now();
    await timed(2000, async () => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      await router.route(token);
    });
    const seconds = (performance.now() - started) / 1000;
    const stats = router.stats();
    out.sameTokenSpread = { reads: 2000, seconds: seconds.toFixed(2), probes: stats.probes.ok, probesPerSecond: (stats.probes.ok / seconds).toFixed(1), probesPerRead: (stats.probes.ok / 2000).toFixed(4) };
    await router.close();
  }

  // 2. Запись → чтение с НОВЫМ токеном каждый раз: позиция впереди кэша — свежий зонд реплик.
  //    Дважды: с потолком частоты зондов по умолчанию и без него (minProbeIntervalMs: 0).
  for (const [label, options] of [['writeThenRead', {}], ['writeThenReadNoProbeCeiling', { minProbeIntervalMs: 0 }]]) {
    const router = makeRouter(options);
    let id = label === 'writeThenRead' ? 10_000 : 20_000;
    const route = await timed(1000, async () => {
      id += 1;
      const client = await primary.connect();
      try {
        await client.query('INSERT INTO bench (id, note) VALUES ($1, $2)', [id, 'w']);
        const token = await router.issueToken(client);
        await router.route(token);
      } finally {
        client.release();
      }
    });
    const stats = router.stats();
    out[label] = {
      writeTokenAndRoute: route,
      reads: 1000,
      probes: stats.probes.ok,
      probesPerRead: (stats.probes.ok / 1000).toFixed(3),
      toReplica: stats.reads.replica,
      toPrimary: stats.reads.primary,
      reasons: stats.reasons,
      exclusions: stats.exclusions,
    };
    await router.close();
  }

  // 2б. Буря: реплики отстают (задержка применения), 50 параллельных потоков читают с токеном
  //     впереди них 2 с. Зондов в секунду — с потолком частоты по умолчанию и без него.
  {
    const ADMIN_R1 = process.env.PG_REPLICA1_URL;
    const ADMIN_R2 = process.env.PG_REPLICA2_URL;
    const admin = async (url, text) => {
      const client = new Client({ connectionString: url });
      await client.connect();
      try {
        await client.query(text);
      } finally {
        await client.end();
      }
    };
    for (const url of [ADMIN_R1, ADMIN_R2]) {
      await admin(url, "ALTER SYSTEM SET recovery_min_apply_delay = '1h'");
      await admin(url, 'SELECT pg_reload_conf()');
    }
    for (const [label, options] of [['stormDefault', {}], ['stormNoProbeCeiling', { minProbeIntervalMs: 0 }]]) {
      let probes = 0;
      const router = makeRouter({ ...options, observer: { probed: () => { probes += 1; } } });
      const client = await primary.connect();
      let token;
      try {
        await client.query('BEGIN');
        await client.query('INSERT INTO bench (id, note) VALUES ($1, $2)', [label === 'stormDefault' ? 90_001 : 90_002, 's']);
        token = await router.commitAndIssueToken(client);
      } finally {
        client.release();
      }
      const started = performance.now();
      let reads = 0;
      await Promise.all(
        Array.from({ length: 50 }, async () => {
          while (performance.now() - started < 2_000) {
            await router.route(token);
            reads += 1;
          }
        }),
      );
      const seconds = (performance.now() - started) / 1000;
      out[label] = { reads, seconds: seconds.toFixed(2), probes, probesPerSecond: (probes / seconds).toFixed(0), probesPerRead: (probes / reads).toFixed(4) };
      await router.close();
    }
    for (const url of [ADMIN_R1, ADMIN_R2]) {
      await admin(url, 'ALTER SYSTEM RESET recovery_min_apply_delay');
      await admin(url, 'SELECT pg_reload_conf()');
    }
  }

  // 3. Без токена: зонд мастера и реплик раз в потолок кэша (250 мс).
  {
    const router = makeRouter();
    const started = performance.now();
    const route = await timed(5000, () => router.route());
    const seconds = (performance.now() - started) / 1000;
    const stats = router.stats();
    out.noToken = { route, reads: 5000, seconds: seconds.toFixed(2), probes: stats.probes.ok, probesPerRead: (stats.probes.ok / 5000).toFixed(4), toReplica: stats.reads.replica };
    await router.close();
  }

  // 4. Без кэша (потолок 1 мс): каждый route() — зонды. Это и есть «лишний запрос на чтение».
  {
    const router = new ReplicaRouter({
      primary: { name: 'primary', connection: PRIMARY, target: primary },
      replicas: [{ name: 'r1', connection: R1, target: replica }],
      secrets: [SECRET],
      stateTtlMs: 1,
    });
    const token = await router.issueToken(primary);
    let reads = 0;
    const route = await timed(2000, async () => {
      await new Promise((resolve) => setTimeout(resolve, 2));
      await router.route(token);
      reads += 1;
    });
    const stats = router.stats();
    out.noCache = { routeIncl2msPause: route, reads, probes: stats.probes.ok, probesPerRead: (stats.probes.ok / reads).toFixed(3) };
    await router.close();
  }

  await probe.end();
  await primary.end();
  await replica.end();
  console.log(JSON.stringify(out, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
