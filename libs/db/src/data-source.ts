/**
 * TypeORM data sources for the IAM (Doc 07 §2–3).
 *
 * Two connections, deliberately different:
 *
 * - **app** — `DATABASE_URL`, the connection that serves requests. Whether a
 *   transaction-mode pooler (PgBouncer/Supavisor) sits in front of it is
 *   `DATABASE_POOLED`, and it is *configuration*, not an inference from the
 *   variable's name. When it is pooled, server connections are handed back
 *   after every transaction and nothing may pin session state to one: no
 *   server-side prepared statements, no `CREATE EXTENSION` at connect, and RLS
 *   context set with `set_config(..., true)` — transaction-local, never
 *   session-local. When it is not, the same connection is a plain Postgres
 *   session with none of those constraints.
 * - **migration** — `DATABASE_DIRECT_URL`. DDL, advisory locks and long
 *   transactions all need a real session, and the release step runs here before
 *   the app swaps over (Doc 08 §6). This one is never pooled, in any deployment.
 *
 * The three shapes this has to fit (Doc 11 §8, gap 3): a managed host where the
 * two URLs are a pooler and a direct endpoint; a bundled container where they
 * are one Postgres, differing only in role; and a client's existing cluster,
 * which may be either and speaks TLS the client's own CA signed.
 *
 * `libs/db` may depend only on `@plantops/contracts` (Doc 08 §2), so this file
 * takes a narrow settings object rather than importing `@plantops/config`.
 * `apps/iam-api` passes the validated env through.
 */

import type { ConnectionOptions as TlsConnectionOptions } from 'node:tls';
import { DataSource, type DataSourceOptions } from 'typeorm';
import { entities } from './entities/index.js';
import { migrations } from './migrations/index.js';

/**
 * How the database connection is protected — `@plantops/config`'s
 * `DatabaseSslMode`, restated here because Doc 08 §2 forbids the dependency.
 * The values are libpq's; the config schema documents why `require` and its
 * relatives are not among them.
 */
export type DatabaseSslMode = 'disable' | 'verify-ca' | 'verify-full';

/**
 * The slice of the validated environment the **migration** connection needs.
 *
 * Split out from {@link DbConnectionSettings} rather than folded into it,
 * because the release step legitimately has no `DATABASE_URL`: Doc 07 §5.1
 * requires the two URLs to carry different roles, so a migrator that cannot
 * reach the app's credentials is the design working. `MigrationEnvConfig` from
 * `@plantops/config` is structurally assignable to this.
 */
export interface MigrationConnectionSettings {
  /** Direct, non-pooled endpoint — migrations only (Doc 07 §2). */
  DATABASE_DIRECT_URL: string;
  DATABASE_SSL: DatabaseSslMode;
  /** PEM trust anchor for the server's certificate; see {@link tlsOptions}. */
  DATABASE_CA_CERT?: string;
  NODE_ENV?: 'development' | 'test' | 'production';
}

/**
 * The slice of the validated environment this module needs. `EnvConfig` from
 * `@plantops/config` is structurally assignable to it.
 */
export interface DbConnectionSettings extends MigrationConnectionSettings {
  /** The application's connection (Doc 07 §2). */
  DATABASE_URL: string;
  /**
   * Is a transaction-mode pooler in front of {@link DATABASE_URL}? See
   * {@link usesPreparedStatements}.
   */
  DATABASE_POOLED: boolean;
}

/**
 * TypeORM's own bookkeeping table. It stays in the connection's default schema
 * because migration 0001 is what creates `iam` — see `schema.ts`.
 */
export const MIGRATIONS_TABLE_NAME = 'migration';

/**
 * Pool ceiling for the app connection — a queue depth in front of a pooler, a
 * count of real backends without one. See {@link createAppDataSourceOptions}
 * for why one number is right in both.
 */
export const APP_POOL_SIZE = 10;

/**
 * The Postgres arm of TypeORM's `DataSourceOptions` union, named without a
 * deep import into `typeorm/driver/...`.
 */
export type PostgresDataSourceOptions = Extract<DataSourceOptions, { type: 'postgres' }>;

/**
 * Node's "the certificate may carry any name" — `checkServerIdentity` returns
 * `undefined` to accept, an `Error` to reject. Used only by `verify-ca`, above
 * an untouched chain check.
 *
 * One shared function rather than one per call so that the app and the migrator
 * produce *equal* TLS options, not merely equivalent ones. That is what lets a
 * test assert the two connections make the same trust decision — comparing two
 * freshly-built closures would compare their identities and always differ.
 */
const ACCEPT_ANY_HOSTNAME = (): undefined => undefined;

/**
 * The TLS decision, in one place because both connections must make it
 * identically — a migration that verifies the server and an application that
 * does not is a split-brain trust model, and the weaker half is the one that
 * matters.
 *
 * `rejectUnauthorized` is `true` in every mode that speaks TLS at all, and
 * there is no configuration that turns it off. That is deliberate: the usual
 * escape hatch encrypts the connection while authenticating nothing, which
 * against a database reachable beyond the host leaves an active attacker able
 * to sit in the middle of the one component Doc 07 §5.1 treats as the last line
 * of defence. `verify-ca` is not that escape hatch — it verifies the chain to a
 * root the operator supplied and relaxes only the *hostname* check, which is
 * the one part of verification a private CA cannot always satisfy.
 *
 * The three modes:
 *
 * - `disable` — no TLS. A bundled container on a private docker network; the
 *   deployment that needs no TLS configuration at all.
 * - `verify-ca` — chain verified against `DATABASE_CA_CERT`, hostname not.
 *   The client-supplied Postgres reached by a service name or a VIP its
 *   certificate never named. `checkServerIdentity` returning `undefined` is
 *   Node's contract for "this name is acceptable"; the chain check above it is
 *   untouched, and the config schema refuses this mode without an anchor.
 * - `verify-full` — chain and hostname. What `DATABASE_SSL=true` always meant,
 *   and the right answer for anything crossing a network we do not own.
 *
 * `DATABASE_CA_CERT` is optional under `verify-full` and required under
 * `verify-ca`. Managed Postgres commonly presents a chain rooted in the
 * provider's own CA rather than a public one — Supabase's pooler, measured,
 * serves `CN=*.pooler.supabase.com` under a self-signed `Supabase Root 2021
 * CA`, which Node rejects with `SELF_SIGNED_CERT_IN_CHAIN`. Supplying that root
 * keeps verification on and simply points it at the correct anchor. Absent a
 * certificate, the system store applies, which is right for a host with a
 * publicly-trusted chain.
 */
function tlsOptions(
  settings: MigrationConnectionSettings,
): PostgresDataSourceOptions['ssl'] {
  if (settings.DATABASE_SSL === 'disable') return false;

  const anchor =
    settings.DATABASE_CA_CERT === undefined ? {} : { ca: settings.DATABASE_CA_CERT };

  if (settings.DATABASE_SSL === 'verify-full') {
    return { rejectUnauthorized: true, ...anchor };
  }

  /**
   * The cast is a gap in TypeORM's types, not a gap in the option. It declares
   * `ssl` as `tls.TlsOptions`, which is Node's **server** shape and has no
   * `checkServerIdentity`; node-postgres hands the same object to
   * `tls.connect`, whose client options do. Narrowed to this one branch so the
   * two verifying modes cannot drift into sharing an `any`.
   */
  const clientOptions: TlsConnectionOptions = {
    rejectUnauthorized: true,
    ...anchor,
    checkServerIdentity: ACCEPT_ANY_HOSTNAME,
  };
  return clientOptions as PostgresDataSourceOptions['ssl'];
}

/**
 * May the app connection use **server-side prepared statements**?
 *
 * The question `DATABASE_URL`'s name used to answer by itself. Under PgBouncer
 * transaction mode a `PREPARE` lands on a server connection that is handed to
 * another client at commit, so the next `EXECUTE` finds nothing and the one
 * after that finds someone else's statement under the same name; unpooled,
 * against a session that belongs to this pool for its lifetime, the same
 * statement is simply a plan reused.
 *
 * **What this does not do is toggle a driver flag, because there is none.**
 * TypeORM's Postgres driver calls `client.query(sql, params)` and never supplies
 * a statement `name`, and node-postgres prepares only *named* queries — so
 * every query this codebase issues travels the unnamed extended-query path and
 * nothing is cached server-side either way. That makes the pooled requirement
 * something the stack satisfies structurally rather than something it switches
 * on, and it is worth stating plainly rather than implying a knob exists: the
 * guarantee holds because no code path here names a statement, and it would
 * stop holding the moment one did.
 *
 * So this predicate is the *permission*, exported for the two things that need
 * to read it — the boot log, so an install we cannot see can say which topology
 * it believes it is in, and any future code that wants a named statement, which
 * must ask before it names one.
 */
export function usesPreparedStatements(settings: DbConnectionSettings): boolean {
  return !settings.DATABASE_POOLED;
}

/**
 * One line describing the app connection's topology, for the boot log and for
 * `tools/diagnostics.ts`. Carries no URL: the endpoint is a credential
 * (`SECRET_ENV_KEYS`), and the topology is the part support actually asks for.
 */
export function describeAppConnection(settings: DbConnectionSettings): string {
  return settings.DATABASE_POOLED
    ? 'pooled (transaction mode) — prepared statements withheld, session state transaction-local'
    : 'direct (no pooler) — prepared statements permitted';
}

/**
 * Options shared by both connections.
 *
 * `synchronize` is false and stays false — everywhere, in every environment
 * (Doc 07 §3). Schema changes are reviewed migrations or they do not happen.
 */
function baseOptions(settings: MigrationConnectionSettings): PostgresDataSourceOptions {
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
    ssl: tlsOptions(settings),
    logging:
      settings.NODE_ENV === 'development'
        ? ['error', 'warn', 'migration']
        : ['error'],
  };
}

/**
 * Options for the request-serving connection.
 *
 * Identical whether or not a pooler is in front of it, and that is the finding
 * rather than an oversight. Everything a pooler forbids is either absent from
 * this stack by construction — see {@link usesPreparedStatements} on why no
 * query here is ever `PREPARE`d — or already off for a reason that has nothing
 * to do with pooling: `installExtensions` because extensions are migration-owned
 * and the app role is a non-superuser (Doc 07 §5), `synchronize` because schema
 * changes are reviewed migrations (Doc 07 §3). The RLS context is set
 * transaction-locally in `rls-context.ts` because that is what a per-request
 * tenant *is*, not because PgBouncer asks for it.
 *
 * So the honest unpooled configuration is this one, and `DATABASE_POOLED`
 * earns its place by making the topology a stated fact — checked at boot,
 * reported in the log, and available to the next thing that would otherwise
 * have to guess — rather than by turning an option off. `APP_POOL_SIZE` is
 * likewise the right ceiling in both: in front of a pooler it is a queue depth
 * below Supabase's per-pair `default_pool_size`, and against a bare Postgres it
 * is ten backends out of a stock `max_connections` of a hundred.
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
  settings: MigrationConnectionSettings,
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
  settings: MigrationConnectionSettings,
): DataSource {
  return new DataSource(createMigrationDataSourceOptions(settings));
}
