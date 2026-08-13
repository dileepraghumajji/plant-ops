/**
 * The account-state machine: active, locked, disabled (Doc 03 §8).
 *
 * ## The three states and what each one means at login
 *
 * | State | Login | How it is reached |
 * |---|---|---|
 * | `active` | allowed | the default, and where `unlock` returns an account to |
 * | `locked` | refused `423` | an administrator, or the failed-attempt policy |
 * | `disabled` | refused | an administrator offboarding somebody |
 *
 * `AuthService` is what enforces the left column, and Doc 03 §8's `403` for a
 * disabled account is deliberately returned as the generic `401` at the login
 * endpoint — a 403 there confirms the address is real. That reasoning is in
 * `auth.service.ts`; what lives here is the other half, the transitions.
 *
 * ## Every transition out of `active` force-logs-out
 *
 * Doc 03 §6 lists "revoke all sessions for a user" as the thing to do "on
 * lock/disable", and it is not decoration. An account whose owner can no longer
 * log in but whose existing session keeps working has not been locked in any
 * sense the person locking it would recognise — least of all on the shared gate
 * terminal that is the whole reason revocation exists. Unlock does *not* restore
 * those sessions: a revocation is a fact about a moment, and the account logs in
 * again.
 *
 * ## Why there is no controller in front of this yet
 *
 * The route is `PATCH /iam/users/:id` (Doc 06 §8) and it is a client-admin
 * action gated on `iam.client.user.*`, which needs the `PermissionGuard` that
 * arrives in Session 23 and the user-admin surface from Session 16. Wiring an
 * endpoint now would mean either shipping it ungated — an unauthenticated user
 * could disable anybody in their tenant — or inventing an interim check that
 * Session 23 would immediately delete. So the transitions are implemented,
 * audited and tested here, and the endpoint is a later session's two lines.
 *
 * The automatic lock is not waiting on any of that: it happens inside
 * `iam.auth_record_login_failure` (migration 0014), where the failure it counts
 * already is.
 */

import { Injectable } from '@nestjs/common';
import { ACCOUNT_AUDIT_ACTIONS, IAM_SCHEMA, type UserStatus } from '@plantops/db';
import { afterCommit, entityManager } from '../common/transaction-context';
import { SessionService } from './session.service';
import { AuthAuditAction } from './auth.service';

const S = `"${IAM_SCHEMA}"`;

/** What a transition did, or that there was no such user to do it to. */
export interface AccountStateChange {
  /** False when no user in the caller's tenant has that id. */
  changed: boolean;
  /** Sessions this transition revoked. Empty for `unlock`, and for a no-op. */
  revokedSessions: readonly string[];
}

const UNCHANGED: AccountStateChange = { changed: false, revokedSessions: [] };

@Injectable()
export class AccountStateService {
  constructor(private readonly sessions: SessionService) {}

  /**
   * Locks an account and logs it out everywhere (Doc 03 §8).
   *
   * The administrative counterpart of the failed-attempt policy, and it writes
   * the same `auth.account.locked` action — the event is the account's state
   * changing, and `actor_id` on the row already says who caused it. Migration
   * 0014's header has the full argument for one vocabulary rather than two.
   */
  lock(userId: string, reason?: string): Promise<AccountStateChange> {
    return this.transition(userId, 'locked', ACCOUNT_AUDIT_ACTIONS.ACCOUNT_LOCKED, {
      revokeSessions: true,
      payload: reason === undefined ? {} : { reason },
    });
  }

  /**
   * Returns a locked account to `active`, and clears the counter with it.
   *
   * Clearing matters: an unlock that left `failed_login_attempts` at the
   * threshold would re-lock the account on the very next typo. (The policy path
   * zeroes it as it locks for the same reason, so this is belt and braces
   * against a lock applied by hand in SQL.)
   *
   * Only a `locked` account unlocks. A disabled one is offboarded, and quietly
   * reactivating somebody through the unlock button is not a thing an
   * administrator should be able to do by accident.
   */
  unlock(userId: string): Promise<AccountStateChange> {
    return this.transition(userId, 'active', ACCOUNT_AUDIT_ACTIONS.ACCOUNT_UNLOCKED, {
      revokeSessions: false,
      from: ['locked'],
    });
  }

  /**
   * Disables an account and revokes every session it has (Doc 03 §8).
   *
   * The roadmap's acceptance criterion — "disabling a user revokes all their
   * sessions immediately" — is the `revokeSessions` flag plus the publish
   * below: immediately means the revoked-`sid` cache, because a still-valid
   * access token is refused by the guard reading that cache and by nothing else
   * until it expires.
   */
  disable(userId: string): Promise<AccountStateChange> {
    return this.transition(userId, 'disabled', ACCOUNT_AUDIT_ACTIONS.ACCOUNT_DISABLED, {
      revokeSessions: true,
    });
  }

  /**
   * One status change, audited, with the force-logout that goes with it.
   *
   * Runs on the request transaction — this is an authenticated administrative
   * action, so RLS confines it to the caller's tenant and a user id from another
   * client updates nothing and comes back `changed: false`. The controller that
   * eventually calls this turns that into the same 404 a nonexistent id gets,
   * which is what keeps a denial from revealing that a user exists elsewhere
   * (Doc 06 §2).
   *
   * Idempotent: setting the status an account already has changes no row and
   * writes no audit record. An audit trail that logs "locked" three times
   * because a screen was double-clicked is one nobody can read.
   */
  private async transition(
    userId: string,
    status: UserStatus,
    action: string,
    options: {
      revokeSessions: boolean;
      /** Statuses this transition is legal from. Defaults to any but the target. */
      from?: readonly UserStatus[];
      payload?: Record<string, unknown>;
    },
  ): Promise<AccountStateChange> {
    const allowed = options.from;

    // Wrapped in a CTE so the statement's command is SELECT: TypeORM's Postgres
    // driver returns `[rows, rowCount]` for a bare UPDATE, so `rows.length === 0`
    // would never be true and "no such user" would read as success.
    const rows = (await entityManager().query(
      `with changed as (
         update ${S}."user" u
            set status = $2::${S}."user_status",
                failed_login_attempts = 0,
                last_failed_login_at = null
          where u.id = $1
            and u.status <> $2::${S}."user_status"
            ${allowed === undefined ? '' : `and u.status::text = any($3::text[])`}
          returning u.id
       )
       select id from changed`,
      allowed === undefined ? [userId, status] : [userId, status, [...allowed]],
    )) as { id: string }[];

    if (rows.length === 0) return UNCHANGED;

    await entityManager().query(
      `select ${S}.write_audit($1, 'user', $2, $3::jsonb)`,
      [action, userId, JSON.stringify(options.payload ?? {})],
    );

    const revokedSessions = options.revokeSessions
      ? await this.sessions.revokeAllForUser(userId, AuthAuditAction.SESSION_REVOKED)
      : [];

    if (revokedSessions.length > 0) {
      // After COMMIT, never before (see `SessionService.revoke`): publishing a
      // revocation a rollback then undoes would have every verifier in the fleet
      // refusing sessions that are still live.
      afterCommit(() => this.sessions.publishRevocations(revokedSessions));
    }

    return { changed: true, revokedSessions };
  }
}
