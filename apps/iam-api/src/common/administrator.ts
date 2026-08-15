/**
 * The interim authorization for the **client** tier (Doc 06 §6–9).
 *
 * The platform-tier counterpart is `platform-admin.ts`, and everything that file
 * says about *why* the check is a function rather than a guard, and about what
 * replaces it, applies here unchanged: a Nest guard runs before
 * `TenantContextInterceptor` opens the transaction, so at guard time there is no
 * RLS context to read; and Session 23 replaces every call with
 * `@RequirePermission('iam.client.…')` once the `PermissionGuard` and the seeded
 * IAM manifest exist.
 *
 * How that guard gets its own RLS context — rather than borrowing the request's,
 * which does not exist yet, or opening the request transaction itself, which a
 * guard cannot close — is decided in
 * `docs/adr/0001-permission-guard-connection-strategy.md`: on a grants-cache
 * miss it opens its own `QueryRunner`, applies `applyRlsContext` from the
 * verified claims, resolves on that manager and releases. Same pattern as
 * `AuditService.recordDenial`.
 *
 * ## Why the two tiers do not share one function
 *
 * They ask different questions. `assertPlatformAdmin()` asks whether the caller
 * administers the *platform*; this asks whether they administer **their own
 * tenant** — and answers yes for a platform subject too, because the platform
 * account acting inside a tenant context is doing so under that tenant's RLS
 * and can only reach that tenant's rows.
 *
 * ## What each arm actually reads
 *
 * Both read state the database owns, established from the verified token:
 *
 * - `app.is_platform_admin` was **derived** by `applyRlsContext` from a binding
 *   at the platform scope root and has no parameter a caller could supply
 *   (Doc 07 §5).
 * - `user.is_client_admin` is looked up under the request's own RLS context, so
 *   a subject id belonging to another tenant matches nothing. It is Doc 01 §3.6's
 *   "shortcut flag; still enforced via permissions" — the interim stand-in until
 *   the flag becomes an actual `iam.client.*` binding.
 *
 * A service account is refused unless it is a platform subject: `sub` is then a
 * `service_account` id, which the `user` lookup cannot match. Machine identities
 * inside a tenant get their authority from bindings (Session 20), not from a
 * flag they do not have a column for.
 *
 * ## The refusal is a 403, not a 404
 *
 * No target has been named at the point this runs. The 404-shaped denials in the
 * services that call it are the ones that would otherwise confirm a *specific*
 * node, role or user exists in another tenant (Doc 06 §2).
 */

import { SubjectType } from '@plantops/contracts';
import { IAM_SCHEMA, RLS_SETTINGS, type VerifiedClaims } from '@plantops/db';
import { IamException } from './iam.exception';
import { entityManager } from './transaction-context';

const S = `"${IAM_SCHEMA}"`;

/**
 * Refuses the request unless the caller administers the tenant they are acting
 * in — as its client admin, or as a platform subject.
 *
 * @throws {IamException} `PERMISSION_DENIED` (403) when they do not.
 */
export async function assertAdministrator(claims: VerifiedClaims): Promise<void> {
  const rows = (await entityManager().query(
    `select coalesce(current_setting($1, true), 'false') = 'true' as platform,
            exists (
              select 1 from ${S}."user" u
               where u.id = $2::uuid and u.is_client_admin
            ) as client_admin`,
    [
      RLS_SETTINGS.IS_PLATFORM_ADMIN,
      claims.sty === SubjectType.USER ? claims.sub : null,
    ],
  )) as { platform: boolean; client_admin: boolean }[];

  const row = rows[0];
  if (row?.platform !== true && row?.client_admin !== true) {
    throw IamException.permissionDenied();
  }
}
