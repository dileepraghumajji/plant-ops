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
import { IAM_SCHEMA } from '../schema.js';

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

  const query = async <T = unknown>(sql: string, params?: unknown[]): Promise<T[]> =>
    (await dataSource.query(sql, params)) as T[];

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

    async dispose(): Promise<void> {
      if (dataSource.isInitialized) await dataSource.destroy();
    },
  };
}
