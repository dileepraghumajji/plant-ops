/**
 * The migration **release step** (Doc 08 §6, Doc 07 §2, §4).
 *
 *   npm run release:migrate            apply everything pending, then exit 0
 *   npm run release:migrate -- --check report pending work, exit 1 if any
 *
 * `tools/migrate.ts` is the developer's runner: it sits behind
 * `npm run migration:run`, takes `run | revert | show`, and boots through the
 * full `envSchema` because a developer's `.env` has all of it anyway. This file
 * is the one a deploy runs, and it differs in the four ways a deploy needs.
 *
 * **1. It validates only what a migration uses.** `migrationEnvSchema` is
 * `NODE_ENV`, `DATABASE_DIRECT_URL`, `DATABASE_SSL` — no signing key, no Redis
 * URL, no bootstrap secret. The CI job that migrates therefore never has to be
 * handed the credentials it has no business holding, and there is nothing here
 * for a leaked release log to spill beyond one connection string that is
 * printed redacted.
 *
 * **2. It takes an advisory lock.** TypeORM wraps each migration in its own
 * transaction, which makes a *failed* migration safe but does nothing about a
 * *concurrent* one: two runners starting together both read an empty
 * `migration` table and both try to apply 0001. That is not hypothetical in
 * CI — a re-run of a stuck job, or two merges landing within a minute of each
 * other, produces exactly it. `pg_advisory_lock` on a fixed key serialises
 * them, so the second waits and then finds nothing to do. The lock is session-
 * scoped and the direct endpoint is a real session, which is one more reason
 * the release step must never be pointed at the pooler.
 *
 * **3. It has no `revert`.** Rolling back a schema under a running fleet is a
 * decision someone makes with the runbook open, not something a release
 * pipeline should be able to do by passing a different argument. Reverting is
 * `npm run migration:revert`, deliberately from a human's shell.
 *
 * **4. `--check` reports without applying.** A pull request can then say "this
 * release will apply two migrations" before anyone merges it, and a post-deploy
 * step can assert the database is where the code expects.
 *
 * Ordering, and why it is safe: migrations run **before** the new image serves
 * traffic, so for the length of the deploy the *previous* version runs against
 * the *new* schema. Every migration must therefore be backward-compatible with
 * the release before it — add columns, do not rename them; drop only in a later
 * release. `docs/ops-runbook.md` §3 states this as a rule with the expand /
 * contract sequence spelled out; this comment states it here because this file
 * is what makes it true.
 *
 * Lives in `tools/` for the reason `migrate.ts` gives: `libs/db` may depend
 * only on `@plantops/contracts` (Doc 08 §2), and this needs `@plantops/config`
 * too. `tools/` is outside the boundary graph.
 */

import {
  BOOTSTRAP_SECRET_MIN_LENGTH,
  migrationEnvSchema,
  type MigrationEnvConfig,
} from '@plantops/config';
import {
  BOOTSTRAP_SECRET_ENV,
  BootstrapSeed1786406400011,
  createMigrationDataSource,
} from '@plantops/db';

import { config as loadDotenv } from 'dotenv';
import { MigrationExecutor, type DataSource } from 'typeorm';

/**
 * Read off an instance, not off the class. TypeORM identifies a migration by
 * the `name` *property* each class assigns itself, and that is what lands in
 * the `migration` ledger — a bundler free to rename the class would otherwise
 * silently turn this check into a no-op.
 */
const BOOTSTRAP_MIGRATION_NAME = new BootstrapSeed1786406400011().name;

/**
 * The advisory-lock key. Any constant works as long as it never changes and
 * nothing else in the database picks the same number; this one is
 * `'plantops-iam-migrations'` reduced to a stable 63-bit integer, written out
 * literally — as a string, since it exceeds `Number.MAX_SAFE_INTEGER` — so it
 * is greppable and no hashing helper can quietly change it between releases.
 */
const MIGRATION_LOCK_KEY = '4003920155071741';

/** Exit code for `--check` when the database is behind the code. */
const PENDING_EXIT_CODE = 1;

interface Options {
  /** Report pending migrations and exit; apply nothing. */
  check: boolean;
}

function parseOptions(argv: readonly string[]): Options {
  const unknown = argv.filter((arg) => arg !== '--check');
  if (unknown.length > 0) {
    throw new Error(
      `Usage: release-migrate [--check]  (unrecognised: ${unknown.join(' ')})`,
    );
  }
  return { check: argv.includes('--check') };
}

/**
 * Validates the release environment.
 *
 * Separate from `loadEnv` on purpose — see the header. The error lists every
 * problem at once and never echoes a value: `DATABASE_DIRECT_URL` carries the
 * owning role's password.
 */
function loadReleaseEnv(source: NodeJS.ProcessEnv): MigrationEnvConfig {
  const result = migrationEnvSchema.safeParse(source);
  if (result.success) return result.data;

  const issues = result.error.issues.map((issue) => {
    const name = issue.path.join('.') || '(root)';
    const missing = issue.path.length === 1 && source[name] === undefined;
    return `  - ${name}: ${missing ? 'is required but was not set' : issue.message}`;
  });
  throw new Error(
    `Invalid release environment:\n${issues.join('\n')}\n\n` +
      'The release step needs only DATABASE_DIRECT_URL (the *direct*, non-pooled\n' +
      'endpoint carrying the owning role) and DATABASE_SSL. See docs/ops-runbook.md §3.',
  );
}

/**
 * `postgres://user:pw@host:5432/db` → `host:5432/db as user`.
 *
 * The release log has to identify *which* database was migrated — a deploy that
 * migrated staging while claiming production is the failure this line exists to
 * make visible — without printing the password that sits between them.
 */
function describeTarget(url: string): string {
  try {
    const parsed = new URL(url);
    const user = parsed.username === '' ? 'unknown role' : parsed.username;
    return `${parsed.host}${parsed.pathname} as ${user}`;
  } catch {
    return '[unparseable connection string]';
  }
}

/** Migration classes the database has not applied yet, in application order. */
async function pending(dataSource: DataSource): Promise<string[]> {
  const executed = await new MigrationExecutor(dataSource).getExecutedMigrations();
  const applied = new Set(executed.map((migration) => migration.name));
  return dataSource.migrations
    .map((migration) => migration.name ?? migration.constructor.name)
    .filter((name) => !applied.has(name));
}

/**
 * The one migration that reads a secret out of the environment.
 *
 * 0011 seeds the platform identity (Doc 07 §8) and hashes
 * `PLATFORM_BOOTSTRAP_SECRET` into it. It is the chicken-and-egg step: the
 * first platform admin cannot be created through an API that would need that
 * admin to authorize the call. It runs exactly once in the life of a database
 * and is a no-op on every release after.
 *
 * Which makes it the one thing the narrow release environment cannot simply
 * ignore. Left alone, the *first* deploy to a new environment would get eight
 * migrations in and then fail inside 0011 with a message about a variable the
 * release job was never told to carry — a half-migrated database and an error
 * that reads like a bug.
 *
 * So it is checked before anything is applied. The variable stays out of
 * `migrationEnvSchema` deliberately: it is not part of a migration's
 * environment, it is part of *one* migration's, and every release after the
 * first must be able to run without it. Baking it into the schema would keep
 * the secret in the release job's configuration long after it should have been
 * rotated out (Doc 07 §8 — "rotated immediately after first use").
 */
function assertBootstrapSecretIfSeeding(outstanding: readonly string[]): void {
  if (!outstanding.includes(BOOTSTRAP_MIGRATION_NAME)) return;

  const secret = process.env[BOOTSTRAP_SECRET_ENV];
  if (secret !== undefined && secret.trim().length >= BOOTSTRAP_SECRET_MIN_LENGTH) {
    console.log(
      `note: this release seeds the platform identity from ${BOOTSTRAP_SECRET_ENV}. ` +
        'Rotate it immediately afterwards — docs/ops-runbook.md §6.',
    );
    return;
  }

  throw new Error(
    `${BOOTSTRAP_MIGRATION_NAME} has not been applied to this database, and it ` +
      `seeds the platform identity from ${BOOTSTRAP_SECRET_ENV} (Doc 07 §8).\n\n` +
      // Three cases, not two. CI resolves a missing secret to the empty string
      // rather than omitting the variable, so "set but blank" is the shape an
      // operator actually hits — and reporting it as "shorter than 32
      // characters" would send them looking for a password they never set.
      (secret === undefined
        ? `${BOOTSTRAP_SECRET_ENV} is not set.`
        : secret.trim() === ''
          ? `${BOOTSTRAP_SECRET_ENV} is set but empty — check that the secret exists in the environment this job runs under.`
          : `${BOOTSTRAP_SECRET_ENV} is shorter than ${BOOTSTRAP_SECRET_MIN_LENGTH} characters.`) +
      '\n\nSupply it for this one release, then remove it from the release job and rotate\n' +
      'the credential — docs/ops-runbook.md §6. Every subsequent release runs without it.',
  );
}

/**
 * Runs `body` while holding the migration advisory lock.
 *
 * `pg_advisory_lock` blocks rather than failing, which is what a queued second
 * release should do. The unlock is in a `finally`, but it is belt and braces:
 * a session-scoped advisory lock is released when the connection closes, so
 * even a killed runner cannot wedge the next deploy.
 *
 * Load-bearing detail: the migration data source is `poolSize: 1`
 * (`createMigrationDataSourceOptions`), so the lock and the migrations run on
 * the *same* session. A larger pool would take the lock on one connection and
 * apply the DDL on another, which holds nothing.
 */
async function withMigrationLock<T>(
  dataSource: DataSource,
  body: () => Promise<T>,
): Promise<T> {
  // Cast explicitly: the parameter arrives as text, and `pg_advisory_lock` has
  // both a `(bigint)` and an `(int, int)` overload to be resolved against.
  await dataSource.query('select pg_advisory_lock($1::bigint)', [MIGRATION_LOCK_KEY]);
  try {
    return await body();
  } finally {
    await dataSource.query('select pg_advisory_unlock($1::bigint)', [
      MIGRATION_LOCK_KEY,
    ]);
  }
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));

  // A no-op in a deployed environment, where the platform's secret store has
  // already populated `process.env`; present so the same command works from a
  // developer's shell against a local database (Doc 08 §5).
  loadDotenv();
  const env = loadReleaseEnv(process.env);

  console.log(
    `release-migrate${options.check ? ' --check' : ''} — env=${env.NODE_ENV} ` +
      `ssl=${env.DATABASE_SSL} target=${describeTarget(env.DATABASE_DIRECT_URL)}`,
  );

  const dataSource = createMigrationDataSource(env);
  await dataSource.initialize();
  try {
    if (options.check) {
      // Outside the lock: reading the ledger neither races nor needs to block a
      // release that is legitimately running right now.
      const outstanding = await pending(dataSource);
      // Reported, not thrown, in `--check`: the job of this mode is to describe
      // the release, and "you will also need the bootstrap secret" is part of
      // the description rather than a reason to fail the pull request.
      if (outstanding.includes(BOOTSTRAP_MIGRATION_NAME)) {
        console.log(
          `note: this database has no platform identity yet — the release will need ` +
            `${BOOTSTRAP_SECRET_ENV} (docs/ops-runbook.md §6).`,
        );
      }
      if (outstanding.length === 0) {
        console.log('up to date — this release applies no migrations.');
        return;
      }
      for (const name of outstanding) console.log(`pending  ${name}`);
      console.log(
        `\n${outstanding.length} migration(s) would be applied by this release.`,
      );
      process.exitCode = PENDING_EXIT_CODE;
      return;
    }

    await withMigrationLock(dataSource, async () => {
      // Read inside the lock, not before it: a release that queued behind
      // another one must see the ledger as the first release left it. Checked
      // here rather than after `runMigrations` for the obvious reason — the
      // point is to fail before anything is applied, not after eight things
      // are.
      assertBootstrapSecretIfSeeding(await pending(dataSource));

      const applied = await dataSource.runMigrations({ transaction: 'each' });
      if (applied.length === 0) {
        // The re-run case, and the ordinary case for a release that only
        // changed application code. Success, not a warning.
        console.log('up to date — nothing to apply.');
        return;
      }
      for (const migration of applied) console.log(`applied  ${migration.name}`);
      console.log(`\n${applied.length} migration(s) applied.`);
    });
  } finally {
    await dataSource.destroy();
  }
}

/**
 * A release step that fails silently is worse than one that fails loudly with
 * a stack, and node-postgres makes silence easy: a refused connection arrives
 * as an `AggregateError` whose own `message` is the empty string, with the
 * `ECONNREFUSED` that explains everything buried in `.errors`. Printing
 * `error.message` alone would end a failed deploy with a blank line.
 *
 * So: the name, the message when there is one, and every nested reason.
 */
function describeFailure(error: unknown): string {
  if (!(error instanceof Error)) return String(error);

  const { code } = error as NodeJS.ErrnoException;
  const headline =
    error.message !== '' ? error.message : `${error.name} ${code ?? ''}`.trim();

  const nested: string[] = [];
  if (error instanceof AggregateError) {
    for (const cause of error.errors) nested.push(`  - ${describeFailure(cause)}`);
  } else if (error.cause !== undefined) {
    nested.push(`  - caused by: ${describeFailure(error.cause)}`);
  }

  return [headline, ...nested].join('\n');
}

main().catch((error: unknown) => {
  // The operator needs the failure, not a stack through TypeORM's executor —
  // and a stack from a release step tends to be pasted into a chat window.
  console.error(describeFailure(error));
  // Non-zero, always: a release must not proceed to the app swap on a failed
  // migration (roadmap Session 39, and Session 41's runner inherits the rule).
  process.exitCode = 1;
});
