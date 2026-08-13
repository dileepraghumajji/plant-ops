/**
 * `POST /auth/password/reset-request` and `/auth/password/reset` (Doc 03 §7,
 * Doc 06 §3).
 *
 * ## The request half answers 202 and tells you nothing
 *
 * Every path through {@link PasswordResetService.request} — unknown tenant,
 * unknown address, locked account, disabled account, suspended tenant, mail
 * transport on fire — ends the same way: accepted, no body, no hint. That is
 * Doc 06 §3's `202`, and it exists for the reason login's generic 401 does. A
 * reset endpoint that distinguishes "sent" from "no such user" is a directory
 * of who works here, published to anyone who can type an email address, and it
 * is a *better* directory than login's because it needs no password to query.
 *
 * The consequence is that this method returns `void` and has nothing to report.
 * What actually happened is in the audit trail (`auth.password.reset_requested`
 * is written only when a token was really issued) and in the delivery log.
 *
 * ## The completion half is the one that changes things
 *
 * `iam.auth_complete_password_reset` decides it, under `for update`, for the
 * same reason refresh rotation lives in the database (migration 0013): the check
 * and the spend have to be atomic or two concurrent presentations of one token
 * each set a password. What comes back is `completed` or `invalid` — an expired
 * token, a spent one, one belonging to a locked account and one that matches
 * nothing are all the same answer here, and all the same 401 to the caller.
 *
 * ## Both halves run on the pool, not the request transaction
 *
 * For the reason `AuthService.recordFailure` and `SessionService.rotateRefreshToken`
 * do. These are pre-auth paths: there is no verified `cid`, so there is no RLS
 * context the request transaction could carry, and the definer functions supply
 * their own. Completion additionally must not lose its work to the rollback that
 * follows an invalid token — though on that branch there is nothing to lose,
 * which is the point of not marking a refused token as spent.
 *
 * ## Password policy is enforced at the DTO, not here
 *
 * Doc 03 §7 asks for a minimum policy "at the API", and the API's validation
 * boundary is `validation.pipe.ts`. So `passwordSchema` — the same schema any
 * future set-password endpoint uses — runs before this service is reached, and a
 * short password is a 400 with a field-level detail rather than a 401 that makes
 * the caller guess. The breach-list check Doc 03 §7 calls optional is not
 * implemented; it needs a corpus and a lookup budget, and the honest position is
 * that length is what v1 enforces.
 */

import { Inject, Injectable, Logger } from '@nestjs/common';
import type { EnvConfig } from '@plantops/config';
import { IamErrorCode } from '@plantops/contracts';
import { IAM_SCHEMA, hashSecret, type PasswordResetOutcome } from '@plantops/db';
import { ENV } from '../config/config.module';
import { IamException } from '../common/iam.exception';
import { DatabaseService } from '../database/database.service';
import {
  PASSWORD_RESET_DELIVERY,
  type PasswordResetDelivery,
} from './password-reset.delivery';
import { hashResetToken, mintResetToken } from './password-reset.util';
import { SessionService } from './session.service';

const S = `"${IAM_SCHEMA}"`;

export interface ResetRequestInput {
  email: string;
  clientSlug: string;
}

export interface ResetCompletionInput {
  token: string;
  newPassword: string;
}

/** One row of `iam.auth_complete_password_reset`. */
interface CompletionRow {
  outcome: PasswordResetOutcome;
  revoked_sessions: string[] | null;
}

@Injectable()
export class PasswordResetService {
  private readonly logger = new Logger(PasswordResetService.name);

  constructor(
    @Inject(ENV) private readonly env: EnvConfig,
    @Inject(PASSWORD_RESET_DELIVERY) private readonly delivery: PasswordResetDelivery,
    private readonly database: DatabaseService,
    private readonly sessions: SessionService,
  ) {}

  /**
   * Issues a reset token if — and only if — there is an active account behind
   * the address, and hands it to the delivery channel.
   *
   * The token is minted before the database is asked anything, so the work this
   * method does is the same shape whether or not the account exists. That is a
   * far weaker property than login's dummy-hash timing defence (there is no
   * argon2 here to dominate the cost) and it is not claimed as one; it simply
   * removes the branch that would have been free to notice.
   */
  async request(input: ResetRequestInput): Promise<void> {
    const token = mintResetToken();
    const expiresAt = new Date(Date.now() + this.env.PASSWORD_RESET_TTL_SECONDS * 1000);

    const rows = (await this.database.dataSource.query(
      `select ${S}.auth_request_password_reset($1, $2, $3, $4) as issued`,
      [input.clientSlug, input.email, hashResetToken(token), expiresAt.toISOString()],
    )) as { issued: boolean }[];

    if (rows[0]?.issued !== true) return;

    try {
      await this.delivery.deliver({
        email: input.email,
        clientSlug: input.clientSlug,
        token,
        expiresAt,
      });
    } catch (error) {
      // Swallowed on purpose. The row is written and audited; the caller is
      // getting a 202 whatever happens here, and turning a transport outage
      // into a 500 would tell an attacker which addresses are real by which
      // ones fail slowly.
      this.logger.error(
        `A password-reset token was issued but could not be delivered: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /**
   * Spends a reset token and sets the new password.
   *
   * The argon2id hash is computed before the token is checked, which costs an
   * expensive hash on a refusal and is worth it: computing it afterwards would
   * make a valid token measurably slower than an invalid one, which is the
   * timing oracle `password.util.ts` goes to some length to close on login.
   */
  async complete(input: ResetCompletionInput): Promise<void> {
    const secretHash = await hashSecret(input.newPassword);

    const rows = (await this.database.dataSource.query(
      `select * from ${S}.auth_complete_password_reset($1, $2)`,
      [hashResetToken(input.token), secretHash],
    )) as CompletionRow[];

    const result = rows[0];
    if (result === undefined || result.outcome !== 'completed') {
      throw invalidResetToken();
    }

    // Doc 03 §6: the sessions the reset killed are dead in the database, and
    // every verifier in the fleet learns about it here. Best-effort, and the
    // database stays authoritative — `SessionService.isRevoked` is the fallback
    // when a publish is lost.
    await this.sessions.publishRevocations(result.revoked_sessions ?? []);
  }
}

/**
 * The one refusal completion gives, for every reason it has.
 *
 * Built here rather than as an `IamException` static so the message stays
 * identical at every call site — a message that differs by branch is the same
 * leak as a status that does.
 */
function invalidResetToken(): IamException {
  return new IamException(
    IamErrorCode.INVALID_CREDENTIALS,
    'This password reset link is not valid or has expired',
  );
}
