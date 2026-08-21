/**
 * Shared plumbing for the migration integration suites.
 *
 * These are the tests that actually prove Doc 01 §6 / Doc 07 §9 — a constraint
 * is only real once the database refuses the insert. They need a database, so
 * they skip (loudly, in the suite name) when `DATABASE_DIRECT_URL` is not set:
 *
 *   docker compose up -d postgres
 *   npx nx test @plantops/db          # jest.config.cts loads the root .env
 *
 * The suites are **destructive**: they drop and rebuild the `iam` schema. Point
 * them at a scratch database, never one with data you want. `jest.config.cts`
 * runs this project's specs serially so two suites cannot rebuild it at once.
 *
 * Test-only, and excluded from `tsconfig.lib.json` — nothing here ships in
 * `@plantops/db`.
 */

import { DataSource, QueryFailedError } from 'typeorm';
import { MIGRATIONS_TABLE_NAME, createMigrationDataSource } from '../data-source.js';
import { IAM_SCHEMA, IAM_SCHEMA_TEST_LOCK_ID } from '../schema.js';

/**
 * Markers of a connection string that was pasted but never filled in:
 * `REPLACE_ME` from `.env.example`, and the `[YOUR-PASSWORD]` / `<password>`
 * placeholders the Supabase dashboard hands you. None can appear in a real
 * URL — `[` and `]` are reserved in a userinfo component.
 */
const PLACEHOLDER = /REPLACE_ME|[[\]<>]/;

/**
 * A *usable* connection string, not merely a set variable — a `.env` copied
 * from the template carries placeholders, and eighty connection failures is a
 * worse signal than a skip.
 */
const url = (process.env['DATABASE_DIRECT_URL'] ?? '').trim();
const configured = /^postgres(ql)?:\/\/\S+@\S+/.test(url) && !PLACEHOLDER.test(url);

export const DATABASE_DIRECT_URL = configured ? url : undefined;

/**
 * Skipping rather than failing is deliberate: `nx test` must stay green for a
 * contributor without a database, while CI (Session 39) sets the variable and
 * gets the real coverage.
 */
export const describeWithDb = DATABASE_DIRECT_URL ? describe : describe.skip;

/** A Postgres error, narrowed to the two fields these assertions read. */
export interface DbFailure {
  /** SQLSTATE — `23505` unique, `23514` check, `23503` FK, `22P02` enum. */
  code?: string;
  message: string;
}

export interface IntegrationHarness {
  /** The live data source. Only valid between `connect()` and `dispose()`. */
  readonly dataSource: DataSource;
  query<T = unknown>(sql: string, params?: unknown[]): Promise<T[]>;
  /** The single row a query was written to return, or a legible failure. */
  queryOne<T>(sql: string, params?: unknown[]): Promise<T>;
  /** Runs `sql` and returns the Postgres error, asserting that it failed. */
  expectFailure(sql: string, params?: unknown[]): Promise<DbFailure>;
  /** Drops the `iam` schema and the migration log, then runs the full chain. */
  rebuild(): Promise<void>;
  /**
   * Lifts `force row level security` from every `iam` table.
   *
   * For the **constraint** suites only. Those prove Doc 01 §6 by watching
   * Postgres refuse an insert, and they connect as the owner — who migration
   * 0007 deliberately subjects to policy (Doc 07 §5.1). Left in place, every
   * fixture insert would be rejected by a *policy*, and a test asserting a
   * check-constraint violation would pass on the wrong error code: a suite
   * that goes green for the wrong reason, which is the exact failure mode
   * §5.1 exists to prevent.
   *
   * The isolation suite never calls this — it rebuilds and connects as the
   * app role, with FORCE intact, because that is what it is testing.
   *
   * **Undone by {@link IntegrationHarness.dispose}**, which is not a nicety.
   * `iam` is one schema shared by every suite in the workspace and by the
   * hardening battery, so a suite that leaves FORCE off hands the next process
   * a database in which ownership silently bypasses every policy. `iam-api`
   * refuses to boot against exactly that (`assertRlsEnforceable`), which is how
   * this was found: the battery died at startup naming fifteen unforced tables,
   * long after the suite that relaxed them had finished and gone green.
   */
  relaxForcedRowSecurity(): Promise<void>;
  dispose(): Promise<void>;
}

/**
 * Opens the migration connection (the direct endpoint — DDL under PgBouncer
 * transaction mode is a good way to lose a schema halfway) and returns the
 * helpers the suites share.
 */
export async function connectHarness(): Promise<IntegrationHarness> {
  const dataSource = createMigrationDataSource({
    // Migrations run over the direct endpoint; the app URL is unused here.
    DATABASE_URL: DATABASE_DIRECT_URL as string,
    DATABASE_DIRECT_URL: DATABASE_DIRECT_URL as string,
    DATABASE_SSL: process.env['DATABASE_SSL'] === 'true',
    NODE_ENV: 'test',
  });
  await dataSource.initialize();

  // Claim the shared schema before touching it. These suites drop and rebuild
  // `iam`, and `@plantops/iam-api`'s RLS suite reads it from another Nx
  // project that `nx run-many` may be running at the same moment. The lock is
  // session-scoped and this data source has `poolSize: 1`, so it is held for
  // exactly as long as the harness lives and released by `dispose()`.
  await dataSource.query('select pg_advisory_lock($1)', [IAM_SCHEMA_TEST_LOCK_ID]);

  const query = async <T = unknown>(sql: string, params?: unknown[]): Promise<T[]> =>
    (await dataSource.query(sql, params)) as T[];

  /** Tables `relaxForcedRowSecurity` turned FORCE off on, for `dispose` to restore. */
  let forced: string[] = [];

  return {
    dataSource,
    query,

    async queryOne<T>(sql: string, params?: unknown[]): Promise<T> {
      const [row] = await query<T>(sql, params);
      if (row === undefined) throw new Error(`Expected one row from:\n${sql}`);
      return row;
    },

    async expectFailure(sql: string, params?: unknown[]): Promise<DbFailure> {
      try {
        await query(sql, params);
      } catch (error) {
        const driverError = error as QueryFailedError & { code?: string };
        return { code: driverError.code, message: driverError.message };
      }
      throw new Error(`Expected the database to reject:\n${sql}`);
    },

    async rebuild(): Promise<void> {
      // Start from nothing so "runs on a clean DB" is what is actually tested.
      await query(`drop schema if exists ${IAM_SCHEMA} cascade`);
      await query(`drop table if exists "${MIGRATIONS_TABLE_NAME}"`);
      await dataSource.runMigrations({ transaction: 'each' });
    },

    async relaxForcedRowSecurity(): Promise<void> {
      // Which tables were forced, so the restore puts back exactly those.
      // A blanket re-force would be wrong: `audit_trail` is deliberately left
      // un-forced (Doc 07 §5.1), because the app role is blocked there by
      // privilege rather than by policy.
      const tables = await query<{ relname: string }>(
        `select c.relname
           from pg_class c
           join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = $1 and c.relkind = 'r' and c.relforcerowsecurity`,
        [IAM_SCHEMA],
      );
      forced = tables.map(({ relname }) => relname);
      for (const table of forced) {
        await query(`alter table "${IAM_SCHEMA}"."${table}" no force row level security`);
      }
    },

    async dispose(): Promise<void> {
      // Put FORCE back before letting go of the schema — see
      // `relaxForcedRowSecurity`. Best-effort: a suite that already dropped the
      // schema has nothing to restore, and failing here would replace a real
      // test result with a teardown error.
      for (const table of forced) {
        await query(
          `alter table "${IAM_SCHEMA}"."${table}" force row level security`,
        ).catch(() => undefined);
      }
      forced = [];

      // Destroying the connection releases the advisory lock with it; the
      // explicit unlock keeps the intent visible and covers a pooled reuse.
      if (dataSource.isInitialized) {
        await dataSource
          .query('select pg_advisory_unlock($1)', [IAM_SCHEMA_TEST_LOCK_ID])
          .catch(() => undefined);
        await dataSource.destroy();
      }
    },
  };
}
