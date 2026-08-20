/**
 * The two database connections this battery needs, and why it needs two.
 *
 * Almost everything here is driven over HTTP. Two things cannot be:
 *
 * 1. **The RLS isolation battery.** Its claim is that the *database* refuses to
 *    leak even when the application forgets to filter (Doc 07 §5–6). Proving
 *    that means issuing a deliberately tenant-unfiltered query — something no
 *    endpoint will ever do for you — as the **app role**, with
 *    `force row level security` intact.
 * 2. **Purging a fixture.** Tenants are created through the API and there is no
 *    `DELETE /iam/clients` (by design: Doc 02 keeps tenant data). A repeatable
 *    suite has to remove its own leftovers out of band.
 *
 * Notably *not* on that list: expiring a binding. `role_binding.expires_at` in
 * the past cannot be created through the API, so the obvious move is to age the
 * row with SQL — and the suites deliberately do not, because a binding aged
 * behind the API's back skips the invalidation hook and the assertion stops
 * being about the running system. They set an expiry two seconds out and wait
 * instead.
 *
 * ## Two roles, and the difference is the whole point
 *
 * - {@link connectAppRole} uses `DATABASE_URL` — `plantops_app`, which owns
 *   nothing and has no `BYPASSRLS`. Policies apply to it. Every assertion in
 *   `rls-isolation.e2e.ts` runs here, and that file's first block checks the
 *   connection really is that role *before* any of them — run as the owner the
 *   same assertions pass with every policy inert (Doc 07 §5.1), which is a green
 *   suite that is evidence of nothing.
 * - {@link connectOwner} uses `DATABASE_DIRECT_URL` — the migration role, used
 *   only for (2). Never for an assertion.
 *
 * A single `Client` each rather than a `Pool`: the fixture sets its context
 * with session-scoped `set_config`, and a pool would apply it to whichever
 * connection happened to answer.
 */

import { Client } from 'pg';

/** Everything lives in the `iam` schema, never `public` (Doc 07 §2). */
export const S = '"iam"';

/**
 * Markers of a connection string that was pasted but never filled in — the same
 * check `libs/db/src/testing/integration-harness.ts` makes, for the same
 * reason: eighty connection failures is a worse signal than one clear message.
 */
const PLACEHOLDER = /REPLACE_ME|[[\]<>]/;

function usableUrl(name: string): string {
  const url = (process.env[name] ?? '').trim();
  if (!/^postgres(ql)?:\/\/\S+@\S+/.test(url) || PLACEHOLDER.test(url)) {
    throw new Error(
      `${name} is not a usable connection string. The battery needs a real ` +
        `Postgres — see docs/local-testing.md §1.`,
    );
  }
  return url;
}

async function connect(url: string): Promise<Client> {
  const client = new Client({ connectionString: url });
  await client.connect();
  return client;
}

/** The runtime role: owns nothing, enforces every policy. */
export function connectAppRole(): Promise<Client> {
  return connect(usableUrl('DATABASE_URL'));
}

/** The migration role: for fixtures and ageing rows, never for assertions. */
export function connectOwner(): Promise<Client> {
  return connect(usableUrl('DATABASE_DIRECT_URL'));
}

export async function rows<T>(
  client: Client,
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  const result = await client.query(sql, params);
  return result.rows as T[];
}

export async function one<T>(
  client: Client,
  sql: string,
  params: unknown[] = [],
): Promise<T> {
  const [row] = await rows<T>(client, sql, params);
  if (row === undefined) throw new Error(`Expected one row from:\n${sql}`);
  return row;
}

/** The three session variables every policy in migrations 0007–0009 reads. */
export interface RlsContext {
  clientId?: string;
  userId?: string;
  platformAdmin?: boolean;
}

/**
 * Runs `fn` inside a transaction carrying `context`, and **always rolls back**.
 *
 * Transaction-local `set_config` (the `true` third argument), exactly as
 * `applyRlsContext()` does it in the shipped code — a session-scoped one would
 * leak into the next case and turn an isolation suite into a suite about
 * whichever context ran last. The rollback means a probe that deliberately
 * attempts a forbidden write leaves nothing behind even when the write is
 * (wrongly) permitted, which is the case the suite exists to catch.
 */
export async function withRlsContext<T>(
  client: Client,
  context: RlsContext,
  fn: () => Promise<T>,
): Promise<T> {
  await client.query('begin');
  try {
    await applyContext(client, context);
    return await fn();
  } finally {
    await client.query('rollback');
  }
}

/** Attempts `sql` under `context` and returns the Postgres error it raised. */
export async function expectRejection(
  client: Client,
  context: RlsContext,
  sql: string,
  params: unknown[] = [],
): Promise<{ code?: string; message: string }> {
  return await withRlsContext(client, context, async () => {
    try {
      await client.query(sql, params);
    } catch (error) {
      const failure = error as Error & { code?: string };
      return { code: failure.code, message: failure.message };
    }
    throw new Error(`Expected the database to reject:\n${sql}`);
  });
}

/**
 * Points the **owner** connection at one tenant, session-scoped.
 *
 * Only for the fixture teardown paths. `force row level security` applies to
 * the owner too (Doc 07 §5.1), so without a context the purge below would find
 * nothing and silently leave the tenants in place.
 */
export async function elevateOwner(
  owner: Client,
  clientId?: string,
): Promise<void> {
  await applyContext(
    owner,
    { platformAdmin: true, clientId: clientId ?? '' },
    false,
  );
}

async function applyContext(
  client: Client,
  context: RlsContext,
  transactionLocal = true,
): Promise<void> {
  const settings: Array<[string, string]> = [
    ['app.is_platform_admin', context.platformAdmin === true ? 'true' : 'false'],
  ];
  if (context.clientId !== undefined) {
    settings.push(['app.current_client_id', context.clientId]);
  }
  if (context.userId !== undefined) {
    settings.push(['app.current_user_id', context.userId]);
  }

  for (const [key, value] of settings) {
    await client.query('select set_config($1, $2, $3)', [
      key,
      value,
      transactionLocal,
    ]);
  }
}
