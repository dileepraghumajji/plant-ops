/**
 * The interim authorization for the platform registry surface (Doc 06 §4).
 *
 * ## What replaces this, and when
 *
 * Doc 06 §4 gates every route below `/iam/applications` on `iam.platform.*`,
 * which needs the `PermissionGuard` and the seeded IAM manifest that arrive in
 * Session 23. Until then the check is the one the roadmap names for Session 13:
 * the caller must be a **platform subject** — in practice the bootstrap account
 * of migration 0011, or anything later bound at the platform scope root.
 *
 * Session 23 replaces every `assertPlatformAdmin()` below with
 * `@RequirePermission('iam.platform.app.create')` and friends, and deletes this
 * file. The endpoints do not move.
 *
 * ## Why it reads a session setting rather than a table
 *
 * `app.is_platform_admin` is **derived**, not asserted: `applyRlsContext` sets
 * it from a binding at the platform scope root, and there is no parameter by
 * which a caller could supply it (Doc 07 §5, `rls-context.ts`). Reading it back
 * is therefore reading the database's own conclusion about this request, taken
 * from the verified token — the same value the catalog RLS policies of migration
 * 0008 are about to enforce against.
 *
 * That last point is what makes this check a *usability* layer rather than the
 * only defence. Without it a non-platform caller's insert would still fail, but
 * as a `with check` violation — a 500 with a generic message, since the filter
 * declines to quote a policy name. With it the caller gets the 403 Doc 06 §2
 * specifies. Removing this function would not open a hole; it would make an
 * ordinary denial look like an outage.
 *
 * ## Why it is not a guard
 *
 * A Nest guard runs *before* `TenantContextInterceptor` opens the transaction,
 * so at guard time there is no RLS context to read — the setting is
 * transaction-local by design. Same reasoning as
 * `ServiceAccountsService.assertAdministrator`.
 *
 * ## The refusal is a 403, not a 404
 *
 * The registry endpoints' existence is not a secret and no target has been named
 * yet. The 404-shaped denials in this module are the ones that would otherwise
 * confirm that a *specific* application or key exists.
 */

import { RLS_SETTINGS } from '@plantops/db';
import { IamException } from '../common/iam.exception';
import { entityManager } from '../common/transaction-context';

/**
 * Refuses the request unless the caller is a platform subject.
 *
 * Takes no arguments on purpose: there is nothing about the caller a service
 * could pass that would make the answer different, and a parameter would suggest
 * otherwise.
 *
 * @throws {IamException} `PERMISSION_DENIED` (403) when the caller is not one.
 */
export async function assertPlatformAdmin(): Promise<void> {
  const rows = (await entityManager().query(
    `select coalesce(current_setting($1, true), 'false') = 'true' as platform`,
    [RLS_SETTINGS.IS_PLATFORM_ADMIN],
  )) as { platform: boolean }[];

  if (rows[0]?.platform !== true) throw IamException.permissionDenied();
}
