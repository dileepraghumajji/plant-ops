/**
 * Login and logout (Doc 03 §3, §6, §8).
 *
 * ## The login sequence, and why each step is where it is
 *
 * Doc 03 §3 numbers it: resolve the client by slug, find the user, verify the
 * password, create the session, issue the tokens, audit. This service follows
 * that order literally, with the first two steps folded into one database call
 * because both are pre-authentication reads that only the migration-0012
 * definer function can perform (see there for why RLS leaves no alternative).
 *
 * ## What the caller is told, and what is recorded
 *
 * These are deliberately different. The caller gets one of two answers:
 *
 * - **401 `INVALID_CREDENTIALS`** for an unknown tenant, an unknown user, a
 *   wrong password, a disabled account, and a suspended tenant alike. Doc 03 §3
 *   requires "no user-enumeration hints", and every additional distinction is a
 *   hint: told apart, "no such user" and "wrong password" turn login into a
 *   directory of who works here.
 * - **423 `ACCOUNT_LOCKED`** for a locked account, which Doc 03 §8 mandates as
 *   its own status — the "Account Locked Users" concept depends on the person
 *   being told to ask an administrator rather than retrying forever. It does
 *   leak that the account exists; that is the spec's explicit trade, and it is
 *   why locking is a deliberate administrative state rather than something a
 *   stranger can provoke by guessing.
 *
 * The audit trail keeps the distinction the response throws away: every failure
 * writes `auth.login.failed` with a reason code from the closed set in
 * migration 0012, so an operator investigating an account can see exactly what
 * happened while an attacker probing it cannot.
 *
 * ## Disabled is 401, not 403
 *
 * Doc 03 §8's table says `disabled → denied (403)`. That is the state machine's
 * view — the account is refused, permanently. At the *login endpoint* it is
 * still returned as the generic 401, because a 403 at an unauthenticated
 * endpoint is precisely a user-enumeration hint: it confirms the address is
 * real. The audit records `account_disabled` either way, so nothing is lost
 * where it matters.
 *
 * A disabled subject holding a still-valid access token is refused too, and
 * also not with a 403: disabling revokes every session it has
 * (`AccountStateService`), so the token's `sid` is in the revoked set and
 * `AuthGuard` answers 401 before any handler runs. That is the stronger
 * outcome — it needs no per-request status lookup, and it reaches every
 * consuming module rather than only this one.
 *
 * ## Locking is not something the login path decides
 *
 * The failed-attempt policy lives in `iam.auth_record_login_failure` (migration
 * 0014), which is called from {@link AuthService.recordFailure} below. It counts
 * the failure and locks the account in one statement, so the two cannot come
 * apart — see there for why the response does not change on the attempt that
 * trips it.
 */

import { Inject, Injectable, Logger } from '@nestjs/common';
import type { EnvConfig } from '@plantops/config';
import {
  IamErrorCode,
  SubjectType,
  type TokenPairResponse,
} from '@plantops/contracts';
import { IAM_SCHEMA, type LoginFailureReason, type VerifiedClaims } from '@plantops/db';
import { ENV } from '../config/env.token';
import { AUDIT_ACTIONS } from '../audit/audit-actions';
import { IamException } from '../common/iam.exception';
import { entityManager } from '../common/transaction-context';
import { DatabaseService } from '../database/database.service';
import { verifyPasswordCandidate } from './password.util';
import { SessionService } from './session.service';
import { TokenService } from './token.service';

const S = `"${IAM_SCHEMA}"`;

export interface LoginInput {
  email: string;
  password: string;
  clientSlug: string;
  deviceLabel?: string | null;
}

/** One row of `iam.auth_lookup_password_identity`. */
interface IdentityRow {
  client_id: string;
  client_status: string;
  user_id: string | null;
  user_status: string | null;
  secret_hash: string | null;
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    @Inject(ENV) private readonly env: EnvConfig,
    private readonly tokens: TokenService,
    private readonly sessions: SessionService,
    private readonly database: DatabaseService,
  ) {}

  async login(input: LoginInput): Promise<TokenPairResponse> {
    const rows = (await entityManager().query(
      `select * from ${S}.auth_lookup_password_identity($1, $2)`,
      [input.clientSlug, input.email],
    )) as IdentityRow[];

    const identity = rows[0];

    // The password is verified even when there is no user and no tenant. That
    // is not wasted work — it is the work that makes the three cases take the
    // same time to refuse (see `password.util.ts`).
    const passwordMatches = await verifyPasswordCandidate(
      identity?.secret_hash,
      input.password,
    );

    const failure = this.classify(identity, passwordMatches);
    if (failure !== null) {
      await this.recordFailure(input, failure);
      throw failure === 'account_locked' ? accountLocked() : invalidCredentials();
    }

    // Narrowing the nullable columns: `classify` returning null means a user
    // row was found and matched, so these are populated.
    const clientId = identity.client_id;
    const userId = identity.user_id as string;

    const session = await this.sessions.begin({
      clientId,
      userId,
      deviceLabel: input.deviceLabel ?? null,
    });

    // Null means the database declined the state it re-checked — the account
    // was locked, or the tenant suspended, between the read above and this
    // write. A narrow race, and the only correct answer is the same refusal the
    // earlier check would have produced.
    if (session === null) {
      await this.recordFailure(input, 'account_locked');
      throw invalidCredentials();
    }

    const issued = this.tokens.issueAccessToken({
      subjectId: userId,
      subjectType: SubjectType.USER,
      clientId,
      sessionId: session.sessionId,
    });

    return {
      access_token: issued.accessToken,
      refresh_token: session.refreshToken,
      expires_in: issued.expiresIn,
    };
  }

  /**
   * Ends the caller's own session (Doc 06 §3).
   *
   * Idempotent by construction: revoking an already-revoked session succeeds,
   * because a client retrying a logout it is not sure landed should not be told
   * it failed — and because `revoked_at` is never overwritten.
   */
  async logout(claims: VerifiedClaims): Promise<void> {
    await this.sessions.revoke(claims.sid, claims, AUDIT_ACTIONS.LOGOUT);
  }

  /**
   * Which failure this is, or `null` when the credentials are good.
   *
   * Ordered by what the *system* knows rather than by what it will say: the
   * tenant before the user, the account state before the password. The password
   * check has already run by the time this is called, so the ordering costs
   * nothing and no branch returns early.
   */
  private classify(
    identity: IdentityRow | undefined,
    passwordMatches: boolean,
  ): LoginFailureReason | null {
    if (identity === undefined) return 'unknown_client';
    if (identity.client_status !== 'active') return 'client_suspended';
    if (identity.user_id === null) return 'unknown_user';
    if (!passwordMatches) return 'bad_password';
    // State is checked *after* the password on purpose. Told "this account is
    // locked" without proving you know the password, an attacker learns the
    // address is real — the enumeration hint the generic 401 exists to deny.
    if (identity.user_status === 'locked') return 'account_locked';
    if (identity.user_status !== 'active') return 'account_disabled';
    return null;
  }

  /**
   * Audits the failure (Doc 03 §3: "always audit failures with reason code").
   *
   * Through the definer function, because there is no authenticated context to
   * write from — and because the function is what pins the action string, the
   * actor type and the closed reason vocabulary (migration 0012).
   *
   * ## On its own connection, deliberately
   *
   * Every *successful* mutation in this system audits inside the caller's
   * transaction, so a rolled-back change leaves no record of having happened
   * (Doc 10 §3). A failed login is the exact inverse: the request ends by
   * throwing, the interceptor rolls the transaction back, and an audit row
   * written inside it would vanish with the 401 — silently, and precisely for
   * the events most worth keeping. Doc 10 §3 anticipates this for denials:
   * "these may be outside a business transaction — best-effort but should not
   * be silently dropped".
   *
   * So it goes to the pool, where it commits on its own. There is no change for
   * it to be atomically coupled to; the only thing that happened *is* the
   * attempt.
   *
   * A failure to write is logged and swallowed. Refusing the login is the
   * security-relevant outcome, and turning a lost audit row into a 500 would
   * hand an attacker a way to distinguish one failure mode from another.
   *
   * ## It is also where the account gets locked
   *
   * Since Session 10 the same function counts the failure and, at
   * `LOGIN_MAX_FAILED_ATTEMPTS`, sets `status = 'locked'` and revokes the
   * account's sessions (migration 0014). Counting belongs there rather than
   * here for the reason the audit does — it is the only path that can read and
   * write the row without an RLS context — and it belongs in the *same*
   * statement as the audit so that a lock and the failure that caused it cannot
   * come apart.
   *
   * What comes back is the sessions the lock killed, because the revoked-`sid`
   * cache lives outside Postgres and only this side can publish to it. That
   * publish is best-effort: the database is authoritative and the guard falls
   * back to it, so a Redis outage delays a force-logout rather than losing it.
   *
   * Note that the caller still receives the generic 401 on the attempt that
   * locks the account, not the 423. Announcing the lock the moment it happens
   * would confirm to whoever provoked it that the address is real — the
   * enumeration hint this whole endpoint is shaped around denying. The 423 is
   * reserved for someone who presents the *correct* password and is told why it
   * is not working (see {@link AuthService.classify}).
   */
  private async recordFailure(
    input: LoginInput,
    reason: LoginFailureReason,
  ): Promise<void> {
    let revoked: string[] = [];
    try {
      const rows = (await this.database.dataSource.query(
        `select ${S}.auth_record_login_failure($1, $2, $3, $4) as revoked_sessions`,
        [
          input.clientSlug,
          input.email,
          reason,
          this.env.LOGIN_MAX_FAILED_ATTEMPTS,
        ],
      )) as { revoked_sessions: string[] | null }[];
      revoked = rows[0]?.revoked_sessions ?? [];
    } catch (error) {
      this.logger.error(
        `Failed to audit a login failure (${reason}): ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return;
    }

    if (revoked.length > 0) {
      this.logger.warn(
        `An account was locked after ${this.env.LOGIN_MAX_FAILED_ATTEMPTS} failed ` +
          `login attempts; ${revoked.length} session(s) were revoked`,
      );
      await this.sessions.publishRevocations(revoked);
    }
  }
}

/**
 * The one refusal login gives, for five different reasons.
 *
 * Built here rather than as an `IamException` static so the message stays
 * identical at every call site — a message that differs by branch is the same
 * leak as a status that does.
 */
function invalidCredentials(): IamException {
  return new IamException(
    IamErrorCode.INVALID_CREDENTIALS,
    'Email, password, or client is incorrect',
  );
}

function accountLocked(): IamException {
  return new IamException(
    IamErrorCode.ACCOUNT_LOCKED,
    'This account is locked. Contact an administrator to unlock it.',
  );
}
