/**
 * The action catalog — every dotted verb this system is allowed to write
 * (Doc 10 §4).
 *
 * ## Why a catalog rather than string literals at each call site
 *
 * `action` is the column every audit query filters on: the read API's action
 * filter (Doc 06 §12), the operator hunting a lockout, the compliance export.
 * A trail in which the same event is recorded as `user.disabled` in one service
 * and `user.disable` in another is not a trail — it is two trails, and nobody
 * finds out until the query that should have returned the row returns nothing.
 * Free-text call sites make that failure invisible at review time and permanent
 * afterwards, because the rows already written cannot be corrected.
 *
 * So {@link AuditService.record} takes an {@link AuditAction}, which is the
 * union of the values below and nothing else. A typo does not compile.
 *
 * ## Actions the database writes, and why they are listed here too
 *
 * Some of these strings are not written by TypeScript at all. `auth.login.*`,
 * `auth.refresh.*`, the reset pair and the auto-lock are emitted from inside
 * migrations 0011–0015, because they belong to statements that must be atomic
 * with the thing they record (see those migrations for the argument). Those
 * migrations are frozen artefacts and deliberately import nothing from the app,
 * so the strings are duplicated rather than shared.
 *
 * Duplication that nothing checks is drift waiting to happen, so
 * `audit-actions.spec.ts` asserts that every constant the migrations export is
 * a member of this catalog. The catalog stays the readable statement of Doc 10
 * §4; the test is what keeps it true.
 *
 * ## The catalog is wider than what Session 12 can emit
 *
 * Registry, tenant-admin and authorization actions are here in full, with no
 * writer behind most of them yet — Sessions 13–23 supply those. Listing the
 * whole of Doc 10 §4 in one place is the point: the next session picks its
 * constant instead of inventing a spelling, which is exactly the drift this
 * file exists to prevent.
 */

/**
 * Every action string in the system, keyed by a name that reads as the event.
 *
 * Grouped in the order Doc 10 §4 lists them.
 */
export const AUDIT_ACTIONS = {
  // ── Auth (Doc 03 §9, Doc 10 §4) ────────────────────────────────────────
  //
  // The first six are written by the database. `auth.login.success` and
  // `auth.login.failed` are pinned in migration 0012, the refresh pair in
  // 0013, and the reset pair in 0014 — each inside the statement that decides
  // the outcome, so the record and the decision cannot come apart.
  /** Written by `iam.auth_begin_session` (migration 0012). */
  LOGIN_SUCCESS: 'auth.login.success',
  /** Written by `iam.auth_record_login_failure` (migration 0012), with a reason code. */
  LOGIN_FAILED: 'auth.login.failed',
  /** The machine counterpart of `auth.login.failed` — `/auth/token` (migration 0015). */
  TOKEN_FAILED: 'auth.token.failed',
  LOGOUT: 'auth.logout',
  /** Written by `iam.auth_rotate_refresh_token` (migration 0013). */
  REFRESH_ROTATED: 'auth.refresh.rotated',
  /** Written by `iam.auth_rotate_refresh_token` (migration 0013). */
  REFRESH_REUSE_DETECTED: 'auth.refresh.reuse_detected',
  SESSION_REVOKED: 'auth.session.revoked',
  /** Written by `iam.auth_request_password_reset` (migration 0014). */
  PASSWORD_RESET_REQUESTED: 'auth.password.reset_requested',
  /** Written by `iam.auth_complete_password_reset` (migration 0014). */
  PASSWORD_RESET_COMPLETED: 'auth.password.reset_completed',
  /**
   * Both the administrative lock and the failed-attempt policy's lock. One
   * vocabulary, because the event is the account's state changing and
   * `actor_id` already says who caused it (migration 0014's header).
   */
  ACCOUNT_LOCKED: 'auth.account.locked',
  ACCOUNT_UNLOCKED: 'auth.account.unlocked',

  // ── Registry, platform tier (Doc 10 §4) ────────────────────────────────
  APPLICATION_CREATED: 'application.created',
  APPLICATION_UPDATED: 'application.updated',
  APPLICATION_MANIFEST_UPSERTED: 'application.manifest.upserted',
  APPLICATION_DEACTIVATED: 'application.deactivated',
  PERMISSION_CREATED: 'permission.created',
  /**
   * Both beyond Doc 10 §4, which lists only `permission.created` — the manifest
   * upsert of Session 14 is the writer, and it is the only path that can edit or
   * retire a permission (Doc 02 §7).
   *
   * `permission.deactivated` earns its own action rather than living inside the
   * manifest summary because of what it does: every role that maps the key keeps
   * the mapping and silently stops granting anything (Doc 04 §7 treats it as an
   * invalidation trigger for exactly that reason). "When did this permission go
   * away" must be answerable by an action filter, the way `nav.node.deactivated`
   * — its exact counterpart, which Doc 10 §4 does list — already is.
   */
  PERMISSION_UPDATED: 'permission.updated',
  PERMISSION_DEACTIVATED: 'permission.deactivated',
  NAV_NODE_CREATED: 'nav.node.created',
  NAV_NODE_UPDATED: 'nav.node.updated',
  NAV_NODE_DEACTIVATED: 'nav.node.deactivated',
  MENU_PERMISSION_MAPPED: 'menu_permission.mapped',
  MENU_PERMISSION_UNMAPPED: 'menu_permission.unmapped',
  CLIENT_CREATED: 'client.created',
  /**
   * Beyond Doc 10 §4, which lists only `client.created` and `client.suspended`
   * — the same gap `application.updated` fills on the catalog side, and filled
   * the same way. An ordinary edit (a renamed tenant, a changed `config`) has to
   * be recorded as *something*, and recording it as a suspension would make the
   * action filter that finds real suspensions useless.
   *
   * Reactivation rides here rather than earning its own action: it is the
   * ordinary case of a status edit, and `before`/`after` in the payload already
   * says which way it went. Suspension is the one that is singled out, because
   * it is the edit that locks an organisation out (Doc 06 §5).
   */
  CLIENT_UPDATED: 'client.updated',
  CLIENT_SUSPENDED: 'client.suspended',
  CLIENT_APPLICATION_ENABLED: 'client_application.enabled',
  CLIENT_APPLICATION_DISABLED: 'client_application.disabled',

  // ── Tenant admin (Doc 10 §4) ───────────────────────────────────────────
  SCOPE_NODE_CREATED: 'scope_node.created',
  SCOPE_NODE_MOVED: 'scope_node.moved',
  SCOPE_NODE_RENAMED: 'scope_node.renamed',
  SCOPE_NODE_DELETED: 'scope_node.deleted',
  ROLE_CREATED: 'role.created',
  ROLE_UPDATED: 'role.updated',
  ROLE_DELETED: 'role.deleted',
  ROLE_PERMISSION_SET: 'role_permission.set',
  USER_CREATED: 'user.created',
  USER_UPDATED: 'user.updated',
  /**
   * Doc 10 §4 lists `user.locked/unlocked` beside `user.disabled`. Locking is
   * recorded as `auth.account.locked` instead — the same event under the name
   * the auth section of the same catalog gives it — because the failed-attempt
   * policy writes it from the login path and one event must not have two
   * spellings depending on who tripped it. Disabling has no such second writer.
   */
  USER_DISABLED: 'user.disabled',
  USER_BULK_UPLOADED: 'user.bulk_uploaded',
  ROLE_BINDING_CREATED: 'role_binding.created',
  ROLE_BINDING_DELETED: 'role_binding.deleted',
  /** Written by the expiry sweep (Session 22, Doc 10 §9). */
  ROLE_BINDING_EXPIRED: 'role_binding.expired',
  SERVICE_ACCOUNT_CREATED: 'service_account.created',
  SERVICE_ACCOUNT_ROTATED: 'service_account.rotated',
  SERVICE_ACCOUNT_REVOKED: 'service_account.revoked',
  /**
   * Beyond Doc 10 §4's minimum. `setStatus` can move an account back to
   * `active`, and a revocation that is silently undone is worse than one that
   * was never recorded.
   */
  SERVICE_ACCOUNT_REACTIVATED: 'service_account.reactivated',

  // ── Authorization (Doc 10 §4) ──────────────────────────────────────────
  //
  // Written by `PermissionGuard`, through `authz/denial-auditor.ts` and
  // {@link AuditService.recordDenial} rather than `record` — see there.
  PERMISSION_DENIED: 'authz.permission_denied',
  SCOPE_DENIED: 'authz.scope_denied',

  // ── Audit of audit (Doc 10 §7) ─────────────────────────────────────────
  /** A CSV export is itself an event (Session 25). */
  AUDIT_EXPORTED: 'audit.exported',

  // ── Bootstrap (Doc 10 §4) ──────────────────────────────────────────────
  /** Written once, by migration 0011. */
  PLATFORM_BOOTSTRAP: 'platform.bootstrap',

  // ── Single-tenant delivery (Session 45, Doc 11 §6.4) ───────────────────
  //
  // Both are written outside this process — the first by migration 0019, the
  // second by `tools/break-glass-admin.ts`, which runs on the *host* with the
  // database on one side and no application on the other. They are listed here
  // because `action` is what every audit query filters on (Doc 06 §12), and an
  // event nobody can name in a filter is an event nobody finds.
  /** Migration 0019 provisioning the on-prem operator identity. */
  PLATFORM_ONPREM_SEEDED: 'platform.onprem_seeded',
  /**
   * A locked-out client administrator recovered from the host.
   *
   * Distinct from `user.created` and `auth.account.unlocked` on purpose: this is
   * somebody with the bootstrap secret and a shell on the server reaching past
   * the console, and Doc 11 §6.4 requires it to be legible as exactly that.
   */
  PLATFORM_BREAK_GLASS: 'platform.break_glass',
} as const;

/** Every action string the catalog permits. */
export type AuditAction = (typeof AUDIT_ACTIONS)[keyof typeof AUDIT_ACTIONS];

/**
 * The same catalog as a list, sorted, for the places that need values rather
 * than a type.
 *
 * There is exactly one such place: the `?action=` filter of `GET /iam/audit`
 * (Doc 06 §12), which validates against the catalog and publishes it as an enum
 * so a console builds its dropdown from the API instead of from a copy
 * (`dto/audit.dto.ts`). Sorted because the published document is a committed
 * artefact that gets diffed, and the declaration order above is grouped by Doc
 * 10 §4's sections rather than by anything a reader of the enum would expect.
 */
export const AUDIT_ACTION_VALUES: readonly AuditAction[] = Object.values(
  AUDIT_ACTIONS,
).sort();

/**
 * The two actions {@link AuditService.recordDenial} may write.
 *
 * Narrower than {@link AuditAction} on purpose: the denial writer commits on
 * its own connection, outside the caller's transaction (Doc 10 §3), and that
 * is the *wrong* shape for anything that accompanies a change. Restricting the
 * type keeps a mutation from being routed down it by accident.
 */
export type DenialAuditAction =
  | typeof AUDIT_ACTIONS.PERMISSION_DENIED
  | typeof AUDIT_ACTIONS.SCOPE_DENIED;

/**
 * What a record can point at — the table the target id lives in.
 *
 * `target_type` is plain `text` in the schema (Doc 01 §4.8) because audit rows
 * outlive the tables they name; the union is an application-side constraint, so
 * that a filter on the read API can enumerate the values rather than guess
 * them.
 */
export const AUDIT_TARGET_TYPES = [
  'application',
  'audit',
  'client',
  'client_application',
  'menu_permission',
  'nav_node',
  'permission',
  'role',
  'role_binding',
  'role_permission',
  'scope_node',
  'service_account',
  'session',
  'user',
] as const;

export type AuditTargetType = (typeof AUDIT_TARGET_TYPES)[number];

/**
 * What an action was done to.
 *
 * `id` is nullable because some events have no row to name — a bulk upload
 * reports counts, a denied request names a permission rather than an entity —
 * and a fabricated uuid there would be worse than an honest null.
 */
export interface AuditTarget {
  type: AuditTargetType;
  id: string | null;
}
