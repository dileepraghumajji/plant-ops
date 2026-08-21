/**
 * Load smoke for `GET /iam/permissions/resolve` (Doc 04 §6, roadmap Session 38).
 *
 *   npm run load:smoke -- --base-url http://localhost:3000 \
 *       --client-slug acme --email admin@acme.test --password '…'
 *   npm run load:smoke -- --base-url https://staging… --token "$JWT" --json
 *
 * ## What it measures, and why that is the interesting number
 *
 * Not throughput. Resolution is the hottest path in the system — every guarded
 * request in every future module runs it — and Doc 04 §6 answers that with a
 * versioned Redis cache. The claim worth smoke-testing is therefore not "it is
 * fast" but **"a cache hit does not query the tables"**: if it does, the cache
 * is decoration, the database is on the critical path of every authorization
 * decision, and the system falls over at a load no benchmark here would reach.
 *
 * So the tool counts scans. Postgres keeps per-table `seq_scan` and `idx_scan`
 * counters in `pg_stat_all_tables`; the tool reads them before and after the
 * burst and reports the delta on the tables that **only** the resolution query
 * reads. On a warm cache that delta is zero. The pass threshold is a small
 * fraction of the request count rather than exactly zero, because autovacuum and
 * any other traffic on the same database move the same counters.
 *
 * ## Why `role_binding` is not one of the tables watched
 *
 * It is the first table `ResolverService` joins, so leaving it out looks like
 * fudging until you measure: **every** authenticated request scans it, cache hit
 * or not, and resolution is not why. `applyRlsContext` derives
 * `app.is_platform_admin` from a `role_binding ⋈ client` existence check on each
 * request (`libs/db/src/rls-context.ts` explains why it is derived and not
 * asserted), so those two tables move in lockstep with the request count on
 * `/iam/whoami` just as much as on `/iam/permissions/resolve`. Watching them
 * would mean a meter that reads ~1-per-request whatever the cache does — which
 * is a meter that can only ever fail.
 *
 * The four that are watched appear in the grant query and nowhere else on this
 * route, so their delta is exactly "how many times resolution went to Postgres".
 *
 * ## The control
 *
 * A meter that reads zero because it is broken looks identical to a cache that
 * works. `--path` exists for that: pointed at `?applicationId=…` — the slice
 * Doc 04 §6 deliberately never caches — the same burst must move the same
 * counters. `load-smoke.e2e.ts` runs both directions for exactly this reason.
 *
 * ## What it deliberately does not do
 *
 * It is a smoke test, not a benchmark: no ramp, no think time, no percentile
 * targets to defend. The latency figures it prints are context for a human
 * reading a CI log, not assertions. Pinning p99 against whatever hardware a
 * runner happens to give you is how a suite becomes flaky and then ignored.
 *
 * ## Where it is used from
 *
 * `apps/iam-api-e2e/src/load-smoke.e2e.ts` runs it against the instance the
 * battery already has up, so the acceptance criterion is checked rather than
 * merely checkable. It stays a standalone CLI because Session 39's staging
 * verification needs to point it at a deployment that no test harness started.
 */

import { config as loadDotenv } from 'dotenv';
import { Client } from 'pg';

loadDotenv();

/**
 * The tables the grant query reads and nothing else on this route does — see
 * the header for why `role_binding` and `client` are deliberately absent.
 */
/** Postgres flushes a backend's pending stats at most this often. */
const STATS_FLUSH_INTERVAL_MS = 500;

/** Cap on the settle poll, so a busy database cannot hang the tool. */
const STATS_SETTLE_ATTEMPTS = 6;

const RESOLUTION_TABLES = [
  'role_permission',
  'permission',
  'client_application',
  'scope_node',
] as const;

interface Options {
  baseUrl: string;
  token?: string;
  clientSlug?: string;
  email?: string;
  password?: string;
  requests: number;
  concurrency: number;
  /** What to hammer. The control run points this at an uncacheable slice. */
  path: string;
  /** Read scan counters from here; the assertion is skipped without it. */
  databaseUrl?: string;
  /** Machine-readable output for the e2e wrapper. */
  json: boolean;
}

export interface LoadSmokeResult {
  path: string;
  requests: number;
  concurrency: number;
  failures: number;
  statuses: Record<string, number>;
  durationMs: number;
  requestsPerSecond: number;
  latencyMs: { p50: number; p95: number; p99: number; max: number };
  /** Per-table scan deltas across the burst, or `null` without a DB URL. */
  scanDelta: Record<string, number> | null;
  /** Above this many scans the cache is not doing its job. */
  scanBudget: number;
  passed: boolean;
}

function parseArgs(argv: readonly string[]): Options {
  const flags = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith('--')) continue;
    const [name, inline] = argument.slice(2).split('=', 2);
    flags.set(name, inline ?? argv[++index] ?? 'true');
  }

  const baseUrl = flags.get('base-url') ?? process.env['E2E_BASE_URL'];
  if (baseUrl === undefined) {
    throw new Error(
      'Usage: load-smoke --base-url <url> (--token <jwt> | --client-slug <s> ' +
        '--email <e> --password <p>) [--path /iam/permissions/resolve] ' +
        '[--requests 300] [--concurrency 25] [--json]',
    );
  }

  return {
    baseUrl: baseUrl.replace(/\/$/, ''),
    path: flags.get('path') ?? '/iam/permissions/resolve',
    token: flags.get('token'),
    clientSlug: flags.get('client-slug'),
    email: flags.get('email'),
    password: flags.get('password'),
    requests: Number(flags.get('requests') ?? 300),
    concurrency: Number(flags.get('concurrency') ?? 25),
    databaseUrl:
      flags.get('database-url') ??
      process.env['DATABASE_DIRECT_URL'] ??
      process.env['DATABASE_URL'],
    json: flags.get('json') === 'true',
  };
}

async function accessTokenFor(options: Options): Promise<string> {
  if (options.token !== undefined) return options.token;

  if (
    options.clientSlug === undefined ||
    options.email === undefined ||
    options.password === undefined
  ) {
    throw new Error('Pass --token, or all of --client-slug, --email and --password.');
  }

  const response = await fetch(`${options.baseUrl}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      email: options.email,
      password: options.password,
      client_slug: options.clientSlug,
    }),
  });

  if (!response.ok) {
    throw new Error(`Login failed with ${response.status}: ${await response.text()}`);
  }
  return ((await response.json()) as { access_token: string }).access_token;
}

/**
 * {@link readScanCounts}, but not until the counters have stopped moving.
 *
 * The delta this tool reports is only meaningful if the meter is still before
 * the burst starts, and Postgres does not make that free: a backend flushes its
 * pending statistics at transaction end but no more often than once every half
 * second, and the `pg_stat_*` views cache a snapshot per session until
 * `pg_stat_clear_snapshot()` is called.
 *
 * Read the "before" figure the instant this tool starts, and whatever the
 * *previous* work did — the caller's fixture seeding, its warm-up request, the
 * e2e suite that ran a moment earlier against the same database — is still
 * unflushed. It then lands in the "after" reading and is charged to the burst.
 *
 * That is not hypothetical. It is what made `load-smoke.e2e.ts` fail on a CI
 * runner while passing on every developer machine: 44 scans attributed to a
 * burst that had made none, because a slower machine finished the preceding
 * suite closer to the snapshot. The "after" reading already waits for exactly
 * this reason; the "before" reading simply never did.
 *
 * Polls rather than sleeping a fixed interval, so a quiet database costs one
 * round-trip and a busy one is still bounded.
 */
async function settledScanCounts(client: Client): Promise<Record<string, number>> {
  const snapshot = async (): Promise<Record<string, number>> => {
    await client.query('select pg_stat_clear_snapshot()');
    return readScanCounts(client);
  };

  let previous = await snapshot();
  for (let attempt = 0; attempt < STATS_SETTLE_ATTEMPTS; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, STATS_FLUSH_INTERVAL_MS));
    const current = await snapshot();
    if (RESOLUTION_TABLES.every((table) => current[table] === previous[table])) {
      return current;
    }
    previous = current;
  }
  // Still moving after the cap: report what we have rather than hanging. The
  // delta will be noisy, which the budget exists to absorb.
  return previous;
}

/** `seq_scan + idx_scan` per resolution table, from the shared stats view. */
async function readScanCounts(
  client: Client,
): Promise<Record<string, number>> {
  const result = await client.query(
    `select relname,
            coalesce(seq_scan, 0) + coalesce(idx_scan, 0) as scans
       from pg_stat_all_tables
      where schemaname = 'iam' and relname = any($1)`,
    [[...RESOLUTION_TABLES]],
  );

  return Object.fromEntries(
    (result.rows as { relname: string; scans: string }[]).map((row) => [
      row.relname,
      Number(row.scans),
    ]),
  );
}

function percentile(sorted: readonly number[], fraction: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(fraction * sorted.length) - 1),
  );
  return Math.round(sorted[index] * 100) / 100;
}

export async function runLoadSmoke(
  options: Options,
): Promise<LoadSmokeResult> {
  const token = await accessTokenFor(options);
  const url = `${options.baseUrl}${options.path}`;
  const headers = { authorization: `Bearer ${token}` };

  // Warm the entry first. Measuring a cold cache would measure the miss path,
  // which is not the claim — and one miss among three hundred hits would be
  // invisible in the deltas anyway.
  const warmup = await fetch(url, { headers });
  if (!warmup.ok) {
    throw new Error(`Warm-up resolve failed with ${warmup.status}.`);
  }
  await warmup.text();

  let stats: Client | undefined;
  let before: Record<string, number> | undefined;
  if (options.databaseUrl !== undefined) {
    stats = new Client({ connectionString: options.databaseUrl });
    await stats.connect();
    before = await settledScanCounts(stats);
  }

  const latencies: number[] = [];
  const statuses: Record<string, number> = {};
  let issued = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = issued++;
      if (index >= options.requests) return;

      const startedAt = performance.now();
      const response = await fetch(url, { headers });
      await response.text();
      latencies.push(performance.now() - startedAt);

      const key = String(response.status);
      statuses[key] = (statuses[key] ?? 0) + 1;
    }
  };

  const startedAt = performance.now();
  await Promise.all(
    Array.from({ length: Math.max(1, options.concurrency) }, () => worker()),
  );
  const durationMs = performance.now() - startedAt;

  let scanDelta: Record<string, number> | null = null;
  if (stats !== undefined && before !== undefined) {
    // Backends flush their pending statistics at transaction end, but no more
    // often than once a second, so a read taken the instant the burst finishes
    // under-reports it. The wait only ever *raises* the measured delta, which
    // matters for the control run — the hit-path assertion would pass either
    // way, and passing for the wrong reason is what this avoids.
    await new Promise((resolve) => setTimeout(resolve, 2_000));

    // This session also caches its snapshot; clearing it forces a fresh read.
    await stats.query('select pg_stat_clear_snapshot()');
    const after = await readScanCounts(stats);
    scanDelta = Object.fromEntries(
      RESOLUTION_TABLES.map((table) => [
        table,
        (after[table] ?? 0) - (before?.[table] ?? 0),
      ]),
    );
    await stats.end();
  }

  const sorted = [...latencies].sort((a, b) => a - b);
  const failures = options.requests - (statuses['200'] ?? 0);

  // One scan per ten requests still means the cache is answering; more than
  // that and something is reaching the tables on the hit path.
  const scanBudget = Math.max(5, Math.floor(options.requests / 10));
  const withinBudget =
    scanDelta === null ||
    Object.values(scanDelta).every((delta) => delta <= scanBudget);

  return {
    path: options.path,
    requests: options.requests,
    concurrency: options.concurrency,
    failures,
    statuses,
    durationMs: Math.round(durationMs),
    requestsPerSecond: Math.round((options.requests / durationMs) * 1000),
    latencyMs: {
      p50: percentile(sorted, 0.5),
      p95: percentile(sorted, 0.95),
      p99: percentile(sorted, 0.99),
      max: percentile(sorted, 1),
    },
    scanDelta,
    scanBudget,
    passed: failures === 0 && withinBudget,
  };
}

function report(result: LoadSmokeResult): void {
  console.log(
    `\n${result.path} × ${result.requests} at concurrency ${result.concurrency}\n` +
      `  ${result.requestsPerSecond} req/s over ${result.durationMs} ms\n` +
      `  latency  p50 ${result.latencyMs.p50} ms · p95 ${result.latencyMs.p95} ms · ` +
      `p99 ${result.latencyMs.p99} ms · max ${result.latencyMs.max} ms\n` +
      `  statuses ${JSON.stringify(result.statuses)}`,
  );

  if (result.scanDelta === null) {
    console.log(
      '  scans    not measured (no DATABASE_DIRECT_URL / --database-url), so the ' +
        'cache-hit claim was NOT checked',
    );
    return;
  }

  console.log(
    `  scans    ${JSON.stringify(result.scanDelta)} (budget ${result.scanBudget} per table)`,
  );
  console.log(
    result.passed
      ? '  ✔ the cache answered — the resolution tables were not read\n'
      : '  ✘ the resolution tables were read on the hit path\n',
  );
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const result = await runLoadSmoke(options);

  if (options.json) {
    console.log(JSON.stringify(result));
  } else {
    report(result);
  }

  if (!result.passed) process.exitCode = 1;
}

// Only when run as a program — the e2e wrapper spawns this file, and a future
// caller may want `runLoadSmoke` on its own.
if (process.argv[1]?.includes('load-smoke')) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
