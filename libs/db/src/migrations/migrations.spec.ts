/**
 * The migration chain's ordering contract.
 *
 * TypeORM does not run migrations in array order — it sorts by the 13-digit
 * timestamp at the end of each class name. A class whose stamp disagrees with
 * its position in `migrations` would run out of order against a fresh database
 * and (for 0002, which needs 0001's schema and enums) fail on release rather
 * than here.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { migrations } from './index.js';

const TIMESTAMP_SUFFIX = /(\d{13})$/;

const named = [...migrations].map((migration) => ({
  className: migration.name,
  timestamp: Number(TIMESTAMP_SUFFIX.exec(migration.name)?.[1]),
}));

describe('migration chain', () => {
  it('ships the chain in the Doc 07 §4 order', () => {
    // Extensions and enums, registry, tenant, mapping, audit — then indexes.
    // RLS and the bootstrap seed are Session 5; the pre-auth functions the
    // login path reads and writes through are Session 8, and come last because
    // they depend on `write_audit` and on the app role's grants already
    // existing (migrations 0007 and 0010). Session 9's rotation state and its
    // own definer function follow for the same reason, and Session 10's reset
    // tokens and lockout policy after them — 0014 *replaces* two of 0012's
    // functions, so it can only run once they exist. Session 11's exchange
    // doorway (0015) reads the platform client the bootstrap seed creates.
    expect(named.map((migration) => migration.className)).toEqual([
      'Extensions1786406400001',
      'RegistryTables1786406400002',
      'TenantTables1786406400003',
      'MappingTables1786406400004',
      'AuditTrail1786406400005',
      'Indexes1786406400006',
      'RlsTenant1786406400007',
      'RlsCatalog1786406400008',
      'RlsJoinTables1786406400009',
      'AuditWriteFn1786406400010',
      'BootstrapSeed1786406400011',
      'AuthFunctions1786406400012',
      'RefreshRotation1786406400013',
      'PasswordResetAccountState1786406400014',
      'ServiceAccountAuth1786406400015',
      // Session 22's sweep column and its definer function. It calls
      // `write_audit` (0010) and adds a column to `role_binding` (0004).
      'BindingExpirySweep1786406400016',
      // Session 23 registers the IAM as an application in its own registry and
      // maps `iam.platform.*` onto the seeded platform role — last because it
      // needs the catalog tables (0002), the join tables' policies (0009) and
      // the identity the bootstrap seed creates (0011).
      'IamPermissionSeed1786406400017',
      // Session 44's boot-time lookup for a single-tenant deployment's pinned
      // client. Last, and it could hardly be anywhere else: it is one
      // `security definer` function over `client` (0003) whose policies were
      // written by 0007, and nothing depends on it.
      'PinnedClientLookup1786406400018',
      // Session 45's restricted on-prem platform role. It maps keys migration
      // 0017 seeds onto a role in the platform tenant 0011 creates, and — in
      // `single_tenant` mode only — binds a service account to it at the
      // platform scope root, so it can only run after both.
      'OnPremPlatformRole1786406400019',
    ]);
  });

  it('ends every class name in the 13-digit timestamp TypeORM parses', () => {
    for (const { className, timestamp } of named) {
      expect(className).toMatch(TIMESTAMP_SUFFIX);
      expect(Number.isNaN(timestamp)).toBe(false);
      // TypeORM's MigrationExecutor rejects a falsy timestamp outright.
      expect(timestamp).toBeGreaterThan(0);
    }
  });

  it('sorts by timestamp into exactly the declared array order', () => {
    const byTimestamp = [...named].sort((a, b) => a.timestamp - b.timestamp);
    expect(byTimestamp).toEqual(named);
  });

  it('gives each migration a distinct timestamp', () => {
    const timestamps = named.map((migration) => migration.timestamp);
    expect(new Set(timestamps).size).toBe(timestamps.length);
  });

  it('sets the instance `name` property TypeORM records in the migration table', () => {
    for (const Migration of migrations) {
      const instance = new Migration();
      // Without this, a bundler that mangles class names would record a
      // different name than the one already stored, re-running the migration.
      expect(instance.name).toBe(Migration.name);
    }
  });

  it('declares both an up and a down for every migration', () => {
    for (const Migration of migrations) {
      const instance = new Migration();
      expect(typeof instance.up).toBe('function');
      expect(typeof instance.down).toBe('function');
    }
  });
});

describe('migration files', () => {
  const directory = __dirname;

  it('has one numbered file per registered migration', () => {
    const files = readdirSync(directory)
      .filter((file) => /^\d{4}-.*\.ts$/.test(file) && !file.endsWith('.spec.ts'))
      .sort();
    expect(files).toHaveLength(migrations.length);

    // The `0001-`/`0002-` prefixes are for humans reading the directory; they
    // must agree with the timestamps that actually drive execution order.
    files.forEach((file, index) => {
      const source = readFileSync(join(directory, file), 'utf-8');
      expect(source).toContain(`export class ${named[index]?.className}`);
    });
  });
});
