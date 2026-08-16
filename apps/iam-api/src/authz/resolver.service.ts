/**
 * The resolution engine — WHO × WHAT × WHERE, answered (Doc 04 §4–5).
 *
 * ## The one convention this file breaks, and why
 *
 * **`resolve()` takes an explicit `EntityManager` as its first parameter and
 * never calls `entityManager()`.** Every other service in this application
 * reads the database through the ambient request transaction, and does so for a
 * good reason: the RLS context is `set_config(..., true)` and therefore
 * transaction-local, so a query on any other connection runs with no tenant
 * (Doc 07 §5, `common/transaction-context.ts`).
 *
 * This is the documented exception, decided before the code existed in
 * `docs/adr/0001-permission-guard-connection-strategy.md`. Session 23's
 * `PermissionGuard` runs *before* `TenantContextInterceptor` opens the request
 * transaction — Nest runs guards ahead of interceptors — so at guard time there
 * is no ambient transaction to borrow and `entityManager()` would throw. The
 * guard therefore brings its own short-lived `QueryRunner` with
 * `applyRlsContext` applied from the verified claims, exactly as
 * `AuditService.recordDenial` already does, and passes that manager here.
 *
 * The request handlers of `authz.controller.ts` pass `entityManager()`, so their
 * behaviour inside the request transaction is unchanged and they still see
 * their own uncommitted writes.
 *
 * Do not "fix" this back to the convention. Doing so does not fail a test — it
 * fails Session 23, at which point the fix is to rewrite this file.
 *
 * ## Why the query and not a `SECURITY DEFINER` function
 *
 * The ADR considered it (option C) and it is the closest thing to the grain of
 * this codebase, since migrations 0010 and 0012–0015 already put the other
 * pre-auth work behind definer functions. It was rejected because resolution is
 * not a lookup: path minimization, expiry filtering and the application slice
 * are the algorithm of Doc 04 §4, and moving them into PL/pgSQL trades an
 * exhaustive TypeScript test matrix for connection-independence that the
 * explicit manager already buys.
 *
 * ## What the join excludes, and where each exclusion comes from
 *
 * A grant survives only if all five of these hold — each one a row of Doc 04 §7's
 * invalidation table read forwards, as a condition rather than as an event:
 *
 * - the binding has not expired (`expires_at` null or in the future, Doc 01 §4.5);
 * - the permission is still active — a key soft-deactivated by a manifest
 *   re-upload (Doc 02 §7) is inert, and §7's own wording is that cached grants
 *   "may still reference a now-inert permission key", which is only a hazard if
 *   resolution treats it as live;
 * - its application is active platform-wide (Doc 02 §7);
 * - that application is enabled **for this client** (Doc 02 §6, Doc 04 §7's
 *   "client_application disabled → its permissions absent from grants");
 * - the bound node still exists in this client's tree.
 *
 * The clock is Postgres's `now()`, not the process's. `bindings.service.ts`
 * computes its `expired` flag the same way for the same reason: the row that
 * says a grant has lapsed and the query that stops honouring it must not
 * disagree because two machines' clocks do.
 *
 * ## Tenancy is pinned twice
 *
 * RLS confines every table below to the caller's tenant already, and the `where`
 * clause pins `rb.client_id` as well. The redundancy is the same one
 * `bindings.service.ts` carries on its joins: it lets the planner use the
 * tenant-scoped indexes the policy narrows to anyway, and — more to the point
 * here — the guard's connection in Session 23 is one this service does not open
 * itself, so the query must not depend on somebody else having got the context
 * right.
 */

import { Injectable } from '@nestjs/common';
import {
  SubjectType,
  type PermissionKey,
  type ResolvedGrants,
  type ScopePath,
} from '@plantops/contracts';
import { IAM_SCHEMA } from '@plantops/db';
import type { EntityManager } from 'typeorm';
import { assembleGrants, grantsCover, type GrantRow } from './grants.util';
import { GrantsCacheService } from './grants-cache.service';

const S = `"${IAM_SCHEMA}"`;

/** Whose grants are being resolved. Everything comes from verified claims. */
export interface SubjectRef {
  /** The tenant — `cid`. Never a parameter a caller supplies (Doc 07 §5). */
  clientId: string;
  type: SubjectType;
  /** `user.id` or `service_account.id` — `sub`. */
  id: string;
}

export interface ResolveOptions {
  /** Narrows the answer to one application's permissions (Doc 06 §11). */
  applicationId?: string;
}

/**
 * The subject column for a subject type.
 *
 * Interpolated into SQL rather than parameterised, because a column name cannot
 * be a bind parameter. Safe because it is chosen from a closed union by this
 * function and never from anything a caller sends — the same shape
 * `SessionService` uses for the identical decision.
 */
function subjectColumn(type: SubjectType): string {
  return type === SubjectType.USER ? 'user_id' : 'service_account_id';
}

@Injectable()
export class ResolverService {
  constructor(private readonly cache: GrantsCacheService) {}

  /**
   * The subject's complete grant set, straight from Postgres (Doc 04 §4.1).
   *
   * Authoritative and uncached — {@link ResolverService.grantsFor} is the
   * read-through entry point. Kept separate so that "what the database says"
   * and "what we are willing to serve from Redis" are different calls: the
   * cache's own tests need the first, and Session 22's invalidation matrix
   * needs to be able to compare the two.
   *
   * @param manager the executor to run on — see this file's header, and
   * `docs/adr/0001-permission-guard-connection-strategy.md`.
   */
  async resolve(
    manager: EntityManager,
    subject: SubjectRef,
    options: ResolveOptions = {},
  ): Promise<ResolvedGrants> {
    const parameters: unknown[] = [subject.clientId, subject.id];
    let applicationFilter = '';

    if (options.applicationId !== undefined) {
      parameters.push(options.applicationId);
      applicationFilter = `and p.application_id = $${parameters.length}::uuid`;
    }

    const rows = (await manager.query(
      `select p.key as permission_key, sn.path::text as scope_path
         from ${S}."role_binding" rb
         join ${S}."scope_node" sn
           on sn.id = rb.scope_node_id and sn.client_id = rb.client_id
         join ${S}."role_permission" rp on rp.role_id = rb.role_id
         join ${S}."permission" p on p.id = rp.permission_id
         join ${S}."application" a on a.id = p.application_id
         join ${S}."client_application" ca
           on ca.client_id = rb.client_id and ca.application_id = p.application_id
        where rb.client_id = $1::uuid
          and rb.${subjectColumn(subject.type)} = $2::uuid
          and (rb.expires_at is null or rb.expires_at > now())
          and p.is_active
          and a.is_active
          and ca.enabled
          ${applicationFilter}`,
      parameters,
    )) as GrantRow[];

    return assembleGrants(rows);
  }

  /**
   * The subject's grants, from the cache when it can be trusted (Doc 04 §6).
   *
   * This is what the endpoints and Session 23's `PermissionGuard` call.
   *
   * **The `applicationId` slice is never served from the cache, and never
   * written to it.** Doc 04 §6 fixes the key as
   * `perms:{clientId}:{subjectType}:{subjectId}` — there is no application
   * component in it, so a filtered result has nowhere to live that would not
   * collide with the full set. Projecting the cached full set instead would be
   * cheap but not exact, since permission keys are unique per application rather
   * than globally (`registry/dto/permissions.dto.ts`). So a filtered call
   * resolves from Postgres, which is the right trade: Doc 06 §11 has consumers
   * cache the slice on their own side and fetch it once, while the per-request
   * hot path — the guard — always wants the whole set.
   */
  async grantsFor(
    manager: EntityManager,
    subject: SubjectRef,
    options: ResolveOptions = {},
  ): Promise<ResolvedGrants> {
    if (options.applicationId !== undefined) {
      return this.resolve(manager, subject, options);
    }

    const cached = await this.cache.read(subject);
    if (cached.grants !== null) return cached.grants;

    const grants = await this.resolve(manager, subject);

    // With the version observed *before* the resolve, never one read after it.
    // If an invalidation landed in between, the entry is written already stale
    // and the next read finds `v` behind the counter and treats it as a miss —
    // a wasted round-trip, and the safe direction. Re-reading the counter here
    // would instead stamp pre-change grants as current, which is the one
    // outcome the version scheme exists to prevent (Doc 04 §7).
    await this.cache.write(subject, grants, cached.version);
    return grants;
  }

  /**
   * `POST /iam/permissions/check` — does this subject hold `permission` at
   * `scopeNodeId` (Doc 04 §4.2, Doc 06 §11)?
   *
   * A node that is not the caller's own is **false**, not a 404. It is the
   * answer the question deserves — the subject does not hold that permission
   * there — and it is also the only answer that does not turn a boolean endpoint
   * into a cross-tenant existence oracle (Doc 06 §2). A missing node and a
   * foreign one are indistinguishable here because RLS makes them so.
   */
  async check(
    manager: EntityManager,
    subject: SubjectRef,
    permission: PermissionKey,
    scopeNodeId: string,
  ): Promise<boolean> {
    const targetPath = await this.scopePathOf(manager, subject.clientId, scopeNodeId);
    if (targetPath === null) return false;

    const grants = await this.grantsFor(manager, subject);
    return grantsCover(grants, permission, targetPath);
  }

  /**
   * The materialized path of one node of this tenant's tree, or `null`.
   *
   * Public because Session 23's `PermissionGuard` resolves its target node from
   * the request the same way, and the two must read the same column under the
   * same tenant predicate.
   */
  async scopePathOf(
    manager: EntityManager,
    clientId: string,
    scopeNodeId: string,
  ): Promise<ScopePath | null> {
    const [row] = (await manager.query(
      `select path::text as path from ${S}."scope_node"
        where client_id = $1::uuid and id = $2::uuid`,
      [clientId, scopeNodeId],
    )) as { path: ScopePath }[];

    return row?.path ?? null;
  }
}
