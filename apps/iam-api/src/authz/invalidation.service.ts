/**
 * The grant-invalidation hook — a **stub** until Session 22 (Doc 04 §7).
 *
 * ## What is real here and what is not
 *
 * Real, and the part that is hard to get right later: *when* it is called, and
 * *with what*. Every caller registers this publish with `afterCommit()`, so it
 * runs after `COMMIT` returns and never before — the ordering Doc 04 §7.1 calls
 * mandatory for the scope-move case, because invalidating early lets a reader
 * repopulate its cache from pre-change state and re-poison it. The same
 * discipline is applied to every other cause, since the failure mode does not
 * belong to scope moves, only its worst instance does. That ordering is asserted
 * by the tests of the sessions that call this.
 *
 * Not real: the publish itself. This logs.
 *
 * Session 21 changed what that costs. The cache now exists —
 * `perms:{clientId}:{sty}:{subjectId}` and its version counter, in
 * {@link GrantsCacheService} — so a bind, an unbind, a lock or a scope move
 * that reaches this method today leaves a live cache entry behind it, and the
 * subject keeps their pre-change grants until the entry's TTL expires. That is
 * a real gap and it is bounded rather than open-ended: Doc 04 §6 caps the TTL
 * at ten minutes for exactly this reason, and §7.1 point 5 states the direction
 * the residual staleness must fall in.
 *
 * Session 22 closes it, and the whole of the closing is inside this file: every
 * arm of {@link InvalidationReason} becomes a `GrantsCacheService.bump()` over
 * the subjects it names, plus the Redis `publish` to
 * {@link PERMS_INVALIDATED_CHANNEL} that tells cache holders in other processes
 * to do the same. The callers do not change — which is what the argument below
 * about "a service rather than a callback parameter" bought.
 *
 * It is deliberately **not** done here. Doc 04 §7's table has eight rows and
 * three of them have writers today; wiring those three would make the mechanism
 * look finished while a role's permissions being edited still went unnoticed,
 * which is a worse failure than a stub that nobody mistakes for the real thing.
 *
 * ## Why it lives in `authz/` and not beside its callers
 *
 * It was Session 16's `scopes/scope-invalidation.service.ts` while the scope
 * move was its only caller, on the stated grounds that a stub with one caller
 * does not need a shared home. Session 18 gives it a second one — Doc 04 §7's
 * row "user locked/disabled → that subject (+ revoke sessions)" — so it moves
 * to the file Session 22 will replace, and both callers point at the name that
 * will still be right afterwards.
 *
 * ## Why a service rather than a callback parameter
 *
 * Session 22 replaces the body of {@link GrantInvalidationService.publish} with
 * the real version-bump-and-publish, and its callers should not change when it
 * does. An injected collaborator makes that a one-file edit and, in the
 * meantime, gives the tests something to spy on — which is how the post-commit
 * ordering is provable at all.
 */

import { Injectable, Logger } from '@nestjs/common';
import { PERMS_INVALIDATED_CHANNEL, SubjectType } from '@plantops/contracts';

/** A subject whose effective grants may have changed. */
export interface AffectedSubject {
  type: SubjectType;
  id: string;
}

/**
 * Why the subjects are being invalidated — one member per row of Doc 04 §7's
 * table that has a writer today.
 *
 * A discriminated union rather than a `cause` string with a bag of optional
 * ids, so each cause carries exactly the target that explains it and no caller
 * can announce a scope move without naming the node. The union grows as
 * Sessions 20–22 supply the remaining rows.
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
      cause: 'role_binding.created' | 'role_binding.deleted';
      /**
       * The grant that was written or removed; the affected subject is its own.
       *
       * The id rather than the subject: the subject is already in the
       * `subjects` argument, and what an operator correlating a cache flush with
       * the audit trail has in hand is the `role_binding.created` record's
       * target, which is this.
       */
      bindingId: string;
    };

@Injectable()
export class GrantInvalidationService {
  private readonly logger = new Logger(GrantInvalidationService.name);

  /**
   * Announces that these subjects' cached grants are stale.
   *
   * **Call only from `afterCommit()`.** Nothing enforces that structurally, and
   * it is the single most important property of this call — see the header.
   *
   * Never throws: it runs after the request's write has committed, and a failed
   * cache publish must not turn a successful move or lockout into an error. The
   * interceptor logs anything that escapes a post-commit callback; this logs the
   * failure itself so the *reason* is not lost behind that generic line.
   *
   * `async` although the stub has nothing to await: the real publish is a Redis
   * round-trip, and a signature that changed in Session 22 would change
   * `afterCommit`'s contract with it — the callback's promise is what the
   * interceptor waits on, so a synchronous stub would quietly stop being waited
   * for the day the body became asynchronous.
   */
  async publish(
    clientId: string,
    subjects: readonly AffectedSubject[],
    reason: InvalidationReason,
  ): Promise<void> {
    if (subjects.length === 0) return;

    this.logger.log(
      `${PERMS_INVALIDATED_CHANNEL} (stub, Session 22 publishes): ` +
        `${subjects.length} subject(s) in client ${clientId} after ` +
        `${reason.cause} on ${targetOf(reason)}`,
    );
  }
}

/**
 * The id the reason is about, whichever kind of reason it is.
 *
 * A `switch` over the discriminant rather than a chain of ternaries, so a member
 * added to {@link InvalidationReason} without a case here fails to compile —
 * which is the point of making the union discriminated in the first place.
 */
function targetOf(reason: InvalidationReason): string {
  switch (reason.cause) {
    case 'scope_node.moved':
      return reason.scopeNodeId;
    case 'user.locked':
    case 'user.disabled':
      return reason.userId;
    case 'role_binding.created':
    case 'role_binding.deleted':
      return reason.bindingId;
  }
}
