/**
 * Grant invalidation — every row of Doc 04 §7's table, wired (Session 22).
 *
 * Session 21 built the cache; this is what keeps it honest. Doc 04 §7 opens with
 * the requirement the whole file exists to meet: a change that could alter a
 * subject's grants must invalidate the relevant entries **immediately**, not
 * eventually. The ten-minute TTL of Doc 04 §6 is the backstop for the one cause
 * that fires no event at all — a binding's `expires_at` passing — and a backstop
 * is all it is. Everything else arrives here.
 *
 * ## Two halves, split across the commit
 *
 * This service does two things that look unrelated and are in fact the same
 * mechanism observed at two moments:
 *
 * 1. **Finding who is affected** — `subjectsBoundToRole`, `subjectsOfClient`,
 *    `subjectsBoundToPermissions`. These are *queries*, so they run inside the
 *    caller's request transaction, where the RLS context exists (Doc 07 §5), and
 *    therefore **before** commit.
 * 2. **Announcing it** — {@link GrantInvalidationService.publish}. This is a
 *    Redis write, so it runs from `afterCommit()`, **after** commit.
 *
 * The order is not a convenience. Doc 04 §7.1 rule 3 makes it mandatory for the
 * scope-move case: publishing before the transaction commits lets a reader
 * repopulate its cache from the pre-change tree and re-poison it, so the flush
 * happens and then the stale data comes back. The same hazard exists for every
 * other cause — a role's permissions edited, a user locked — and only its worst
 * instance belongs to scope moves, so every caller uses `afterCommit()` and the
 * ordering is asserted in the tests of the sessions that call it.
 *
 * The lookup being pre-commit is the mirror image of the same constraint. After
 * `COMMIT` the transaction is gone, and with it the RLS context — a query on the
 * pool would see no tenant at all (Doc 07 §5) and return an empty affected set,
 * silently invalidating nobody. `scopes.service.ts` has always had to capture its
 * subjects before the path rewrite because the old prefix stops existing; the
 * other five causes have the same requirement for a different reason, and get
 * the same treatment.
 *
 * ## Why the fan-out is enumerated
 *
 * Doc 04 §7 offers a choice for role-level invalidation: "either fan out to
 * affected subjects (look them up) or bump a per-role version that resolution
 * checks", and its recommended sketch — a counter per `(client, subject)` — is
 * what Session 21 built. That counter cannot answer a role-level change on its
 * own: "every subject bound to this role" is not derivable from a per-subject
 * key, so something has to enumerate. The alternatives were a *second* counter
 * per role that {@link GrantsCacheService.read} would also have to check, which
 * would make every cache read do an extra `GET` for the sake of four rare admin
 * operations, or this — a `select distinct` at write time.
 *
 * Enumeration wins on where the cost lands. Reads happen on every request; role
 * edits, role deletions, application toggles and manifest re-uploads happen when
 * an administrator does something deliberate. Paying a `select distinct` and one
 * pipelined `INCR` batch on those, to keep the hot path at exactly the two keys
 * Doc 04 §6 publishes, is the trade this file makes — and it is the "documented
 * fan-out" the roadmap's acceptance criterion permits, documented here.
 *
 * Note the enumeration is *not* a source of races. A binding created between the
 * lookup and the commit publishes its own invalidation from its own transaction,
 * because `role_binding.created` is itself a row of the §7 table.
 *
 * ## What is bumped and what is published
 *
 * Both, always, and they are not the same thing:
 *
 * - **The version bump** is what makes *this* deployment correct. It is always
 *   per-subject over the enumerated list, because that is the granularity
 *   {@link GrantsCacheService} stores.
 * - **The `perms.invalidated` publish** is for cache holders in other processes
 *   (Doc 04 §7). It is emitted at the granularity the *cause* has —
 *   `{clientId, roleId}` for a role change, `{clientId}` for a tenant-wide app
 *   toggle, `{clientId, subjectId, subjectType}` otherwise — because a consumer
 *   deletes matching keys and the coarser forms let it do that without knowing
 *   the tenant's binding graph.
 *
 * A subscriber that over-deletes on a coarse event pays for one resolve. A
 * subscriber that under-deletes serves grants that were revoked. The granularity
 * therefore rounds *up*, never down, which is the same direction Doc 04 §7.1
 * rule 5 requires of every other uncertainty here.
 *
 * ## Why it lives in `authz/` and not beside its callers
 *
 * It was Session 16's `scopes/scope-invalidation.service.ts` while the scope move
 * was its only caller. It has seven now, across `scopes`, `users`, `bindings`,
 * `roles`, `clients`, `service-accounts` and `registry` — none of which may
 * import each other — so the shared home is the module all of them already
 * depend on for this and nothing else.
 */

import { Injectable, Logger } from '@nestjs/common';
import {
  PERMS_INVALIDATED_CHANNEL,
  SubjectType,
  type PermsInvalidatedEvent,
} from '@plantops/contracts';
import { IAM_SCHEMA } from '@plantops/db';
import { entityManager } from '../common/transaction-context';
import { withTimeout } from '../common/with-timeout';
import { RedisService } from '../redis/redis.service';
import { GrantsCacheService } from './grants-cache.service';

const S = `"${IAM_SCHEMA}"`;

/**
 * Budget for the publish round-trip.
 *
 * Longer than the cache's 250 ms read budget, and deliberately: this runs after
 * the response has been sent, so nothing is waiting on it, and the cost of
 * giving up early is a stale grant rather than a slow request. Still bounded,
 * because `afterCommit` callbacks are awaited by `TenantContextInterceptor` and
 * an unbounded one would pin a request's async context open behind a wedged
 * Redis.
 */
const PUBLISH_TIMEOUT_MS = 1_000;

/** A subject whose effective grants may have changed. */
export interface AffectedSubject {
  type: SubjectType;
  id: string;
}

/** An affected subject together with the tenant whose cache key it lives under. */
export interface TenantSubject extends AffectedSubject {
  clientId: string;
}

/**
 * Why the subjects are being invalidated — one member per row of Doc 04 §7's
 * table.
 *
 * A discriminated union rather than a `cause` string with a bag of optional ids,
 * so each cause carries exactly the target that explains it and no caller can
 * announce a scope move without naming the node. Session 20's version had three
 * members because three rows had writers; Session 22 completes it.
 *
 * The one row with no member is `role_binding` *updated*. Nothing in the API
 * updates a binding — Doc 06 §9 offers create, list and delete only, and a
 * changed grant is an unbind and a re-bind — so a member for it would be an arm
 * no code path can reach.
 */
export type InvalidationReason =
  | {
      cause: 'scope_node.moved';
      /** The node whose subtree moved. */
      scopeNodeId: string;
    }
  | {
      cause: 'user.locked' | 'user.disabled';
      /** The account whose state changed; the sole affected subject. */
      userId: string;
    }
  | {
      cause: 'service_account.revoked';
      /** The machine identity that was revoked; the sole affected subject. */
      serviceAccountId: string;
    }
  | {
      cause: 'role_binding.created' | 'role_binding.deleted' | 'role_binding.expired';
      /**
       * The grant that was written, removed or lapsed; the affected subject is
       * its own.
       *
       * The id rather than the subject: the subject is already in the `subjects`
       * argument, and what an operator correlating a cache flush with the audit
       * trail has in hand is the `role_binding.created` record's target, which
       * is this.
       */
      bindingId: string;
    }
  | {
      cause: 'role_permission.changed' | 'role.deleted';
      /**
       * The role whose grants changed. Every subject bound to it is affected —
       * which is why this is the one shape that publishes a role-level event
       * rather than one per subject.
       */
      roleId: string;
    }
  | {
      cause: 'client_application.toggled';
      /**
       * The application enabled or disabled for this tenant. Both directions
       * change effective grants (Doc 04 §7): disabling makes the app's
       * permissions inert, enabling restores them.
       */
      applicationId: string;
    }
  | {
      cause: 'permission.deactivated';
      /** The application whose manifest re-upload deactivated permissions. */
      applicationId: string;
      /** The keys that went inert, for the operator reading the log line. */
      permissionKeys: readonly string[];
    };

@Injectable()
export class GrantInvalidationService {
  private readonly logger = new Logger(GrantInvalidationService.name);

  constructor(
    private readonly cache: GrantsCacheService,
    private readonly redis: RedisService,
  ) {}

  /**
   * Announces that these subjects' cached grants are stale (Doc 04 §7).
   *
   * **Call only from `afterCommit()`.** Nothing enforces that structurally, and
   * it is the single most important property of this call — see the header.
   *
   * Never throws: it runs after the request's write has committed, and a failed
   * cache publish must not turn a successful move or lockout into an error. Both
   * halves swallow their own errors — {@link GrantsCacheService.bumpMany} logs
   * and returns, and the publish below is wrapped — so a Redis outage degrades
   * this to the TTL backstop rather than surfacing as a 500 on a request whose
   * database work already succeeded.
   */
  async publish(
    clientId: string,
    subjects: readonly AffectedSubject[],
    reason: InvalidationReason,
  ): Promise<void> {
    if (subjects.length === 0) return;

    // Bump first, publish second. This process reads its own cache through the
    // counter, so bumping is what makes the *next local request* correct; the
    // publish is for everyone else. If only one of the two can happen, it should
    // be the one that fixes the deployment holding the connection that just
    // committed — which is also the one serving the administrator who made the
    // change, and whom Doc 04 §7.1 rule 4 requires to see their own writes.
    await this.cache.bumpMany(
      subjects.map((subject) => ({ clientId, type: subject.type, id: subject.id })),
    );

    const events = eventsFor(clientId, subjects, reason);
    const channel = this.redis.channel(PERMS_INVALIDATED_CHANNEL);

    try {
      const pipeline = this.redis.client.pipeline();
      for (const event of events) {
        pipeline.publish(channel, JSON.stringify(event));
      }
      await withTimeout(pipeline.exec(), PUBLISH_TIMEOUT_MS, 'perms.invalidated publish');
    } catch (error) {
      // The local cache is already correct — `bumpMany` ran above — so what is
      // lost here is only the notification to *other* processes, which fall back
      // to their TTL. Logged at error rather than warn because in a multi-replica
      // deployment that is a real, if bounded, correctness gap.
      this.logger.error(
        `${PERMS_INVALIDATED_CHANNEL} could not be published after ${reason.cause} ` +
          `in client ${clientId} (${messageOf(error)}); other cache holders will ` +
          'serve stale grants until their TTL expires',
      );
    }
  }

  /**
   * {@link GrantInvalidationService.publish} for subjects spanning tenants.
   *
   * Only `permission.deactivated` needs it: a manifest re-upload is a *platform*
   * action against an application that any number of clients may have enabled, so
   * the roles mapping a deactivated permission belong to many tenants at once
   * (Doc 02 §7). Every other cause is a tenant's own administrator acting inside
   * their own tenant.
   *
   * Grouped and published per client rather than flattened, because a cache key
   * is `perms:{clientId}:…` and an event carries a `clientId` — neither has a
   * meaningful cross-tenant form.
   */
  async publishAcrossTenants(
    subjects: readonly TenantSubject[],
    reason: InvalidationReason,
  ): Promise<void> {
    const byClient = new Map<string, AffectedSubject[]>();
    for (const subject of subjects) {
      const group = byClient.get(subject.clientId);
      if (group === undefined) {
        byClient.set(subject.clientId, [{ type: subject.type, id: subject.id }]);
      } else {
        group.push({ type: subject.type, id: subject.id });
      }
    }

    for (const [clientId, group] of byClient) {
      await this.publish(clientId, group, reason);
    }
  }

  /**
   * Every subject bound to `roleId` — Doc 04 §7's "all subjects bound to that
   * role", for both the `role_permission changed` and `role deleted` rows.
   *
   * **Call before the mutation commits**, and for `role.deleted` before the
   * delete itself: `role_binding` cascades on the role's foreign key
   * (migration 0004), so after the `DELETE` there is nothing left to enumerate
   * and the invalidation would find an empty set.
   */
  async subjectsBoundToRole(
    clientId: string,
    roleId: string,
  ): Promise<AffectedSubject[]> {
    const rows = (await entityManager().query(
      `select distinct rb.user_id, rb.service_account_id
         from ${S}."role_binding" rb
        where rb.client_id = $1 and rb.role_id = $2`,
      [clientId, roleId],
    )) as SubjectRow[];

    return rows.map(toAffected);
  }

  /**
   * Every subject holding any binding in this tenant — Doc 04 §7's "subjects of
   * that client", for the `client_application` toggle.
   *
   * Bindings rather than users: a tenant member with no binding has no grants to
   * invalidate, so their cache entry is the empty set either way and bumping it
   * would be work with no effect. The join to `role_binding` is what keeps the
   * fan-out proportional to *granted access* rather than to headcount.
   */
  async subjectsOfClient(clientId: string): Promise<AffectedSubject[]> {
    const rows = (await entityManager().query(
      `select distinct rb.user_id, rb.service_account_id
         from ${S}."role_binding" rb
        where rb.client_id = $1`,
      [clientId],
    )) as SubjectRow[];

    return rows.map(toAffected);
  }

  /**
   * Every subject, in every tenant, bound to a role that maps one of these
   * permissions — Doc 04 §7's manifest row.
   *
   * The reason that row exists at all is worth stating, because it is the least
   * obvious entry in the table: a soft-deactivated permission is *not* removed
   * from any `role_permission` mapping (Doc 02 §7 keeps the row so re-adding the
   * key restores it), so nothing about the binding graph changes. What changes is
   * `permission.is_active`, which `resolve()` filters on — and §7 says in as many
   * words that "cached grants may still reference a now-inert permission key".
   * Without this lookup the key would keep working for up to a TTL after the
   * upload that retired it.
   *
   * Spans tenants, so it returns {@link TenantSubject} and its caller uses
   * {@link GrantInvalidationService.publishAcrossTenants}. That is safe to run
   * only from the platform context a manifest upsert already has: under a tenant
   * context RLS would narrow it to one client and quietly under-invalidate.
   */
  async subjectsBoundToPermissions(
    permissionIds: readonly string[],
  ): Promise<TenantSubject[]> {
    if (permissionIds.length === 0) return [];

    const rows = (await entityManager().query(
      `select distinct rb.client_id, rb.user_id, rb.service_account_id
         from ${S}."role_binding" rb
         join ${S}."role_permission" rp on rp.role_id = rb.role_id
        where rp.permission_id = any($1::uuid[])`,
      [permissionIds],
    )) as (SubjectRow & { client_id: string })[];

    return rows.map((row) => ({ ...toAffected(row), clientId: row.client_id }));
  }
}

interface SubjectRow {
  user_id: string | null;
  service_account_id: string | null;
}

/**
 * A binding row's subject, whichever arm of the XOR is populated.
 *
 * The `??` is not a fallback: migration 0004's check constraint makes exactly one
 * of the two columns non-null, so the service-account arm is reached precisely
 * when `user_id` is null. Written this way rather than with an `if` because the
 * constraint is what guarantees the total function, and restating it as a
 * runtime branch would suggest a third case exists.
 */
function toAffected(row: SubjectRow): AffectedSubject {
  return row.user_id === null
    ? { type: SubjectType.SERVICE, id: row.service_account_id as string }
    : { type: SubjectType.USER, id: row.user_id };
}

/**
 * The `perms.invalidated` messages a cause produces (Doc 04 §7).
 *
 * Three granularities, chosen by the reason rather than by the subject count —
 * see the header for why they round up. Exported for the unit tests, which assert
 * the mapping directly: it is a pure function of the reason, and testing it
 * through a Redis double would only prove that a mock was called.
 */
export function eventsFor(
  clientId: string,
  subjects: readonly AffectedSubject[],
  reason: InvalidationReason,
): PermsInvalidatedEvent[] {
  switch (reason.cause) {
    // Role-level: the contract's own `roleId` form, which lets a subscriber drop
    // the role's subjects without being told who they are.
    case 'role_permission.changed':
    case 'role.deleted':
      return [{ clientId, roleId: reason.roleId }];

    // Tenant-level: enabling or disabling an application moves every permission
    // it owns, for everyone. A per-subject fan-out here would be a long message
    // list saying what one message says.
    case 'client_application.toggled':
      return [{ clientId }];

    // Subject-level: the cause names one subject, or (a scope move, a manifest
    // deactivation) a set that has no coarser description than its members.
    default:
      return subjects.map((subject) => ({
        clientId,
        subjectId: subject.id,
        subjectType: subject.type,
      }));
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
