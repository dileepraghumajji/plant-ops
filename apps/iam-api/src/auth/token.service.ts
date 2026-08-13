/**
 * Access-token issuance and verification (Doc 03 §1–2, §5–6).
 *
 * ## What is here, and what moved
 *
 * The claim *rules* — the closed seven-claim set, the issuer check, the 60 s
 * skew leeway — live in `@plantops/auth-kit`, because the IAM is not their only
 * enforcer: every consuming module verifies the same tokens locally from the
 * published JWKS (Doc 06 §11), and two implementations of "the same" checks is
 * how a signer and a verifier drift apart. What stays here is what only the
 * signer can do: hold the private key, choose the TTL, and stamp the times.
 *
 * ## The claim set is closed
 *
 * Doc 03 §2 lists exactly seven claims. Not "at least" — permissions, roles and
 * scope nodes are *deliberately* absent so that a grant change takes effect on
 * cache invalidation (Doc 04 §7) rather than on token expiry. A token that
 * carried them would be a 15-minute window in which a revoked permission still
 * works, and nothing would report it. `assertExactClaims` fails at the point an
 * extra claim is introduced, rather than letting it survive to production as a
 * quietly larger token.
 *
 * ## Revocation is not checked here
 *
 * `sid` is verified as present and well-formed, but whether that session is
 * still live is the `AuthGuard`'s job against the Redis revocation set (Doc 03
 * §6). Keeping the two apart is what lets consuming modules verify a signature
 * locally without calling the IAM.
 */

import { Inject, Injectable } from '@nestjs/common';
import {
  TokenRejection,
  TokenVerificationError,
  assertClaimsAcceptable,
  assertExactClaims,
  JwsFormatError,
  parseCompactJws,
  readAccessTokenClaims,
  signCompactJws,
  verifyCompactJws,
  type TokenVerifier,
} from '@plantops/auth-kit';
import type { EnvConfig } from '@plantops/config';
import {
  JWT_SIGNING_ALGORITHM,
  SubjectType,
  type JwtClaims,
} from '@plantops/contracts';
import { ENV } from '../config/config.module';
import { KeysService } from './keys.service';

/**
 * Re-exported so the IAM's own code and specs have one import for the token
 * vocabulary. The definitions are `auth-kit`'s — see the note above.
 */
export { TokenRejection, TokenVerificationError };

/** Everything the caller supplies; `iss`, `iat` and `exp` are not theirs to set. */
export interface IssueAccessTokenInput {
  /** `user.id` or `service_account.id`. */
  subjectId: string;
  subjectType: SubjectType;
  /** The tenant — `client.id`. */
  clientId: string;
  /** `session.id`, or the ephemeral id of a service token (Doc 03 §5). */
  sessionId: string;
}

export interface IssuedAccessToken {
  accessToken: string;
  /** Lifetime in seconds — the `expires_in` of the Doc 06 §3 response. */
  expiresIn: number;
  claims: JwtClaims;
}

@Injectable()
export class TokenService implements TokenVerifier {
  constructor(
    @Inject(ENV) private readonly env: EnvConfig,
    private readonly keys: KeysService,
  ) {}

  /**
   * The access-token lifetime for a subject type.
   *
   * Service tokens are shorter by design and the schema caps them at 5 min:
   * their `sid` is ephemeral and not backed by a `session` row, so they cannot
   * be revoked mid-token. The TTL *is* the revocation window (Doc 03 §5).
   */
  ttlSecondsFor(subjectType: SubjectType): number {
    return subjectType === SubjectType.SERVICE
      ? this.env.SERVICE_TOKEN_TTL_SECONDS
      : this.env.ACCESS_TOKEN_TTL_SECONDS;
  }

  /** Signs an access token with the current key (Doc 03 §2). */
  issueAccessToken(
    input: IssueAccessTokenInput,
    now: Date = new Date(),
  ): IssuedAccessToken {
    const expiresIn = this.ttlSecondsFor(input.subjectType);
    const issuedAt = Math.floor(now.getTime() / 1000);

    const claims: JwtClaims = {
      iss: this.env.JWT_ISSUER,
      sub: input.subjectId,
      sty: input.subjectType,
      cid: input.clientId,
      sid: input.sessionId,
      iat: issuedAt,
      exp: issuedAt + expiresIn,
    };

    const { kid, privateKey } = this.keys.signingKey();
    return {
      accessToken: signCompactJws(assertExactClaims(claims), privateKey, kid),
      expiresIn,
      claims,
    };
  }

  /**
   * Verifies a token and returns its claims. This is the {@link TokenVerifier}
   * the `AuthGuard` runs inside the IAM — local keys, no JWKS round-trip,
   * because this process *is* the publisher.
   *
   * Order is deliberate: structure, then algorithm, then key, then signature,
   * and only then the claims. Nothing derived from the payload is acted on
   * before the signature check — including the issuer, which is a claim like
   * any other and is worthless until the document is known to be ours.
   *
   * @throws {TokenVerificationError}
   */
  verifyAccessToken(token: string, now: Date = new Date()): JwtClaims {
    const parsed = parse(token);

    const key = this.keys.verificationKey(parsed.header.kid);
    if (key === undefined) {
      // Doc 03 §1: a consumer refetches the JWKS before rejecting, because a
      // rotation may have published this key moments ago. The IAM *is* the
      // publisher — its map is already current — so there is nothing to refetch
      // and the rejection stands.
      throw new TokenVerificationError(
        TokenRejection.UNKNOWN_KEY,
        'Token was signed with a key that is not published',
      );
    }

    let signatureValid: boolean;
    try {
      signatureValid = verifyCompactJws(parsed, key);
    } catch (error) {
      throw new TokenVerificationError(
        TokenRejection.UNSUPPORTED_ALGORITHM,
        error instanceof Error ? error.message : 'Unsupported token algorithm',
      );
    }
    if (!signatureValid) {
      throw new TokenVerificationError(
        TokenRejection.BAD_SIGNATURE,
        'Token signature does not verify',
      );
    }

    const claims = readAccessTokenClaims(parsed.payload);
    assertClaimsAcceptable(claims, this.env.JWT_ISSUER, now);
    return claims;
  }

  /** {@link TokenVerifier} — the guard depends on the interface, not on this class. */
  verify(token: string, now?: Date): JwtClaims {
    return this.verifyAccessToken(token, now);
  }
}

function parse(token: string) {
  try {
    return parseCompactJws(token);
  } catch (error) {
    if (error instanceof JwsFormatError) {
      throw new TokenVerificationError(TokenRejection.MALFORMED, error.message);
    }
    throw error;
  }
}

export { JWT_SIGNING_ALGORITHM };
