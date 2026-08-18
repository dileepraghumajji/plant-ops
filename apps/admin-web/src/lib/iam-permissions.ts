/**
 * The IAM permission keys this console names in `usePermission` (Doc 02 §1).
 *
 * ## Why they are spelled again here
 *
 * `apps/iam-api/src/authz/iam-permissions.ts` already holds this list, and the
 * obvious move would be to import it. The module boundary forbids it, correctly:
 * `app:admin-web` may depend on `scope:contracts`, `scope:client`, `scope:ui`,
 * `scope:web` and `scope:config`, and nothing lets one app reach into another's
 * source (root `eslint.config.mjs`). Putting the keys in `contracts` instead
 * would be worse — a permission is a *row created by a manifest upload*
 * (Doc 02 §8), not a compile-time fact, and `contracts` is where the shapes that
 * genuinely are compile-time facts live.
 *
 * So the console keeps its own spelling of the handful of keys it gates buttons
 * on, and `specs/iam-permissions.spec.ts` asserts every one of them exists in
 * `tools/iam-manifest.json` — the same drift guard the backend's
 * `iam-manifest.spec.ts` applies to its copy. A key renamed in the manifest
 * fails a test rather than silently hiding a button.
 *
 * ## Getting one wrong hides a control; it does not open one
 *
 * These strings decide what the console *offers*. A typo makes a button vanish,
 * which is visible and annoying. It cannot make a forbidden call succeed: the
 * server re-checks every request through `PermissionGuard` and answers 403,
 * which the screens render rather than swallow (Doc 09 §4).
 */

/** Catalog administration (Doc 06 §4) and tenant provisioning (Doc 06 §5). */
export const PLATFORM_PERMISSIONS = {
  APP_CREATE: 'iam.platform.app.create',
  APP_READ: 'iam.platform.app.read',
  APP_UPDATE: 'iam.platform.app.update',
  APP_MANIFEST: 'iam.platform.app.manifest',
  PERMISSION_CREATE: 'iam.platform.permission.create',
  PERMISSION_READ: 'iam.platform.permission.read',
  NAV_CREATE: 'iam.platform.nav.create',
  NAV_READ: 'iam.platform.nav.read',
  NAV_MAP: 'iam.platform.nav.map',

  // Tenant provisioning — the surface of Doc 06 §5.
  CLIENT_CREATE: 'iam.platform.client.create',
  CLIENT_READ: 'iam.platform.client.read',
  CLIENT_UPDATE: 'iam.platform.client.update',
  CLIENT_APP_ENABLE: 'iam.platform.client.app.enable',
  CLIENT_APP_READ: 'iam.platform.client.app.read',
  CLIENT_APP_UPDATE: 'iam.platform.client.app.update',
  CLIENT_ADMIN_CREATE: 'iam.platform.client.admin.create',
} as const;

export type PlatformPermission =
  (typeof PLATFORM_PERMISSIONS)[keyof typeof PLATFORM_PERMISSIONS];

/**
 * Tenant administration — the surfaces of Doc 06 §6–9, and the other half of
 * Doc 09 §1's two consoles.
 *
 * A separate object rather than more entries above, because the two tiers answer
 * different questions and a screen should not be able to reach for the wrong
 * one by autocomplete: a platform key held by a tenant administrator is a bug in
 * the grant, not a control this console should offer.
 */
export const CLIENT_PERMISSIONS = {
  SCOPE_CREATE: 'iam.client.scope.create',
  SCOPE_READ: 'iam.client.scope.read',
  SCOPE_UPDATE: 'iam.client.scope.update',
  SCOPE_DELETE: 'iam.client.scope.delete',
  ROLE_CREATE: 'iam.client.role.create',
  ROLE_READ: 'iam.client.role.read',
  ROLE_UPDATE: 'iam.client.role.update',
  ROLE_DELETE: 'iam.client.role.delete',
  ROLE_PERMISSION_READ: 'iam.client.role.permission.read',
  ROLE_PERMISSION_SET: 'iam.client.role.permission.set',
  USER_CREATE: 'iam.client.user.create',
  USER_READ: 'iam.client.user.read',
  USER_UPDATE: 'iam.client.user.update',
  USER_BULK_UPLOAD: 'iam.client.user.bulk_upload',
  BINDING_CREATE: 'iam.client.binding.create',
  BINDING_READ: 'iam.client.binding.read',
  BINDING_DELETE: 'iam.client.binding.delete',
  SVC_READ: 'iam.client.svc.read',
} as const;

export type ClientPermission =
  (typeof CLIENT_PERMISSIONS)[keyof typeof CLIENT_PERMISSIONS];
