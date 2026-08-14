/**
 * `POST /auth/token` — the client-credentials exchange (Doc 03 §5, Doc 06 §10).
 *
 * ## The sequence, and why it mirrors login
 *
 * Doc 03 §5 numbers it: look the account up by key, verify the secret against
 * `key_hash`, require `active`, issue an access token with `sty=service` and an
 * ephemeral `sid`. This follows that order literally, and the shape is
 * `AuthService.login`'s on purpose — a lookup through a migration-0015 definer
 * function (there is no RLS context before a token exists), a verification that
 * runs whether or not there was anything to verify, a classification that
 * decides the audit reason, and one generic refusal for every branch.
 *
 * ## The `sid` is a uuid that means nothing, and that is the design
 *
 * A human session is a row, which is what makes it revocable mid-token: kill the
 * row, publish the id, every verifier in the fleet refuses it within seconds
 * (Doc 03 §6). A service token's `sid` is generated here and written nowhere.
 *
 * Doc 03 §5 makes that trade explicitly. Machine identities exchange constantly
 * and would otherwise fill the `session` table with rows nobody will ever list
 * or revoke by hand; what replaces mid-token revocation is (a) a TTL of at most
 * five minutes, enforced by the schema in `@plantops/config`, and (b)
 * `status = 'revoked'`, which fails the *next* exchange immediately. The exposure
 * window is bounded by the TTL, and it is bounded whether the revocation was
 * noticed or not.
 *
 * The claim still has to be *present* and well-formed — it is one of the seven
 * (Doc 03 §2) and consuming modules verify the shape — so it is a real uuid,
 * just not one that addresses anything. `SessionService.isRevoked` short-circuits
 * on `sty=service` for exactly this reason: looking the id up would find nothing,
 * read that absence as revoked, and kill every machine identity in the fleet
 * during a cache outage.
 *
 * ## No refresh token, deliberately
 *
 * Doc 03 §5: "no refresh; re-request as needed". A refresh token exists to spare
 * a *human* from re-authenticating, because the alternative is a password
 * prompt. A machine holds its credential already; rotation machinery would add a
 * second long-lived secret to protect and a revocation path to get wrong, in
 * exchange for saving a call every five minutes.
 */

import { Injectable, Logger } from '@nestjs/common';
import {
  IamErrorCode,
  SubjectType,
  type AccessTokenResponse,
} from '@plantops/contracts';
import { IAM_SCHEMA, type ServiceTokenFailureReason } from '@plantops/db';
import { randomUUID } from 'node:crypto';
import { IamException } from '../common/iam.exception';
import { DatabaseService } from '../database/database.service';
import { verifyPasswordCandidate } from './password.util';
import { TokenService } from './token.service';

const S = `"${IAM_SCHEMA}"`;

export interface ServiceTokenInput {
  accountKey: string;
  accountSecret: string;
}

/** One row of `iam.auth_lookup_service_account`. */
interface AccountRow {
  service_account_id: string;
  /** Null for a platform-level account (Doc 01 §3.7). */
  client_id: string | null;
  /** The tenant the token names — the platform client when there is no own one. */
  token_client_id: string | null;
  account_status: string;
  client_status: string | null;
  key_hash: string;
}

@Injectable()
export class ServiceTokenService {
  private readonly logger = new Logger(ServiceTokenService.name);

  constructor(
    private readonly tokens: TokenService,
    private readonly database: DatabaseService,
  ) {}

  async exchange(input: ServiceTokenInput): Promise<AccessTokenResponse> {
    const rows = (await this.database.dataSource.query(
      `select * from ${S}.auth_lookup_service_account($1)`,
      [input.accountKey],
    )) as AccountRow[];

    const account = rows[0];

    // Verified even when there is no such account, for the reason login does
    // it — same code path, same cost, same observable behaviour. It matters
    // less here (a 128-bit key is not something anyone enumerates) and it costs
    // nothing, so the endpoint is not the one place in the system where the
    // timing tells you whether an identity exists. See `password.util.ts`; the
    // helper is named for passwords because that is where the reasoning is
    // written down, and the operation — argon2id against a stored hash, or
    // against the dummy — is exactly the same one.
    const secretMatches = await verifyPasswordCandidate(
      account?.key_hash,
      input.accountSecret,
    );

    const failure = this.classify(account, secretMatches);
    if (failure !== null) {
      await this.recordFailure(input.accountKey, failure);
      throw invalidClientCredentials();
    }

    // `classify` returning null means the row was found and its tenant resolved.
    const clientId = account.token_client_id as string;

    const issued = this.tokens.issueAccessToken({
      subjectId: account.service_account_id,
      subjectType: SubjectType.SERVICE,
      clientId,
      // Ephemeral, and backed by no `session` row at all — see the header.
      sessionId: randomUUID(),
    });

    return {
      access_token: issued.accessToken,
      expires_in: issued.expiresIn,
    };
  }

  /**
   * Which failure this is, or `null` when the credentials are good.
   *
   * Ordered by what the *system* knows rather than by what it will say, exactly
   * as login's is: the tenant before the secret, and the account's own status
   * **after** it. Told "this account is revoked" without presenting the right
   * secret, a caller learns that the key is real and that somebody turned it
   * off — which is worth knowing precisely to whoever should not know it.
   *
   * The secret check has already run by the time this is called, so the ordering
   * costs nothing and no branch returns early.
   */
  private classify(
    account: AccountRow | undefined,
    secretMatches: boolean,
  ): ServiceTokenFailureReason | null {
    if (account === undefined) return 'unknown_account';
    // Covers a suspended tenant and — through the null the lookup returns when
    // the platform client is missing — an account whose tenant cannot be
    // resolved at all. Both are refusals; neither is a 500.
    if (account.client_status !== 'active') return 'client_suspended';
    if (!secretMatches) return 'bad_secret';
    if (account.account_status !== 'active') return 'account_revoked';
    return null;
  }

  /**
   * Audits the refusal, on its own connection.
   *
   * The same reasoning as `AuthService.recordFailure`, and it applies more
   * sharply here: this request ends by throwing, the interceptor rolls the
   * request transaction back on the way out, and a record written inside it
   * would vanish with the 401 — for the events most worth keeping. Doc 10 §3
   * anticipates exactly this for denials. There is nothing for it to be
   * atomically coupled to anyway; the only thing that happened *is* the attempt.
   *
   * A failure to write is logged and swallowed. Refusing the exchange is the
   * security-relevant outcome, and turning a lost audit row into a 500 would
   * hand a caller a way to distinguish one failure mode from another.
   */
  private async recordFailure(
    accountKey: string,
    reason: ServiceTokenFailureReason,
  ): Promise<void> {
    try {
      await this.database.dataSource.query(
        `select ${S}.auth_record_service_token_failure($1, $2)`,
        [accountKey, reason],
      );
    } catch (error) {
      this.logger.error(
        `Failed to audit a service-token exchange failure (${reason}): ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}

/**
 * The one refusal the exchange gives, for all four of its reasons.
 *
 * Built here rather than as an `IamException` static so the message stays
 * identical at every call site — a message that differs by branch is the same
 * leak as a status that does. The audit trail keeps the distinction the response
 * throws away.
 */
function invalidClientCredentials(): IamException {
  return new IamException(
    IamErrorCode.INVALID_CREDENTIALS,
    'The account key or secret is incorrect',
  );
}
