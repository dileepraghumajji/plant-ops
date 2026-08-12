/**
 * TypeORM data sources for the IAM (Doc 07 §2–3).
 *
 * Two connections, deliberately different:
 *
 * - **app** — the Supabase *pooler* (PgBouncer/Supavisor, transaction mode).
 *   Short-lived server connections handed back after every transaction, so
 *   nothing may pin session state to one: no prepared statements, no
 *   `CREATE EXTENSION` at connect, and (from Session 5 on) RLS context set
 *   with `set_config(..., true)` — transaction-local, never session-local.
 * - **migration** — the *direct*, non-pooled endpoint. DDL, advisory locks and
 *   long transactions all need a real session, and the release step runs here
 *   before the app swaps over (Doc 08 §6).
 *
 * `libs/db` may depend only on `@plantops/contracts` (Doc 08 §2), so this file
 * takes a narrow settings object rather than importing `@plantops/config`.
 * `apps/iam-api` passes the validated env through.
 */

import { DataSource, type DataSourceOptions } from 'typeorm';
import { entities } from './entities/index.js';
import { migrations } from './migrations/index.js';

/**
 * The slice of the validated environment this module needs. `EnvConfig` from
 * `@plantops/config` is structurally assignable to it.
 */
export interface DbConnectionSettings {
  /** Pooler endpoint — the application's connection (Doc 07 §2). */
  DATABASE_URL: string;
  /** Direct, non-pooled endpoint — migrations only (Doc 07 §2). */
  DATABASE_DIRECT_URL: string;
  DATABASE_SSL: boolean;
  NODE_ENV?: 'development' | 'test' | 'production';
}

/**
 * TypeORM's own bookkeeping table. It stays in the connection's default schema
 * because migration 0001 is what creates `iam` — see `schema.ts`.
 */
export const MIGRATIONS_TABLE_NAME = 'migration';

/** Pool ceiling for the app connection; the pooler multiplexes behind it. */
export const APP_POOL_SIZE = 10;

/**
 * The Postgres arm of TypeORM's `DataSourceOptions` union, named without a
 * deep import into `typeorm/driver/...`.
 */
export type PostgresDataSourceOptions = Extract<DataSourceOptions, { type: 'postgres' }>;

/**
 * Options shared by both connections.
 *
 * `synchronize` is false and stays false — everywhere, in every environment
 * (Doc 07 §3). Schema changes are reviewed migrations or they do not happen.
 */
function baseOptions(settings: DbConnectionSettings): PostgresDataSourceOptions {
  return {
    type: 'postgres',
    entities: [...entities],
    migrations: [...migrations],
    migrationsTableName: MIGRATIONS_TABLE_NAME,
    synchronize: false,
    dropSchema: false,
    migrationsRun: false,
    /**
     * `@PrimaryGeneratedColumn('uuid')` resolves to `gen_random_uuid()` rather
     * than `uuid_generate_v4()`, matching the `pgcrypto` extension migration
     * 0001 installs (Doc 07 §2).
     */
    uuidExtension: 'pgcrypto',
    /**
     * Never let the ORM issue `CREATE EXTENSION` on connect: the app role is a
     * non-superuser by design (Doc 07 §5) and extensions are migration-owned.
     */
    installExtensions: false,
    ssl: settings.DATABASE_SSL ? { rejectUnauthorized: true } : false,
    logging:
      settings.NODE_ENV === 'development'
        ? ['error', 'warn', 'migration']
        : ['error'],
  };
}

/**
 * Options for the request-serving connection, against the pooler.
 *
 * On prepared statements: TypeORM's Postgres driver calls
 * `client.query(sql, params)` and never supplies a statement `name`, so
 * node-postgres uses the unnamed extended-query path — nothing is ever
 * `PREPARE`d into a server connection that the pooler may hand to someone
 * else. There is no TypeORM flag to turn off; the guarantee comes from not
 * introducing a code path that names a statement, and from `installExtensions`
 * and `synchronize` being off so the driver runs no session-level setup.
 */
export function createAppDataSourceOptions(
  settings: DbConnectionSettings,
): PostgresDataSourceOptions {
  return {
    ...baseOptions(settings),
    url: settings.DATABASE_URL,
    poolSize: APP_POOL_SIZE,
    applicationName: 'plantops-iam-api',
  };
}

/**
 * Options for the migration connection, against the direct endpoint.
 *
 * One connection, and `migrationsTransactionMode: 'each'` so a failing
 * migration rolls back on its own rather than leaving a half-applied chain.
 */
export function createMigrationDataSourceOptions(
  settings: DbConnectionSettings,
): PostgresDataSourceOptions {
  return {
    ...baseOptions(settings),
    url: settings.DATABASE_DIRECT_URL,
    poolSize: 1,
    applicationName: 'plantops-iam-migrations',
    migrationsTransactionMode: 'each',
  };
}

/** The request-serving data source. Not initialized — the caller owns that. */
export function createAppDataSource(settings: DbConnectionSettings): DataSource {
  return new DataSource(createAppDataSourceOptions(settings));
}

/** The migration data source, used by `tools/migrate.ts` and the release step. */
export function createMigrationDataSource(
  settings: DbConnectionSettings,
): DataSource {
  return new DataSource(createMigrationDataSourceOptions(settings));
}
