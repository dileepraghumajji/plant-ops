/**
 * `POST /iam/introspect` — is this token live, and whose is it (Doc 06 §11)?
 *
 * ## What it is for, and what it is not
 *
 * Doc 06 §11 is direct about the order of preference: *"Modules should prefer
 * local JWT verification via JWKS + a call to `/permissions/resolve`, reserving
 * `/introspect` for opaque/edge cases."* Every module can already verify a
 * signature offline against `/iam/.well-known/jwks.json`, and doing so keeps the
 * IAM off their per-request path. This endpoint exists for the cases where that
 * is not enough — a gateway that will not carry a JWKS cache, a module that
 * needs the *live* revocation answer rather than one bounded by the token's own
 * expiry.
 *
 * That last point is the whole value proposition: `active` here is not a
 * restatement of `exp`. It is the same three-step judgement the app-wide
 * `AuthGuard` makes on every request — signature, claims, revocation — and the
 * revocation half is the part a local verifier cannot reproduce.
 *
 * ## Every rejection is `{ active: false }`
 *
 * A forged signature, an unknown `kid`, an expired token, a token from a
 * different issuer and a revoked session all produce the identical answer, with
 * no identity fields — which is what {@link IntrospectResponse}'s union makes
 * unrepresentable rather than merely discouraged. The reason is `auth.guard.ts`'s
 * reason for its bare 401: telling the caller *which* check failed tells an
 * attacker whether a forged `kid` was a near miss. The specific rejection is
 * kept server-side on `TokenVerificationError` for logs.
 *
 * ## Why the introspected token is not required to be the caller's own tenant
 *
 * It would be a natural reading of Doc 06 §2 — "denials never reveal whether the
 * target exists across tenants" — to answer `{ active: false }` for a token
 * whose `cid` differs from the caller's. It is deliberately *not* done, because
 * there is nothing here to reveal. The caller already **holds** the token: a
 * JWS payload is base64, so `sub`, `sty`, `cid` and `sid` are readable from it
 * without asking anyone, and the only fact this endpoint adds is liveness — for
 * a token they could simply have used instead. Refusing would break the
 * legitimate case (one module serving several tenants) to protect nothing.
 *
 * The endpoint is still authenticated, so it is not an oracle for *arbitrary*
 * strings: reaching it at all requires a valid bearer of one's own.
 *
 * ## Uncertainty is inactive
 *
 * When neither the revocation cache nor the database can answer, the token is
 * reported inactive. That is `AuthGuard`'s `onRevocationUnavailable: 'deny'`
 * (`auth.module.ts`) applied to the same question, and it must stay the same
 * direction in both places: a consumer that trusted this endpoint's `active`
 * during a Redis outage would honour revoked sessions the IAM itself was
 * refusing.
 */

import { Inject, Injectable, Logger } from '@nestjs/common';
import type { RevocationChecker, RevocationFallback } from '@plantops/auth-kit';
import { REVOCATION_CHECKER, REVOCATION_FALLBACK } from '@plantops/auth-kit';
import type { IntrospectResponse, JwtClaims } from '@plantops/contracts';
import { TokenService } from '../auth/token.service';

/** The one answer every rejection produces. Frozen so no caller can extend it. */
const INACTIVE: IntrospectResponse = Object.freeze({ active: false });

@Injectable()
export class IntrospectService {
  private readonly logger = new Logger(IntrospectService.name);

  constructor(
    private readonly tokens: TokenService,
    @Inject(REVOCATION_CHECKER) private readonly revocations: RevocationChecker,
    @Inject(REVOCATION_FALLBACK) private readonly fallback: RevocationFallback,
  ) {}

  /**
   * Verifies `token` and reports it (Doc 06 §11).
   *
   * The three steps are in `AuthGuard`'s order, and the order is the design:
   * nothing derived from the payload is acted on before the signature check, so
   * the `sid` sent to the revocation store is one this process has already
   * proven it issued. Looking up an unverified, attacker-chosen `sid` would leak
   * whether a guessed session exists through response timing.
   */
  async introspect(token: string): Promise<IntrospectResponse> {
    let claims: JwtClaims;
    try {
      claims = this.tokens.verifyAccessToken(token);
    } catch (error) {
      this.logger.debug(`Introspected token rejected: ${messageOf(error)}`);
      return INACTIVE;
    }

    if (await this.isRevoked(claims)) return INACTIVE;

    // Exactly the five fields Doc 06 §11 names. Not the whole claim set: `iat`
    // and `exp` are in the token the caller already has, and echoing them would
    // invite a consumer to trust this response's expiry over the signed one.
    return {
      active: true,
      sub: claims.sub,
      sty: claims.sty,
      cid: claims.cid,
      sid: claims.sid,
    };
  }

  /**
   * Cache first, database second, inactive when neither can answer.
   *
   * The same fallback chain `AuthGuard.isRevoked` runs, and it is written out
   * again rather than shared because the guard's copy answers a different
   * question with it — whether to admit *this* request — and folding the two
   * together would put an HTTP concern inside `auth-kit`, which every consuming
   * module imports.
   */
  private async isRevoked(claims: JwtClaims): Promise<boolean> {
    try {
      return await this.revocations.isRevoked(claims.sid);
    } catch (cacheError) {
      this.logger.warn(
        `Revocation cache unavailable during introspection ` +
          `(${messageOf(cacheError)}); falling back to the database`,
      );

      try {
        return await this.fallback.isRevoked(claims);
      } catch (databaseError) {
        this.logger.error(
          `Revocation fallback also failed (${messageOf(databaseError)}); ` +
            'reporting the token inactive',
        );
        return true;
      }
    }
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
