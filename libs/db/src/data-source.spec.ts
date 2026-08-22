import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import {
  APP_POOL_SIZE,
  MIGRATIONS_TABLE_NAME,
  createAppDataSourceOptions,
  createMigrationDataSourceOptions,
  describeAppConnection,
  usesPreparedStatements,
  type DbConnectionSettings,
} from './data-source.js';
import { entities } from './entities/index.js';
import { migrations } from './migrations/index.js';

/** Stand-in trust anchor. Only its identity matters here, never its contents. */
const CA_PEM = '-----BEGIN CERTIFICATE-----\nnot-a-real-ca\n-----END CERTIFICATE-----';

const settings: DbConnectionSettings = {
  DATABASE_URL: 'postgresql://app:pw@pooler.example:6543/iam',
  DATABASE_DIRECT_URL: 'postgresql://app:pw@direct.example:5432/iam',
  DATABASE_POOLED: true,
  DATABASE_SSL: 'disable',
  NODE_ENV: 'test',
};

/**
 * The three deployments this file has to keep working at once (Doc 11 §8, gap
 * 3). Named after what they *are*, because the whole point of the session is
 * that the code stops inferring them from the shape of a URL.
 */
const DEPLOYMENTS = {
  /** Managed: a pooler in front, a separate direct endpoint, a private CA. */
  managed: {
    ...settings,
    DATABASE_POOLED: true,
    DATABASE_SSL: 'verify-full',
    DATABASE_CA_CERT: CA_PEM,
  },
  /** Bundled container: one Postgres, one private network, no TLS at all. */
  bundled: {
    DATABASE_URL: 'postgresql://plantops_app:pw@postgres:5432/plantops_iam',
    DATABASE_DIRECT_URL: 'postgresql://plantops:pw@postgres:5432/plantops_iam',
    DATABASE_POOLED: false,
    DATABASE_SSL: 'disable',
    NODE_ENV: 'test',
  },
  /** A client's own cluster: no pooler, their CA, a name it does not carry. */
  clientCluster: {
    DATABASE_URL: 'postgresql://plantops_app:pw@pg.plant.internal:5432/iam',
    DATABASE_DIRECT_URL: 'postgresql://plantops:pw@pg.plant.internal:5432/iam',
    DATABASE_POOLED: false,
    DATABASE_SSL: 'verify-ca',
    DATABASE_CA_CERT: CA_PEM,
    NODE_ENV: 'test',
  },
} as const satisfies Record<string, DbConnectionSettings>;

describe('data source options', () => {
  describe('app vs migration split (Doc 07 §2)', () => {
    it('serves requests over the application URL', () => {
      expect(createAppDataSourceOptions(settings)).toMatchObject({
        url: settings.DATABASE_URL,
        poolSize: APP_POOL_SIZE,
      });
    });

    it('runs migrations over the direct URL, never the application one', () => {
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

    it('speaks no TLS at all under disable — the bundled-container case', () => {
      // The deployment that needs no TLS configuration whatsoever: one Postgres
      // on a private docker network, addressed by service name.
      expect(build({ ...settings, DATABASE_SSL: 'disable' }).ssl).toBe(false);
    });

    it('verifies chain and hostname under verify-full', () => {
      expect(build({ ...settings, DATABASE_SSL: 'verify-full' }).ssl).toEqual({
        rejectUnauthorized: true,
      });
    });

    it('verifies against DATABASE_CA_CERT when the chain is not publicly rooted', () => {
      // The managed-Postgres case: Supabase's pooler serves a chain under its
      // own self-signed root, which Node refuses with SELF_SIGNED_CERT_IN_CHAIN
      // against the system store.
      expect(
        build({ ...settings, DATABASE_SSL: 'verify-full', DATABASE_CA_CERT: CA_PEM })
          .ssl,
      ).toEqual({ rejectUnauthorized: true, ca: CA_PEM });
    });

    it('accepts a client CA and a mismatched hostname under verify-ca', () => {
      // A client's own Postgres, their own root, reached by a name the
      // certificate never carried. `checkServerIdentity` returning undefined is
      // Node's "this name is acceptable"; the chain check is untouched above it.
      const ssl = build({
        ...settings,
        DATABASE_SSL: 'verify-ca',
        DATABASE_CA_CERT: CA_PEM,
      }).ssl as { rejectUnauthorized: boolean; ca: string; checkServerIdentity: unknown };

      expect(ssl.rejectUnauthorized).toBe(true);
      expect(ssl.ca).toBe(CA_PEM);
      expect(typeof ssl.checkServerIdentity).toBe('function');
      expect(
        (ssl.checkServerIdentity as (host: string, cert: unknown) => unknown)(
          'pg.plant.internal',
          {},
        ),
      ).toBeUndefined();
    });

    it('leaves hostname verification alone under verify-full', () => {
      // The difference between the two verifying modes is exactly one override,
      // and it must not leak into the mode that did not ask for it.
      expect(
        build({ ...settings, DATABASE_SSL: 'verify-full', DATABASE_CA_CERT: CA_PEM })
          .ssl,
      ).not.toHaveProperty('checkServerIdentity');
    });

    it('never turns verification off, in any mode or combination', () => {
      // The property, not the arrangement: no combination of settings produces
      // an encrypted-but-unauthenticated connection. `rejectUnauthorized:false`
      // would satisfy every other assertion in this file, and is what every
      // "just make TLS work" answer on the internet reaches for.
      for (const DATABASE_SSL of ['verify-ca', 'verify-full'] as const) {
        for (const DATABASE_CA_CERT of [undefined, CA_PEM]) {
          const ssl = build({ ...settings, DATABASE_SSL, DATABASE_CA_CERT }).ssl;
          expect(ssl).toMatchObject({ rejectUnauthorized: true });
        }
      }
    });
  });

  /**
   * The matrix the session exists for: one data source that is correct against
   * a managed pooler, a bundled container, and a client's own cluster.
   */
  describe.each(Object.entries(DEPLOYMENTS))('%s deployment', (_name, deployment) => {
    it('connects the app to DATABASE_URL and the migrator to DATABASE_DIRECT_URL', () => {
      expect(createAppDataSourceOptions(deployment).url).toBe(deployment.DATABASE_URL);
      expect(createMigrationDataSourceOptions(deployment).url).toBe(
        deployment.DATABASE_DIRECT_URL,
      );
    });

    it('makes the same TLS decision on both connections', () => {
      // A migrator that verifies and an app that does not is a split-brain
      // trust model, and the weaker half is the one that faces every request.
      expect(createAppDataSourceOptions(deployment).ssl).toEqual(
        createMigrationDataSourceOptions(deployment).ssl,
      );
    });

    it('permits prepared statements exactly when there is no pooler', () => {
      expect(usesPreparedStatements(deployment)).toBe(!deployment.DATABASE_POOLED);
    });
  });

  describe('pooling is configuration, not inference (Doc 11 §8, gap 3)', () => {
    const pooled = { ...settings, DATABASE_POOLED: true };
    const direct = { ...settings, DATABASE_POOLED: false };

    it('reads the flag, not the endpoints', () => {
      // Both URLs identical and unpooled is the on-premise install, and it is a
      // supported configuration rather than something to be warned about. The
      // one-endpoint shape must not be what decides.
      const oneEndpoint = {
        ...DEPLOYMENTS.bundled,
        DATABASE_URL: DEPLOYMENTS.bundled.DATABASE_DIRECT_URL,
      };
      expect(usesPreparedStatements(oneEndpoint)).toBe(true);
      expect(usesPreparedStatements({ ...oneEndpoint, DATABASE_POOLED: true })).toBe(
        false,
      );
    });

    it('changes nothing about the options themselves', () => {
      // Deliberate, and asserted so it stays deliberate. Everything a pooler
      // forbids is absent here for reasons of its own — prepared statements
      // because the driver never names a statement, extensions because they are
      // migration-owned, session state because a per-request tenant is
      // transaction-scoped. If a future option ever *does* depend on pooling,
      // this test is where that has to be argued.
      expect(createAppDataSourceOptions(pooled)).toEqual(
        createAppDataSourceOptions(direct),
      );
    });

    it('keeps the managed default byte-identical to the behaviour it replaces', () => {
      // The upgrade property: an existing deployment that sets no new variable
      // gets DATABASE_POOLED=true and the connection it had yesterday.
      expect(createAppDataSourceOptions(pooled)).toMatchObject({
        url: settings.DATABASE_URL,
        poolSize: APP_POOL_SIZE,
        applicationName: 'plantops-iam-api',
        installExtensions: false,
        synchronize: false,
      });
    });

    it('describes the topology without disclosing the endpoint', () => {
      // The line goes to a boot log and to a support bundle; the URL carries a
      // password and is in SECRET_ENV_KEYS.
      for (const deployment of [pooled, direct]) {
        const description = describeAppConnection(deployment);
        expect(description).not.toContain(deployment.DATABASE_URL);
        expect(description).not.toContain('pw');
      }
      expect(describeAppConnection(pooled)).not.toBe(describeAppConnection(direct));
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
