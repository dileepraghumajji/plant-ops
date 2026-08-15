/**
 * The grant-invalidation hook for scope moves — a **stub** until Session 22
 * (Doc 04 §7, §7.1).
 *
 * ## What is real here and what is not
 *
 * Real, and the part that is hard to get right later: *when* it is called, and
 * *with what*. `ScopesService` captures the affected subjects **before** the
 * path rewrite and registers this publish with `afterCommit()`, so it runs after
 * `COMMIT` returns and never before — the ordering Doc 04 §7.1 calls mandatory,
 * because invalidating early lets a reader repopulate its cache from the
 * pre-move tree and re-poison it. That ordering is asserted by this session's
 * tests.
 *
 * Not real: the publish itself. There is no grants cache to invalidate yet —
 * `perms:{clientId}:{sty}:{subjectId}` and its version counter arrive with the
 * resolution engine in Session 21 — so a Redis `publish` to
 * {@link PERMS_INVALIDATED_CHANNEL} today would be a message with no subscriber
 * and no cache behind it. This logs instead.
 *
 * ## Why a service rather than a callback parameter
 *
 * Session 22 replaces the body of {@link ScopeInvalidationService.publish} with
 * the real version-bump-and-publish (its `authz/invalidation.service.ts`), and
 * `ScopesService` should not change when it does. An injected collaborator makes
 * that a one-file edit and, in the meantime, gives the tests something to spy on
 * — which is how the post-commit ordering is provable at all.
 */

import { Injectable, Logger } from '@nestjs/common';
import { PERMS_INVALIDATED_CHANNEL, SubjectType } from '@plantops/contracts';

/** A subject whose effective grants may have changed. */
export interface AffectedSubject {
  type: SubjectType;
  id: string;
}

/** Why the subjects are being invalidated. Carried into the log, and later the event. */
export interface InvalidationReason {
  /** `scope_node.moved` today; the catalog grows with Session 22. */
  cause: 'scope_node.moved';
  /** The node whose subtree moved. */
  scopeNodeId: string;
}

@Injectable()
export class ScopeInvalidationService {
  private readonly logger = new Logger(ScopeInvalidationService.name);

  /**
   * Announces that these subjects' cached grants are stale.
   *
   * **Call only from `afterCommit()`.** Nothing enforces that structurally, and
   * it is the single most important property of this call — see the header.
   *
   * Never throws: it runs after the request's write has committed, and a failed
   * cache publish must not turn a successful move into an error. The interceptor
   * logs anything that escapes a post-commit callback; this logs the failure
   * itself so the *reason* is not lost behind that generic line.
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
        `${reason.cause} on ${reason.scopeNodeId}`,
    );
  }
}
