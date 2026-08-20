/**
 * `POST /auth/refresh` — rotation, reuse detection, and the concurrent-refresh
 * grace window (Doc 03 §4).
 *
 * ## The five things that can happen, and who decides them
 *
 * The *decision* is entirely the database's: `iam.auth_rotate_refresh_token`
 * locks the session row and answers `rotated`, `replay`, `stale`, `reuse` or
 * `invalid` (migration 0013). That is not an implementation preference — refresh is a
 * pre-auth path with no RLS context to read the row under, and the read and the
 * write have to be atomic or two concurrent refreshes both rotate.
 *
 * What is left here is the part the database cannot do:
 *
 * - **`rotated`** — mint the access token and hand over the elected successor
 *   (below).
 * - **`replay`** — this client lost a race it was entitled to win. Hand back the
 *   *same* refresh token the winner got — which is the elected one, because
 *   every contender proposed it — with a freshly minted access token.
 * - **`stale`** — a replay whose successor was installed by a rotation that
 *   never saw the election, so the token in hand belongs to nothing. Refuse,
 *   without revoking.
 * - **`reuse`** — the session is already revoked and audited by the time control
 *   returns; what remains is to publish the revoked `sid` and refuse.
 * - **`invalid`** — no such session, revoked, or expired. Refuse.
 *
 * ## One refusal for four different situations
 *
 * Everything that is not a success answers the same 401 `INVALID_CREDENTIALS`,
 * byte-identical, for the reason login does (Doc 03 §3): a response that
 * distinguishes "expired" from "revoked" from "you have been detected" tells the
 * holder of a stolen token exactly how much the owner knows. The audit trail
 * keeps the distinction the response throws away.
 *
 * ## Why the successor is remembered, and where
 *
 * Doc 03 §4 asks that an in-grace replay return "the already-rotated successor",
 * and it has to be that token and not merely *a* token — see
 * `refresh-replay.cache.ts` for what goes wrong when two tabs end up holding two
 * different valid tokens. The database cannot supply it, since refresh tokens are
 * stored hashed, so the successor's secret is cached for the length of the
 * window and looked up only once the row has already ruled the replay legitimate.
 *
 * The election happens *before* the rotation is attempted, so that the answer
 * exists before anything can go looking for it — and it is write-once, so every
 * request racing a given token proposes the same successor. The cache and the
 * row lock can then disagree about which request is the winner without any
 * consequence at all: whoever gets the row installs the elected secret, and
 * whoever is told `replay` is already holding it.
 *
 * ## The one degraded path
 *
 * When the cache is unavailable, rotation is untouched — the request installs
 * its own candidate and hands it over — but a `replay` has nothing trustworthy
 * to return, and this refuses with the same generic 401 **without revoking**.
 * That is the right way round: the session is demonstrably fine, the client
 * re-authenticates, and one person logs in again. Revoking instead would turn a
 * cache blip into a fleet-wide logout, and inventing a fresh token would issue a
 * credential no session has ever heard of — which the *next* refresh would
 * correctly read as compromise.
 */

import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  IamErrorCode,
  SubjectType,
  type TokenPairResponse,
} from '@plantops/contracts';
import { IamException } from '../common/iam.exception';
import { REFRESH_REPLAY_CACHE } from './refresh-replay.provider';
import type { RefreshReplayCache } from './refresh-replay.cache';
import {
  formatRefreshToken,
  hashRefreshSecret,
  mintRefreshSecret,
  parseRefreshToken,
} from './refresh-token.util';
import { SessionService } from './session.service';
import { TokenService } from './token.service';

@Injectable()
export class RefreshService {
  private readonly logger = new Logger(RefreshService.name);

  constructor(
    private readonly tokens: TokenService,
    private readonly sessions: SessionService,
    @Inject(REFRESH_REPLAY_CACHE) private readonly replays: RefreshReplayCache,
  ) {}

  async refresh(presentedToken: string): Promise<TokenPairResponse> {
    const presented = parseRefreshToken(presentedToken);
    // A token that does not parse names no session, so there is nothing to
    // judge and nothing to revoke. Same refusal as every other failure.
    if (presented === null) throw invalidRefreshToken();

    // Elected before the database is touched, not published after it commits —
    // see `refresh-replay.cache.ts`. Every request racing this token proposes
    // the same successor, so it no longer matters which of them wins the row.
    const successorSecret = await this.elect(presented.secret);

    const result = await this.sessions.rotateRefreshToken({
      sessionId: presented.sessionId,
      presentedSecret: presented.secret,
      successorSecret,
    });

    if (result.outcome === 'stale') {
      // A legitimate in-grace replay whose successor this request cannot be
      // given: the rotation it is racing installed a secret nobody agreed on,
      // so the one in hand belongs to no session. Refused, and pointedly not
      // revoked — the session is fine, and it is the cache that failed.
      this.logger.warn(
        `Session ${presented.sessionId} was refreshed concurrently, but the ` +
          'successor the winning request installed was not the elected one; ' +
          'the client presenting the previous token must log in again',
      );
      throw invalidRefreshToken();
    }

    if (result.outcome !== 'rotated' && result.outcome !== 'replay') {
      if (result.outcome === 'reuse') {
        // `auth_rotate_refresh_token` has already set `revoked_at` and written
        // `auth.refresh.reuse_detected` — but only in the database, and the
        // database is not what `AuthGuard` reads on the hot path. Without this
        // publish the revoked `sid` never reaches the cache every verifier
        // checks (Doc 03 §6), so the *access* token that came with the stolen
        // refresh token goes on working for the rest of its TTL — up to fifteen
        // minutes of exactly the access this branch exists to end.
        //
        // Direct rather than deferred: the function is one statement and has
        // already committed by the time it returns, so there is no transaction
        // to hang an `afterCommit` on (see `publishRevocations`).
        await this.sessions.publishRevocations([presented.sessionId]);
      }
      // Beyond that there is nothing to add — least of all a hint in the
      // response. `invalid` means there was never a live session to speak of.
      throw invalidRefreshToken();
    }

    const issued = this.tokens.issueAccessToken({
      subjectId: result.userId,
      subjectType: SubjectType.USER,
      clientId: result.clientId,
      sessionId: presented.sessionId,
    });

    return {
      access_token: issued.accessToken,
      refresh_token: formatRefreshToken(presented.sessionId, successorSecret),
      expires_in: issued.expiresIn,
    };
  }

  /**
   * Elects the successor this refresh will propose to the database.
   *
   * The mechanism, and why it runs before the rotation rather than after it,
   * are in `refresh-replay.cache.ts`. What is decided here is only what to do
   * when the cache cannot answer at all: fall back to the freshly minted
   * candidate. A rotation is then completely unaffected — this request installs
   * its own secret and hands it over — while a replay comes back `stale`,
   * because the database can see that the proposal is not what was installed.
   */
  private async elect(presentedSecret: string): Promise<string> {
    const candidate = mintRefreshSecret();
    try {
      return await this.replays.elect(hashRefreshSecret(presentedSecret), candidate);
    } catch (error) {
      this.logger.warn(
        `The refresh replay cache could not be reached (${(error as Error).message}); ` +
          'a client refreshing concurrently with this one must log in again',
      );
      return candidate;
    }
  }
}

/**
 * The one refusal refresh gives, for every reason it has.
 *
 * Built here rather than as an `IamException` static so the message stays
 * identical at every call site — a message that differs by branch is the same
 * leak as a status that does.
 */
function invalidRefreshToken(): IamException {
  return new IamException(
    IamErrorCode.INVALID_CREDENTIALS,
    'The refresh token is not valid',
  );
}
