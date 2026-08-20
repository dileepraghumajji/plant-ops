/**
 * Starting and stopping the **built** `iam-api` bundle for the battery.
 *
 * ## Why this file exists at all
 *
 * The scaffolded arrangement had `nx serve` start the app and `global-setup`
 * merely wait for a port. That is enough for a boot smoke test and not enough
 * for Session 38, for three reasons:
 *
 * 1. **The battery needs a configuration the developer's `.env` does not have.**
 *    `/auth/login` is capped at 10 requests a minute with `failOpen: false`
 *    (`auth.controller.ts`), and the lockout case alone spends five of them.
 *    Under a served-by-`nx` app the suite would be testing the throttle.
 * 2. **The port has to be free.** A fixed `PORT` from `.env` collides with the
 *    dev server a contributor already has running, and `waitForPortOpen` would
 *    then happily connect to *that* — a suite that silently tests the wrong
 *    process.
 * 3. **The reset flow needs the log.** Doc 03 §7's tokenised reset has no mail
 *    transport in v1: `LoggingPasswordResetDelivery` prints the token outside
 *    production, and that is the only place it exists outside the requester.
 *    Capturing stdout is what makes the whole reset → login path reachable
 *    end-to-end without reading the database.
 *
 * So the suite spawns `apps/iam-api/dist/main.js` itself — the real webpack
 * bundle, over a real socket, against the real Postgres and the real Redis.
 * That is the property this project has that the in-process suites in
 * `apps/iam-api` do not: they boot `AppModule` under Jest with a fake Redis,
 * which cannot catch a bundling failure, a missing environment variable, or a
 * Redis command that behaves differently from the fake.
 *
 * ## The deliberate deviations from the shipped configuration
 *
 * | Variable | Value | Why |
 * |---|---|---|
 * | `RATE_LIMIT_ENABLED` | `false` | See (1). The 429 path is covered in-process by `app/http-hardening.spec.ts` and `common/rate-limit.spec.ts`. |
 * | `NODE_ENV` | `test` | Non-production, so the reset token is logged. Nothing else keys off it. |
 * | `PORT` | an OS-assigned free port | See (2). |
 * | `EXPIRY_SWEEP_INTERVAL_SECONDS` | `5` | Doc 04 §7's last row is a *periodic* sweep; at the shipped 60 s a test would have to wait a minute to observe it. |
 * | `REFRESH_REUSE_GRACE_SECONDS` | `10` | The floor of Doc 03 §4's 10–30 s band. The after-the-window reuse case is the one assertion in the battery that has to wait out real time, and this makes the wait as short as the spec allows. |
 * | `NO_COLOR` / `FORCE_COLOR` | set | So the captured log is greppable. |
 *
 * **Nothing else.** The guards, the resolver, the RLS context, the error
 * envelope, the audit writer and the cache are the shipped ones — the point of
 * the battery is that they are.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, openSync } from 'node:fs';
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { dirname, join } from 'node:path';

/** Workspace root — this file is `apps/iam-api-e2e/src/support/`. */
export const WORKSPACE_ROOT = join(__dirname, '..', '..', '..', '..');

/** The bundle `@plantops/iam-api:build` produces, and the suite's subject. */
const BUNDLE = join(WORKSPACE_ROOT, 'apps', 'iam-api', 'dist', 'main.js');

/** Where the running instance's coordinates are published for the workers. */
export const RUNTIME_FILE = join(
  WORKSPACE_ROOT,
  'apps',
  'iam-api-e2e',
  'test-output',
  'e2e',
  'runtime.json',
);

/** Everything a spec file needs to reach the instance global setup started. */
export interface ApiRuntime {
  baseUrl: string;
  /** The captured stdout+stderr of the API process (see the header). */
  logPath: string;
  pid: number;
}

/** An OS-assigned free port, released immediately before the API claims it. */
async function freePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const probe = createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

/**
 * Polls `/ready` until the app reports Postgres **and** Redis up.
 *
 * `/ready` rather than `/health`: liveness answers 200 with a dead database,
 * and a battery that started against one would fail in its fixtures with
 * connection errors instead of here with a legible message.
 */
async function waitForReady(baseUrl: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = 'no response yet';

  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/ready`);
      const body = (await response.json()) as {
        status: string;
        checks: Record<string, string>;
      };
      if (response.status === 200) return;
      lastError = `not ready: ${JSON.stringify(body.checks)}`;
    } catch (error) {
      lastError = (error as Error).message;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error(
    `iam-api did not become ready within ${timeoutMs} ms (${lastError}).\n` +
      `Start the dependencies first — see docs/local-testing.md §1:\n` +
      `  pg_ctl start   # Postgres, with the iam schema migrated\n` +
      `  redis-server   # Redis`,
  );
}

/**
 * Spawns the bundle on a free port and resolves once it is serving.
 *
 * @throws if the bundle is missing (the `@plantops/iam-api:build` dependency on
 *   the `e2e` target should make that unreachable, but a stale `dist` deleted
 *   by hand is a confusing failure to debug from a connection refused).
 */
export async function startApi(): Promise<{
  runtime: ApiRuntime;
  child: ChildProcess;
}> {
  if (!existsSync(BUNDLE)) {
    throw new Error(
      `The iam-api bundle is missing at ${BUNDLE}.\n` +
        `Run \`npx nx build @plantops/iam-api\` (the e2e target depends on it).`,
    );
  }

  mkdirSync(dirname(RUNTIME_FILE), { recursive: true });
  const logPath = join(dirname(RUNTIME_FILE), 'api.log');
  // Truncating: the reset-token scrape searches this file, and a token left
  // over from the previous run is a test that passes against stale state.
  const log = openSync(logPath, 'w');

  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;

  const child = spawn(process.execPath, [BUNDLE], {
    cwd: WORKSPACE_ROOT,
    // `dotenv` inside `main.ts` never overrides what the platform already set,
    // so everything below wins over the workspace `.env` (Doc 08 §5).
    env: {
      ...process.env,
      PORT: String(port),
      NODE_ENV: 'test',
      LOG_LEVEL: 'log',
      RATE_LIMIT_ENABLED: 'false',
      EXPIRY_SWEEP_INTERVAL_SECONDS: '5',
      REFRESH_REUSE_GRACE_SECONDS: '10',
      NO_COLOR: '1',
      FORCE_COLOR: '0',
    },
    stdio: ['ignore', log, log],
  });

  child.unref();

  const exited = new Promise<never>((_, reject) => {
    child.once('exit', (code) => {
      reject(
        new Error(
          `iam-api exited with code ${code} before it was ready. ` +
            `Its output is in ${logPath}.`,
        ),
      );
    });
  });

  await Promise.race([waitForReady(baseUrl, 90_000), exited]);

  return { runtime: { baseUrl, logPath, pid: child.pid as number }, child };
}

/** Stops an instance started by {@link startApi}, tolerating one already gone. */
export async function stopApi(pid: number | undefined): Promise<void> {
  if (pid === undefined) return;
  try {
    process.kill(pid);
  } catch {
    // Already gone — a crashed API is a failure the specs will have reported.
  }
}
