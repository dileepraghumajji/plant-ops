/**
 * **The load smoke, run rather than merely shipped.**
 *
 * Doc 08 §7 / roadmap Session 38 asks for one performance property and only one:
 * *a cached resolve stays DB-free under concurrent load*. `tools/load-smoke.ts`
 * is what measures it — this file is what makes the measurement part of the
 * battery instead of a tool somebody remembers to run.
 *
 * It spawns the tool as a program rather than importing it. Two reasons, and the
 * first is the one that matters:
 *
 * 1. **The tool is the deliverable, so the tool is what gets tested.** A spec
 *    that imported `runLoadSmoke` would leave the argument parsing, the login
 *    path and the exit code — everything Session 39 will actually use against
 *    staging — completely unexercised.
 * 2. `tools/` sits outside the project graph on purpose (`tools/migrate.ts`
 *    explains why: it is the one place `@plantops/db` and `@plantops/config` may
 *    both be imported). Reaching into it from a project's `src/` would be a
 *    relative import out of the compilation root.
 *
 * The thresholds are the tool's, not this file's — see its header for why a
 * smoke test asserts on scan counts and prints latency without defending it.
 */

import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { expectOk, type Caller } from './support/api';
import { WORKSPACE_ROOT } from './support/api-process';
import {
  callerFor,
  PERM,
  seedTwoTenants,
  type TwoTenants,
} from './support/two-tenant-fixture';

const PREFIX = 'e2e-load-';

interface LoadSmokeResult {
  requests: number;
  failures: number;
  statuses: Record<string, number>;
  requestsPerSecond: number;
  latencyMs: { p50: number; p95: number; p99: number; max: number };
  scanDelta: Record<string, number> | null;
  scanBudget: number;
  passed: boolean;
}

/** Runs `tools/load-smoke.ts` under `tsx` and returns its `--json` payload. */
function runLoadSmoke(args: readonly string[]): Promise<{
  code: number | null;
  result?: LoadSmokeResult;
  output: string;
}> {
  return new Promise((resolve, reject) => {
    // `node <tsx cli>` rather than the `tsx` shim: Node refuses to `spawn` a
    // `.cmd` without a shell on Windows (EINVAL since the 2024 argument-injection
    // fix), and reaching for `shell: true` to work around that would put the
    // arguments — one of which is a bearer token — through a command line.
    const child = spawn(
      process.execPath,
      [
        join(WORKSPACE_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs'),
        join('tools', 'load-smoke.ts'),
        ...args,
        '--json',
      ],
      {
        cwd: WORKSPACE_ROOT,
        env: { ...process.env, NODE_OPTIONS: '--conditions=@plantops/source' },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    child.on('error', reject);
    child.on('close', (code) => {
      // The tool prints exactly one JSON line under `--json`; anything else on
      // the stream is a loader warning worth keeping in the failure message.
      // The last JSON line, not the first: `findLast` would say this more
      // directly, but the workspace's `lib` target predates it.
      const jsonLines = stdout
        .split('\n')
        .map((entry) => entry.trim())
        .filter((entry) => entry.startsWith('{'));
      const line = jsonLines[jsonLines.length - 1];
      resolve({
        code,
        result: line === undefined ? undefined : (JSON.parse(line) as LoadSmokeResult),
        output: `${stdout}\n${stderr}`,
      });
    });
  });
}

describe('resolve load smoke (Doc 04 §6)', () => {
  let fixture: TwoTenants;
  let operator: Caller;

  beforeAll(async () => {
    fixture = await seedTwoTenants(PREFIX);
    operator = await callerFor(fixture.alpha, fixture.alpha.operator);
  });

  it('answers a burst of concurrent resolves without reading the resolution tables', async () => {
    // A subject with real grants: an empty answer could be served correctly by a
    // cache that never held anything.
    const grants = expectOk(
      await operator.get<{ permissions: string[] }>('/iam/permissions/resolve'),
      'resolve',
    );
    expect(grants.permissions).toEqual([PERM.CREATE]);

    const { code, result, output } = await runLoadSmoke([
      '--base-url',
      process.env['E2E_BASE_URL'] as string,
      '--token',
      operator.token as string,
      '--requests',
      '300',
      '--concurrency',
      '25',
    ]);

    if (result === undefined) {
      throw new Error(`load-smoke produced no result:\n${output}`);
    }

    expect(result.failures).toBe(0);
    expect(result.statuses).toEqual({ '200': 300 });

    // The claim. `null` would mean the tool could not reach a database and
    // quietly checked nothing, which must fail rather than pass.
    expect(result.scanDelta).not.toBeNull();

    // Asserted as one object rather than a loop of `toBeLessThanOrEqual`, so a
    // failure prints *which* tables were read and by how much next to the
    // budget. The loop's version reported a bare "expected <= 30, received 44"
    // with no table named — enough to know something was wrong and not enough
    // to tell whether the cache had failed or the meter had.
    const overBudget = Object.entries(result.scanDelta ?? {}).filter(
      ([, delta]) => delta > result.scanBudget,
    );
    expect({
      overBudget,
      scanDelta: result.scanDelta,
      budget: result.scanBudget,
    }).toEqual({
      overBudget: [],
      scanDelta: result.scanDelta,
      budget: result.scanBudget,
    });

    expect(result.passed).toBe(true);
    expect(code).toBe(0);

    console.log(
      `    resolve: ${result.requestsPerSecond} req/s, p95 ${result.latencyMs.p95} ms, ` +
        `scans ${JSON.stringify(result.scanDelta)}`,
    );
  }, 180_000);

  /**
   * The control, and the case that makes the one above mean something.
   *
   * Zero scans is what a working cache looks like and also what a broken meter
   * looks like — a mistyped table name, a stats view that never moved, a
   * `--database-url` pointing at the wrong database. So the same burst is fired
   * at `?applicationId=`, the slice Doc 04 §6 deliberately never caches, and the
   * counters must move. If this ever goes quiet, the previous case is no longer
   * evidence of anything.
   */
  it('reads those very tables when the cache is bypassed — so the meter is real', async () => {
    const { result, output } = await runLoadSmoke([
      '--base-url',
      process.env['E2E_BASE_URL'] as string,
      '--token',
      operator.token as string,
      '--path',
      `/iam/permissions/resolve?applicationId=${fixture.opsApplicationId}`,
      '--requests',
      '60',
      '--concurrency',
      '10',
    ]);

    if (result === undefined) {
      throw new Error(`load-smoke produced no result:
${output}`);
    }

    expect(result.failures).toBe(0);

    const deltas = Object.values(result.scanDelta ?? {});
    expect(deltas.length).toBeGreaterThan(0);
    // Per-table counts vary with the plan the planner picks and with how much
    // of the burst the stats collector had flushed, so the assertion is on the
    // total rather than on any one table.
    expect(deltas.reduce((total, delta) => total + delta, 0)).toBeGreaterThan(
      result.requests / 2,
    );

    // And the tool says so: an uncached path is exactly what it is built to
    // fail on.
    expect(result.passed).toBe(false);
  }, 180_000);

  it('exits non-zero when it cannot even authenticate — a broken smoke is not a passing one', async () => {
    const { code } = await runLoadSmoke([
      '--base-url',
      process.env['E2E_BASE_URL'] as string,
      '--token',
      'not-a-token',
      '--requests',
      '5',
      '--concurrency',
      '1',
    ]);

    expect(code).toBe(1);
  }, 120_000);
});
