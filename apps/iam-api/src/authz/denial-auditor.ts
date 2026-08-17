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
    permission: PermissionKey,
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
      { permission, ...(scopeNodeId === undefined ? {} : { scope_node_id: scopeNodeId }) },
    );
  }
}
