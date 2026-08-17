/**
 * The IAM's own permission keys — the catalog it gates itself with (Doc 02 §1,
 * Doc 06 §4–12).
 *
 * ## The IAM is an application in its own registry
 *
 * Doc 02 §1's two tiers are `iam.platform.*` and `iam.client.*`, and §14 is
 * emphatic that "there is no privileged bypass path — the admin console calls
 * the same authorized APIs everyone else does". That is only true if the IAM's
 * own routes are gated by permissions that live in the `permission` table like
 * every other application's, granted through roles and bindings like every other
 * grant. So the IAM registers itself as application `iam`, and the constants
 * below are the keys its controllers name in `@RequirePermission`.
 *
 * ## Three places state this list, and a test keeps them equal
 *
 * - **here**, because a controller decorator needs a compile-time constant and a
 *   typo in one must not compile;
 * - **`tools/iam-manifest.json`**, because Doc 02 §2 makes the manifest the unit
 *   of registration and the console's navigation can only come from one;
 * - **migration 0017**, because the platform identity has to hold
 *   `iam.platform.*` *before* the manifest can be uploaded — uploading it is
 *   itself a gated call, and bootstrapping out of that circle is what a
 *   migration is for (it is the same argument migration 0011 makes about the
 *   identity itself).
 *
 * Three copies of a list is drift waiting to happen, so `iam-manifest.spec.ts`
 * asserts they agree — the same shape `audit-actions.spec.ts` uses to keep the
 * action catalog and the migrations' strings in step.
 *
 * ## Why the tiers are not symmetric
 *
 * The platform tier is about the **catalog and tenants**: applications,
 * permissions, nav, clients, enablement. The client tier is about **one
 * tenant's own people and structure**: scopes, roles, users, bindings. Nothing
 * appears in both, with one deliberate exception — `iam.client.svc.*`. Doc 06
 * §10 heads that surface "Service accounts (`iam.client.svc.*` / platform)", and
 * Doc 09 §2.4 gives the platform console a service-accounts screen: a platform
 * account creating platform-level machine identities is administering the
 * platform *tenant*, which is a tenant like any other (migration 0011 makes it
 * one for exactly this reason). So the route is gated on the client-tier key and
 * the platform role is granted it, rather than the surface growing a second
 * permission that would have to be kept in step with the first.
 */

/** `permission.application.key` of the IAM's own registry entry. */
export const IAM_APPLICATION_KEY = 'iam';

/**
 * The two tier prefixes (Doc 02 §1).
 *
 * Used where a *set* of keys is wanted rather than one — provisioning a tenant
 * admin maps "every active client-tier key" rather than a list, so a key added
 * by a later manifest upload reaches the next tenant with no code change, which
 * is what "permissions are data" (Doc 02 §8) has to mean in practice.
 */
export const IAM_PLATFORM_PERMISSION_PREFIX = 'iam.platform.';
export const IAM_CLIENT_PERMISSION_PREFIX = 'iam.client.';

/**
 * Catalog and tenant administration (Doc 06 §4–5, §12).
 *
 * Bound at the platform scope root, outside any customer tree (Doc 04 §10).
 * None of these routes names a scope node, so none of them runs the coverage
 * step — they are permission-gated and fully audited, which is exactly what §10
 * prescribes.
 */
export const IAM_PLATFORM_PERMISSIONS = {
  APP_CREATE: 'iam.platform.app.create',
  APP_READ: 'iam.platform.app.read',
  APP_UPDATE: 'iam.platform.app.update',
  /** The declarative route — one upload rewrites permissions, nav and mappings. */
  APP_MANIFEST: 'iam.platform.app.manifest',
  PERMISSION_CREATE: 'iam.platform.permission.create',
  PERMISSION_READ: 'iam.platform.permission.read',
  NAV_CREATE: 'iam.platform.nav.create',
  NAV_READ: 'iam.platform.nav.read',
  /** Mapping permissions onto nav nodes, and unmapping them (Doc 01 §4.4). */
  NAV_MAP: 'iam.platform.nav.map',
  CLIENT_CREATE: 'iam.platform.client.create',
  CLIENT_READ: 'iam.platform.client.read',
  CLIENT_UPDATE: 'iam.platform.client.update',
  CLIENT_APP_ENABLE: 'iam.platform.client.app.enable',
  CLIENT_APP_READ: 'iam.platform.client.app.read',
  CLIENT_APP_UPDATE: 'iam.platform.client.app.update',
  CLIENT_ADMIN_CREATE: 'iam.platform.client.admin.create',
  /**
   * Declared here although `GET /iam/audit` arrives in Session 25 (Doc 06 §12,
   * Doc 10 §6). A permission is a row created by an upload, not a deploy — so
   * the key exists from the moment the manifest declares it, and the session
   * that adds the route only has to name it.
   */
  AUDIT_READ: 'iam.platform.audit.read',
} as const;

/** One tenant's own structure, people and grants (Doc 06 §6–10, §12). */
export const IAM_CLIENT_PERMISSIONS = {
  SCOPE_CREATE: 'iam.client.scope.create',
  SCOPE_READ: 'iam.client.scope.read',
  SCOPE_UPDATE: 'iam.client.scope.update',
  SCOPE_DELETE: 'iam.client.scope.delete',
  ROLE_CREATE: 'iam.client.role.create',
  ROLE_READ: 'iam.client.role.read',
  ROLE_UPDATE: 'iam.client.role.update',
  ROLE_DELETE: 'iam.client.role.delete',
  ROLE_PERMISSION_READ: 'iam.client.role.permission.read',
  /**
   * Separate from `ROLE_UPDATE`, because the two are not the same power. A
   * rename is cosmetic; setting a role's permissions changes what every subject
   * bound to it may do, everywhere they are bound (Doc 04 §7's second row). An
   * organisation that lets a coordinator tidy role names without letting them
   * widen access needs the two keys to be different.
   */
  ROLE_PERMISSION_SET: 'iam.client.role.permission.set',
  USER_CREATE: 'iam.client.user.create',
  USER_READ: 'iam.client.user.read',
  /** Profile edits and the lock/unlock/disable transitions (Doc 06 §8). */
  USER_UPDATE: 'iam.client.user.update',
  USER_BULK_UPLOAD: 'iam.client.user.bulk_upload',
  BINDING_CREATE: 'iam.client.binding.create',
  BINDING_READ: 'iam.client.binding.read',
  BINDING_DELETE: 'iam.client.binding.delete',
  SVC_CREATE: 'iam.client.svc.create',
  SVC_READ: 'iam.client.svc.read',
  SVC_ROTATE: 'iam.client.svc.rotate',
  SVC_UPDATE: 'iam.client.svc.update',
  /** Doc 06 §12, Doc 10 §6 — the route arrives in Session 25. */
  AUDIT_READ: 'iam.client.audit.read',
} as const;

export type IamPlatformPermission =
  (typeof IAM_PLATFORM_PERMISSIONS)[keyof typeof IAM_PLATFORM_PERMISSIONS];
export type IamClientPermission =
  (typeof IAM_CLIENT_PERMISSIONS)[keyof typeof IAM_CLIENT_PERMISSIONS];
export type IamPermission = IamPlatformPermission | IamClientPermission;

/** Every key the IAM declares, in one list — what the manifest spec compares. */
export const IAM_PERMISSION_KEYS: readonly IamPermission[] = [
  ...Object.values(IAM_PLATFORM_PERMISSIONS),
  ...Object.values(IAM_CLIENT_PERMISSIONS),
];
