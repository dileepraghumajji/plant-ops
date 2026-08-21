/**
 * The IAM's own catalog is stated in three places. This is what keeps them one
 * catalog.
 *
 * - `apps/iam-api/src/authz/iam-permissions.ts` — the constants the controllers
 *   name in `@RequirePermission`, so a typo does not compile.
 * - `deploy/manifests/iam.manifest.json` — the document Doc 02 §2 makes the unit of
 *   registration, uploaded through the real endpoint by
 *   `tools/seed-iam-manifest.ts`.
 * - `libs/db/src/migrations/0017-iam-permission-seed.ts` — the bootstrap, which
 *   exists because uploading that document is itself gated on one of the
 *   permissions in it.
 *
 * Three copies is drift waiting to happen, and the drift is silent in the worst
 * direction: a key the migration seeds but the manifest omits is **deactivated**
 * by the first upload (Doc 02 §7's shrink half), which turns a working
 * deployment's administrators into subjects with no access, at the moment
 * somebody runs a routine seed. Nothing would fail until a request did.
 *
 * So the assertions below are equality, not containment, and they are the same
 * arrangement `audit-actions.spec.ts` uses to keep the action catalog and the
 * migrations' strings in step: the readable statement lives in the three files,
 * and the test is what makes it true.
 *
 * The manifest is read from disk rather than imported, because that is how it
 * reaches the API — `seed-iam-manifest.ts` posts the file's bytes.
 */

import type { ApplicationManifest } from '@plantops/contracts';
import {
  CLIENT_ADMIN_ROLE_NAME as MIGRATION_CLIENT_ADMIN_ROLE_NAME,
  IAM_APPLICATION_DESCRIPTION,
  IAM_APPLICATION_KEY as MIGRATION_APPLICATION_KEY,
  IAM_APPLICATION_NAME,
  IAM_CLIENT_PERMISSION_SEED,
  IAM_PLATFORM_PERMISSION_SEED,
} from '@plantops/db';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  IAM_APPLICATION_KEY,
  IAM_CLIENT_PERMISSION_PREFIX,
  IAM_CLIENT_PERMISSIONS,
  IAM_PERMISSION_KEYS,
  IAM_PLATFORM_PERMISSION_PREFIX,
  IAM_PLATFORM_PERMISSIONS,
} from '../authz/iam-permissions';
import { CLIENT_ADMIN_ROLE_NAME } from '../clients/client-admin.service';
import { applicationManifestSchema } from './dto/manifest.dto';

/** Four levels up from `src/registry/` is the workspace root. */
const MANIFEST_PATH = join(__dirname, '..', '..', '..', '..', 'deploy', 'manifests', 'iam.manifest.json');

const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as ApplicationManifest;

const migrationSeed = [...IAM_PLATFORM_PERMISSION_SEED, ...IAM_CLIENT_PERMISSION_SEED];

describe('deploy/manifests/iam.manifest.json', () => {
  // The upload goes through the same `strictObject` schema every application's
  // does — no exemption for the IAM's own file (Doc 02 §14). A manifest this
  // suite accepts and the endpoint rejects would be found by an operator at
  // deploy time instead.
  it('is a manifest the real endpoint would accept', () => {
    const parsed = applicationManifestSchema.safeParse(manifest);
    expect(parsed.success ? [] : parsed.error.issues).toEqual([]);
  });

  it('registers the application key the migration and the code agree on', () => {
    expect(manifest.key).toBe(IAM_APPLICATION_KEY);
    expect(MIGRATION_APPLICATION_KEY).toBe(IAM_APPLICATION_KEY);
    expect(manifest.name).toBe(IAM_APPLICATION_NAME);
    expect(manifest.description).toBe(IAM_APPLICATION_DESCRIPTION);
  });

  it('declares exactly the keys the controllers require', () => {
    expect(manifest.permissions.map((permission) => permission.key).sort()).toEqual(
      [...IAM_PERMISSION_KEYS].sort(),
    );
  });

  // Equality in both directions, for the reason in the header: a key the
  // migration seeds and the manifest omits is deactivated by the first upload.
  it('declares exactly the keys — and names — the migration seeds', () => {
    expect(
      manifest.permissions.map(({ key, name, description }) => [key, name, description]),
    ).toEqual(migrationSeed.map(([key, name, description]) => [key, name, description]));
  });

  it('keeps the two tiers apart, and prefixed', () => {
    for (const key of Object.values(IAM_PLATFORM_PERMISSIONS)) {
      expect(key.startsWith(IAM_PLATFORM_PERMISSION_PREFIX)).toBe(true);
    }
    for (const key of Object.values(IAM_CLIENT_PERMISSIONS)) {
      expect(key.startsWith(IAM_CLIENT_PERMISSION_PREFIX)).toBe(true);
    }
    // Nothing in both: the tier boundary of Doc 02 §1 is enforced by which keys
    // a role is granted, so a key belonging to both tiers would erase it.
    expect(
      Object.values(IAM_PLATFORM_PERMISSIONS).filter((key) =>
        (Object.values(IAM_CLIENT_PERMISSIONS) as string[]).includes(key),
      ),
    ).toEqual([]);
  });

  // The migration backfills every already-provisioned tenant's administration
  // role by name, and `ClientAdminService` creates it by name. A mismatch would
  // leave existing tenants locked out with nothing failing anywhere.
  it('agrees with the service about what a tenant admin role is called', () => {
    expect(MIGRATION_CLIENT_ADMIN_ROLE_NAME).toBe(CLIENT_ADMIN_ROLE_NAME);
  });

  describe('the admin console navigation (Doc 09, Doc 05)', () => {
    const leaves = (
      nodes: readonly { children?: unknown[]; requires?: string[]; route?: string }[],
    ): { requires?: string[]; route?: string }[] =>
      nodes.flatMap((node) =>
        node.children === undefined
          ? [node]
          : leaves(node.children as typeof nodes),
      );

    // Doc 05 §3 rule 1: an unmapped leaf that is not `is_public` is hidden, so a
    // menu declared without `requires` is a menu nobody will ever see — a
    // configuration gap that looks like a working catalog.
    it('gates every leaf on at least one permission', () => {
      for (const leaf of leaves(manifest.nav)) {
        expect(leaf.requires?.length ?? 0).toBeGreaterThan(0);
      }
    });

    it('gives every leaf a route to navigate to', () => {
      for (const leaf of leaves(manifest.nav)) {
        expect(typeof leaf.route).toBe('string');
      }
    });

    // Not merely "declared in this manifest" — the schema already checks that.
    // This is that the console's menu is gated on keys the *guard* enforces, so
    // a visible menu and a callable endpoint cannot come apart.
    it('gates them on keys the endpoints are actually gated on', () => {
      for (const leaf of leaves(manifest.nav)) {
        for (const key of leaf.requires ?? []) {
          expect(IAM_PERMISSION_KEYS).toContain(key);
        }
      }
    });
  });
});
