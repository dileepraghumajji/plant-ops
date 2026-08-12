/**
 * Migration runner (Doc 07 §4, Doc 08 §6).
 *
 *   npm run migration:run      apply every pending migration
 *   npm run migration:revert   undo the most recently applied migration
 *   npm run migration:show     list applied / pending
 *
 * Always against `DATABASE_DIRECT_URL` — the *direct*, non-pooled endpoint.
 * DDL under PgBouncer transaction mode is a good way to lose a schema halfway.
 *
 * This lives in `tools/` rather than `libs/db` on purpose: `libs/db` may depend
 * only on `@plantops/contracts` (Doc 08 §2), and the runner needs the validated
 * environment from `@plantops/config`. `tools/` is outside the boundary graph,
 * so it is the one place both may be imported.
 */

import { loadEnv, redactEnv } from '@plantops/config';
import { createMigrationDataSource } from '@plantops/db';
import { config as loadDotenv } from 'dotenv';
import { MigrationExecutor, type DataSource } from 'typeorm';

type Command = 'run' | 'revert' | 'show';

const COMMANDS: readonly Command[] = ['run', 'revert', 'show'];

function parseCommand(argv: readonly string[]): Command {
  const [command] = argv;
  if (command !== undefined && (COMMANDS as readonly string[]).includes(command)) {
    return command as Command;
  }
  throw new Error(
    `Usage: migrate <${COMMANDS.join('|')}>  (received: ${command ?? '<nothing>'})`,
  );
}

async function run(dataSource: DataSource): Promise<void> {
  const applied = await dataSource.runMigrations({ transaction: 'each' });
  if (applied.length === 0) {
    console.log('Nothing to apply — the database is up to date.');
    return;
  }
  for (const migration of applied) {
    console.log(`applied  ${migration.name}`);
  }
}

async function revert(dataSource: DataSource): Promise<void> {
  // `undoLastMigration` is a silent no-op on an empty chain; check first so
  // "reverted" never gets printed for a revert that did nothing.
  const executed = await new MigrationExecutor(dataSource).getExecutedMigrations();
  const last = executed[0];
  if (last === undefined) {
    console.log('Nothing to revert — no migrations are applied.');
    return;
  }
  await dataSource.undoLastMigration({ transaction: 'each' });
  console.log(`reverted  ${last.name}`);
}

async function show(dataSource: DataSource): Promise<void> {
  const executor = new MigrationExecutor(dataSource);
  const executed = await executor.getExecutedMigrations();
  const applied = new Set(executed.map((migration) => migration.name));

  for (const migration of dataSource.migrations) {
    const name = migration.name ?? migration.constructor.name;
    console.log(`${applied.has(name) ? 'applied' : 'pending'}  ${name}`);
  }
}

async function main(): Promise<void> {
  const command = parseCommand(process.argv.slice(2));

  loadDotenv();
  const env = loadEnv();

  // The URL carries a password, so log the redacted view — never the config
  // object (Doc 07 §8).
  const { NODE_ENV, DATABASE_SSL } = redactEnv(env);
  console.log(`migrate ${command} — env=${NODE_ENV} ssl=${DATABASE_SSL} (direct URL)`);

  const dataSource = createMigrationDataSource(env);
  await dataSource.initialize();
  try {
    if (command === 'run') await run(dataSource);
    else if (command === 'revert') await revert(dataSource);
    else await show(dataSource);
  } finally {
    await dataSource.destroy();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
