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
 * real. The 403 belongs to a disabled subject presenting a still-valid token,
 * which is Session 10's territory. The audit records `account_disabled` either
 * way, so nothing is lost where it matters.
 */

import { Injectable, Logger } from '@nestjs/common';
import {
  IamErrorCode,
  SubjectType,
  type TokenPairResponse,
} from '@plantops/contracts';
import { IAM_SCHEMA, type LoginFailureReason, type VerifiedClaims } from '@plantops/db';
import { IamException } from '../common/iam.exception';
import { entityManager } from '../common/transaction-context';
import { DatabaseService } from '../database/database.service';
import { verifyPasswordCandidate } from './password.util';
import { SessionService } from './session.service';
import { TokenService } from './token.service';

const S = `"${IAM_SCHEMA}"`;

/** Action strings from the Doc 10 §4 catalog. Session 12 makes this typed. */
export const AuthAuditAction = {
  LOGOUT: 'auth.logout',
  SESSION_REVOKED: 'auth.session.revoked',
} as const;

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
    await this.sessions.revoke(claims.sid, claims, AuthAuditAction.LOGOUT);
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
   */
  private async recordFailure(
    input: LoginInput,
    reason: LoginFailureReason,
  ): Promise<void> {
    try {
      await this.database.dataSource.query(
        `select ${S}.auth_record_login_failure($1, $2, $3)`,
        [input.clientSlug, input.email, reason],
      );
    } catch (error) {
      this.logger.error(
        `Failed to audit a login failure (${reason}): ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
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
