import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { CLIENT_PERMISSIONS, PLATFORM_PERMISSIONS } from '../src/lib/iam-permissions';

/**
 * The console's copy of the permission keys, kept honest against the manifest.
 *
 * `apps/iam-api/src/authz/iam-permissions.ts` explains why three places state
 * this list and why a test keeps them equal. The console is a fourth, for a
 * reason the boundary forces: `app:admin-web` may not import from another app,
 * and a permission is a row a manifest upload creates rather than a
 * compile-time fact that belongs in `contracts`.
 *
 * A key that drifts here does not open a door — the server re-checks every call
 * — but it makes a button vanish for the very administrator who holds the
 * permission, which is a bug nobody would think to look for in the frontend.
 */
describe('platform permission keys', () => {
  const manifest = JSON.parse(
    readFileSync(join(__dirname, '../../../tools/iam-manifest.json'), 'utf-8'),
  ) as { permissions: { key: string }[] };

  const declared = new Set(manifest.permissions.map((permission) => permission.key));

  it.each(Object.entries(PLATFORM_PERMISSIONS))(
    '%s is declared by the IAM manifest',
    (_name, key) => {
      expect(declared.has(key)).toBe(true);
    },
  );

  it('names only platform-tier keys', () => {
    for (const key of Object.values(PLATFORM_PERMISSIONS)) {
      expect(key.startsWith('iam.platform.')).toBe(true);
    }
  });
});

/**
 * The client tier is a separate object for the reason `iam-permissions.ts`
 * gives, and it is checked separately for the same one: a `iam.platform.*` key
 * that drifted in here would gate a tenant screen on authority no tenant
 * administrator holds, so every control on it would vanish for the person it
 * was built for.
 */
describe('client permission keys', () => {
  const manifest = JSON.parse(
    readFileSync(join(__dirname, '../../../tools/iam-manifest.json'), 'utf-8'),
  ) as { permissions: { key: string }[] };

  const declared = new Set(manifest.permissions.map((permission) => permission.key));

  it.each(Object.entries(CLIENT_PERMISSIONS))(
    '%s is declared by the IAM manifest',
    (_name, key) => {
      expect(declared.has(key)).toBe(true);
    },
  );

  it('names only client-tier keys', () => {
    for (const key of Object.values(CLIENT_PERMISSIONS)) {
      expect(key.startsWith('iam.client.')).toBe(true);
    }
  });
});
