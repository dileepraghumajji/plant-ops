/**
 * `authz.permission_denied` / `authz.scope_denied` — the guard's half of
 * Doc 10 §3.
 *
 * A thin adapter, and the thinness is the point: everything difficult about
 * writing a denial was settled when `AuditService.recordDenial` was written in
 * Session 12. It commits on its own connection because the request it
 * accompanies is about to be rolled back by its own 403 — an audit row written
 * inside that transaction would vanish along with it, silently, for exactly the
 * events an operator most wants to find. And it never throws, because turning a
 * lost audit row into a 500 would tell a caller which requests were refused for
 * which reason.
 *
 * What is left here is the mapping from an outcome to an action and a target,
 * and that mapping is the whole content of the file:
 *
 * - **the action** is drawn from the catalog, so a misspelling does not compile
 *   (`audit-actions.ts`), and `recordDenial`'s parameter is already narrowed to
 *   these two;
 * - **the target** is the scope node where the request named one, because "who
 *   was refused where" is the question an operator asks of a `scope_denied`.
 *   Where none was named there is no row to point at, so the target id is `null`
 *   and the permission carries the meaning — which is why `AuditTarget.id` is
 *   nullable in the first place.
 *
 * The permission key is in the payload either way, so an action filter plus a
 * payload match answers "who has been trying to do this" without joining
 * anything.
 *
 * ## Why `permission` stays singular in the payload
 *
 * Since Session 25 a route may admit any one of several keys — Doc 06 §12's
 * `iam.*.audit.read`, and nothing else on this surface
 * (`require-permission.decorator.ts`). The guard therefore hands over a list.
 *
 * The payload still leads with `permission`, because every row already written
 * carries that key and a filter over the trail must keep matching them: an audit
 * payload whose shape depends on when the row was written is one that no query
 * can be written against (the argument `audit-actions.ts` makes about spellings,
 * one level down). Where the refusal genuinely involved more than one key, the
 * full list is added beside it as `permissions` — additive, so the singular
 * field keeps meaning what it always meant, which is "the key this refusal was
 * about" for the routes that have exactly one.
 */

import { Injectable } from '@nestjs/common';
import { AuthorizationOutcome, type DenialAuditor } from '@plantops/auth-kit';
import type { PermissionKey } from '@plantops/contracts';
import type { VerifiedClaims } from '@plantops/db';
import { AUDIT_ACTIONS, type AuditTarget } from '../audit/audit-actions';
import { AuditService } from '../audit/audit.service';

@Injectable()
export class GuardDenialAuditor implements DenialAuditor {
  constructor(private readonly audit: AuditService) {}

  async recordDenial(
    claims: VerifiedClaims,
    outcome: Exclude<AuthorizationOutcome, 'allowed'>,
    permissions: readonly PermissionKey[],
    scopeNodeId?: string,
  ): Promise<void> {
    const target: AuditTarget =
      scopeNodeId === undefined
        ? { type: 'permission', id: null }
        : { type: 'scope_node', id: scopeNodeId };

    await this.audit.recordDenial(
      claims,
      outcome === AuthorizationOutcome.SCOPE_DENIED
        ? AUDIT_ACTIONS.SCOPE_DENIED
        : AUDIT_ACTIONS.PERMISSION_DENIED,
      target,
      {
        permission: permissions[0],
        ...(permissions.length > 1 ? { permissions: [...permissions] } : {}),
        ...(scopeNodeId === undefined ? {} : { scope_node_id: scopeNodeId }),
      },
    );
  }
}
