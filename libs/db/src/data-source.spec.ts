import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import {
  APP_POOL_SIZE,
  MIGRATIONS_TABLE_NAME,
  createAppDataSourceOptions,
  createMigrationDataSourceOptions,
  type DbConnectionSettings,
} from './data-source.js';
import { entities } from './entities/index.js';
import { migrations } from './migrations/index.js';

/** Stand-in trust anchor. Only its identity matters here, never its contents. */
const CA_PEM = '-----BEGIN CERTIFICATE-----\nnot-a-real-ca\n-----END CERTIFICATE-----';

const settings: DbConnectionSettings = {
  DATABASE_URL: 'postgresql://app:pw@pooler.example:6543/iam',
  DATABASE_DIRECT_URL: 'postgresql://app:pw@direct.example:5432/iam',
  DATABASE_SSL: false,
  NODE_ENV: 'test',
};

describe('data source options', () => {
  describe('pooler vs direct split (Doc 07 §2)', () => {
    it('serves requests over the pooler URL', () => {
      expect(createAppDataSourceOptions(settings)).toMatchObject({
        url: settings.DATABASE_URL,
        poolSize: APP_POOL_SIZE,
      });
    });

    it('runs migrations over the direct URL, never the pooler', () => {
      const options = createMigrationDataSourceOptions(settings);
      expect(options.url).toBe(settings.DATABASE_DIRECT_URL);
      expect(options.url).not.toBe(settings.DATABASE_URL);
    });

    it('migrates on a single connection, one transaction per migration', () => {
      expect(createMigrationDataSourceOptions(settings)).toMatchObject({
        poolSize: 1,
        migrationsTransactionMode: 'each',
      });
    });

    it('names the two connections distinctly for server-side diagnosis', () => {
      expect(createAppDataSourceOptions(settings).applicationName).not.toBe(
        createMigrationDataSourceOptions(settings).applicationName,
      );
    });
  });

  describe.each([
    ['app', createAppDataSourceOptions],
    ['migration', createMigrationDataSourceOptions],
  ] as const)('%s connection', (_label, build) => {
    it('never synchronizes the schema (Doc 07 §3)', () => {
      expect(build(settings)).toMatchObject({
        synchronize: false,
        dropSchema: false,
        migrationsRun: false,
      });
    });

    it('leaves extension installation to migration 0001', () => {
      // The app role is a non-superuser by design (Doc 07 §5); an ORM-issued
      // CREATE EXTENSION would fail at connect, and on the pooler it would
      // also pin DDL to a shared server connection.
      expect(build(settings).installExtensions).toBe(false);
    });

    it('generates UUIDs with pgcrypto, matching the installed extension', () => {
      expect(build(settings).uuidExtension).toBe('pgcrypto');
    });

    it('registers every entity and migration explicitly, no globs', () => {
      const options = build(settings);
      expect(options.entities).toEqual([...entities]);
      expect(options.migrations).toEqual([...migrations]);
      // Classes, not directory globs: a glob that resolves to nothing under
      // ESM or a bundler surfaces as "metadata not found" at first query
      // rather than as a build failure.
      const registered = [
        ...(options.entities as unknown[]),
        ...(options.migrations as unknown[]),
      ];
      for (const item of registered) {
        expect(typeof item).toBe('function');
      }
    });

    it('keeps TypeORM bookkeeping out of the iam schema', () => {
      // Migration 0001 is what creates `iam`; the migrations table cannot
      // depend on a schema that only a migration can produce.
      expect(build(settings).migrationsTableName).toBe(MIGRATIONS_TABLE_NAME);
      expect(build(settings).schema).toBeUndefined();
    });

    it('verifies TLS certificates when DATABASE_SSL is on', () => {
      expect(build({ ...settings, DATABASE_SSL: true }).ssl).toEqual({
        rejectUnauthorized: true,
      });
      expect(build({ ...settings, DATABASE_SSL: false }).ssl).toBe(false);
    });

    it('verifies against DATABASE_CA_CERT when the chain is not publicly rooted', () => {
      // The managed-Postgres case: Supabase's pooler serves a chain under its
      // own self-signed root, which Node refuses with SELF_SIGNED_CERT_IN_CHAIN
      // against the system store.
      expect(
        build({ ...settings, DATABASE_SSL: true, DATABASE_CA_CERT: CA_PEM }).ssl,
      ).toEqual({ rejectUnauthorized: true, ca: CA_PEM });
    });

    it('never turns verification off, with a certificate or without one', () => {
      // The property, not the arrangement: no combination of settings produces
      // an encrypted-but-unauthenticated connection. `rejectUnauthorized:false`
      // would satisfy every other assertion in this file.
      for (const DATABASE_CA_CERT of [undefined, CA_PEM]) {
        const ssl = build({ ...settings, DATABASE_SSL: true, DATABASE_CA_CERT }).ssl;
        expect(ssl).toMatchObject({ rejectUnauthorized: true });
      }
    });
  });
});

describe('synchronize is never enabled anywhere (Doc 07 §3)', () => {
  const workspaceRoot = join(__dirname, '..', '..', '..');
  const SKIP = new Set(['node_modules', 'dist', 'out-tsc', '.next', '.nx', 'coverage']);

  function typescriptSourcesUnder(directory: string): string[] {
    const found: string[] = [];
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (SKIP.has(entry.name)) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) found.push(...typescriptSourcesUnder(path));
      else if (/\.[cm]?tsx?$/.test(entry.name)) found.push(path);
    }
    return found;
  }

  // Phrased without the literal pattern on purpose — the scan below reads this
  // file too, and a title quoting it would report itself.
  it('finds no source file in apps, libs, or tools enabling schema auto-sync', () => {
    const sources = ['apps', 'libs', 'tools'].flatMap((directory) =>
      typescriptSourcesUnder(join(workspaceRoot, directory)),
    );

    // A guard against the guard: were the walk to silently find nothing, the
    // assertion below would pass while checking exactly zero files.
    expect(sources.length).toBeGreaterThan(10);

    const offenders = sources
      .filter((path) => /synchronize\s*:\s*true/.test(readFileSync(path, 'utf-8')))
      .map((path) => relative(workspaceRoot, path));
    expect(offenders).toEqual([]);
  });
});
