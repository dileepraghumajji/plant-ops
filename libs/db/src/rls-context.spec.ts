/**
 * `withProvisioningTenant` — the one function allowed to repoint the tenant
 * context (Doc 07 §6).
 *
 * These run against a recording fake rather than Postgres, because what is being
 * pinned here is the *sequence of statements the function emits*: that it refuses
 * before it changes anything, that it changes only the tenant, and that it puts
 * the old value back. A real database would prove the same things more slowly and
 * would not distinguish "restored the previous value" from "happened to end on
 * the same value".
 *
 * What Postgres has to prove instead — that the switched context actually
 * satisfies the tenant policies' `with check` — is the Session 15 suite in
 * `apps/iam-api/src/clients/clients.integration.spec.ts`.
 */

import { RLS_SETTINGS, withProvisioningTenant } from './rls-context.js';

const PLATFORM = '11111111-1111-4111-8111-111111111111';
const TARGET = '22222222-2222-4222-8222-222222222222';

interface Recorded {
  sql: string;
  parameters?: unknown[];
}

interface FakeExecutor {
  queries: Recorded[];
  /**
   * Flipped by a test to make every subsequent `set_config` fail — what
   * Postgres does to the rest of a transaction once any statement in it has
   * errored.
   */
  aborted: boolean;
  query<T = unknown>(sql: string, parameters?: unknown[]): Promise<T>;
}

/**
 * An executor that answers the context probe and records everything else.
 *
 * `platform` is what the fake reports for `app.is_platform_admin`, which is the
 * only input the guard has — mirroring production, where the value is derived by
 * `applyRlsContext` and cannot be supplied by a caller.
 */
function fakeExecutor(platform: boolean, previous = PLATFORM): FakeExecutor {
  const executor: FakeExecutor = {
    queries: [],
    aborted: false,
    query<T = unknown>(sql: string, parameters?: unknown[]): Promise<T> {
      executor.queries.push({ sql, parameters });
      if (executor.aborted && sql.includes('set_config')) {
        return Promise.reject(new Error('current transaction is aborted'));
      }
      if (sql.includes('current_setting')) {
        return Promise.resolve([{ platform, previous }] as T);
      }
      return Promise.resolve([] as T);
    },
  };
  return executor;
}

/** The `set_config` calls, as `[setting, value]` pairs, in order. */
function settings(queries: readonly Recorded[]): [string, string][] {
  return queries
    .filter((recorded) => recorded.sql.includes('set_config'))
    .map((recorded) => [
      String(recorded.parameters?.[0]),
      String(recorded.parameters?.[1]),
    ]);
}

describe('withProvisioningTenant', () => {
  it('points the tenant at the target and puts the previous value back', async () => {
    const executor = fakeExecutor(true);

    const result = await withProvisioningTenant(executor, TARGET, () =>
      Promise.resolve('done'),
    );

    expect(result).toBe('done');
    expect(settings(executor.queries)).toEqual([
      [RLS_SETTINGS.CLIENT_ID, TARGET],
      [RLS_SETTINGS.CLIENT_ID, PLATFORM],
    ]);
  });

  it('never touches the platform flag', async () => {
    // The flag is derived authority (Doc 04 §10). Narrowing the tenant under it
    // is what this function does; granting it is what it must never do.
    const executor = fakeExecutor(true);
    await withProvisioningTenant(executor, TARGET, () => Promise.resolve(null));

    const touched = settings(executor.queries).map(([setting]) => setting);
    expect(touched).not.toContain(RLS_SETTINGS.IS_PLATFORM_ADMIN);
    expect(touched).not.toContain(RLS_SETTINGS.USER_ID);
  });

  it('refuses a non-platform context, before changing anything', async () => {
    const executor = fakeExecutor(false);
    const work = jest.fn();

    await expect(
      withProvisioningTenant(executor, TARGET, work as () => Promise<void>),
    ).rejects.toThrow(/platform-admin context/);

    // The refusal is the whole security property: an ordinary tenant subject
    // must not be able to reach a state where their writes land elsewhere.
    expect(work).not.toHaveBeenCalled();
    expect(settings(executor.queries)).toEqual([]);
  });

  it('restores the context when the work throws', async () => {
    const executor = fakeExecutor(true);

    await expect(
      withProvisioningTenant(executor, TARGET, () => Promise.reject(new Error('boom'))),
    ).rejects.toThrow('boom');

    expect(settings(executor.queries)).toEqual([
      [RLS_SETTINGS.CLIENT_ID, TARGET],
      [RLS_SETTINGS.CLIENT_ID, PLATFORM],
    ]);
  });

  it('lets the work`s own error through when the restore also fails', async () => {
    // The real case: Postgres aborts the transaction block on any error, so the
    // restoring `set_config` is refused too. Surfacing *that* would turn every
    // 409 on this surface into a 500 — see the function's header.
    const executor = fakeExecutor(true);

    await expect(
      withProvisioningTenant(executor, TARGET, () => {
        executor.aborted = true;
        return Promise.reject(new Error('duplicate key value violates unique constraint'));
      }),
    ).rejects.toThrow('duplicate key');
  });
});
