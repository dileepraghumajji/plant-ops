/**
 * Access-token issuance and verification (Doc 03 §1–2, §5–6).
 *
 * ## The claim set is closed
 *
 * Doc 03 §2 lists exactly seven claims: `iss, sub, sty, cid, sid, iat, exp`.
 * Not "at least" — permissions, roles and scope nodes are *deliberately* absent
 * so that a grant change takes effect on cache invalidation (Doc 04 §7) rather
 * than on token expiry. A token that carried them would be a 15-minute window
 * in which a revoked permission still works, and nothing would report it.
 *
 * So the payload is built field by field from a typed input and then checked
 * against `JWT_CLAIM_KEYS` before signing. An extra claim is a spec violation
 * that fails here, at the point it is introduced, instead of surviving to
 * production as a quietly larger token.
 *
 * ## Verification is not the inverse of signing
 *
 * {@link TokenService.verifyAccessToken} does not trust anything it decodes
 * before checking the signature, and re-checks the claim shape afterwards: a
 * token signed by a *legitimate* key is still attacker-influenced if any
 * upstream path ever let a caller choose a claim value. Every field is
 * re-validated on the way in, not just on the way out.
 *
 * Revocation is **not** checked here. `sid` is verified as present and
 * well-formed, but whether that session is still live is the AuthGuard's job
 * against the Redis revocation set (Doc 03 §6, Session 8). Keeping the two
 * apart is what lets consuming modules verify a signature locally without
 * calling the IAM.
 */

import { Inject, Injectable } from '@nestjs/common';
import type { EnvConfig } from '@plantops/config';
import {
  CLOCK_SKEW_LEEWAY_SECONDS,
  JWT_CLAIM_KEYS,
  JWT_SIGNING_ALGORITHM,
  SubjectType,
  type JwtClaims,
} from '@plantops/contracts';
import { ENV } from '../config/config.module';
import { KeysService } from './keys.service';
import {
  JwsFormatError,
  parseCompactJws,
  signCompactJws,
  verifyCompactJws,
} from './jws';

/** Why a token was refused. Never returned to a caller — see the note below. */
export const TokenRejection = {
  /** Not a compact JWS, or its segments do not decode. */
  MALFORMED: 'malformed',
  /** Header `alg` is not RS256 (Doc 03 §1). */
  UNSUPPORTED_ALGORITHM: 'unsupported_algorithm',
  /** `kid` is not in the published set — refetch JWKS, then reject. */
  UNKNOWN_KEY: 'unknown_key',
  /** Signature does not verify under the selected key. */
  BAD_SIGNATURE: 'bad_signature',
  /** `exp` has passed, allowing the 60 s leeway. */
  EXPIRED: 'expired',
  /** `iat` is in the future beyond the leeway — a clock or a forgery. */
  NOT_YET_VALID: 'not_yet_valid',
  /** `iss` is not this IAM. */
  WRONG_ISSUER: 'wrong_issuer',
  /** Claim set is not the Doc 03 §2 shape. */
  BAD_CLAIMS: 'bad_claims',
} as const;
export type TokenRejection = (typeof TokenRejection)[keyof typeof TokenRejection];

/**
 * A refused token, with the reason kept **server-side**.
 *
 * The distinction matters at the HTTP boundary: an `unknown_key` and an
 * `expired` must look identical to the caller (both are a bare 401
 * `AUTH_REQUIRED`), because the difference tells an attacker whether a forged
 * `kid` was a near miss. The reason is here for logs, metrics and the
 * refetch-then-reject decision — not for the response body.
 */
export class TokenVerificationError extends Error {
  constructor(
    readonly reason: TokenRejection,
    message: string,
  ) {
    super(message);
    this.name = 'TokenVerificationError';
  }
}

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
export class TokenService {
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
   * Verifies a token and returns its claims.
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

    const claims = readClaims(parsed.payload);

    if (claims.iss !== this.env.JWT_ISSUER) {
      throw new TokenVerificationError(
        TokenRejection.WRONG_ISSUER,
        'Token was issued by a different issuer',
      );
    }

    // The 60 s leeway is the shared constant, not a local number: the IAM and
    // every consuming module must agree, or a token is live in one and expired
    // in the other at the edges (Doc 03 §6).
    const seconds = Math.floor(now.getTime() / 1000);
    if (claims.exp + CLOCK_SKEW_LEEWAY_SECONDS <= seconds) {
      throw new TokenVerificationError(TokenRejection.EXPIRED, 'Token has expired');
    }
    if (claims.iat - CLOCK_SKEW_LEEWAY_SECONDS > seconds) {
      throw new TokenVerificationError(
        TokenRejection.NOT_YET_VALID,
        'Token was issued in the future',
      );
    }

    return claims;
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

/**
 * Guards the closed claim set at signing time (Doc 03 §2).
 *
 * Typed input alone does not cover this: a structurally-typed object may carry
 * extra properties at runtime, and `JSON.stringify` would faithfully sign them.
 */
function assertExactClaims(claims: JwtClaims): Record<string, unknown> {
  const allowed = new Set<string>(JWT_CLAIM_KEYS);
  const extra = Object.keys(claims).filter((key) => !allowed.has(key));
  if (extra.length > 0) {
    throw new Error(
      `Access token would carry claims outside Doc 03 §2: ${extra.join(', ')}. ` +
        'Permissions, roles and scopes are resolved separately and must not be ' +
        'embedded in a token.',
    );
  }
  return { ...claims };
}

/** Validates a verified payload against the Doc 03 §2 shape. */
function readClaims(payload: Record<string, unknown>): JwtClaims {
  const missing = JWT_CLAIM_KEYS.filter((key) => payload[key] === undefined);
  if (missing.length > 0) {
    throw new TokenVerificationError(
      TokenRejection.BAD_CLAIMS,
      `Token is missing required claims: ${missing.join(', ')}`,
    );
  }
  // Extra claims are rejected too, not ignored. A token this IAM signed cannot
  // have them, so their presence means the payload came from somewhere else —
  // and silently accepting the seven we recognise is how a stale key or a
  // second issuer goes unnoticed.
  const allowed = new Set<string>(JWT_CLAIM_KEYS);
  const extra = Object.keys(payload).filter((key) => !allowed.has(key));
  if (extra.length > 0) {
    throw new TokenVerificationError(
      TokenRejection.BAD_CLAIMS,
      `Token carries claims outside Doc 03 §2: ${extra.join(', ')}`,
    );
  }

  for (const key of ['iss', 'sub', 'cid', 'sid'] as const) {
    if (typeof payload[key] !== 'string' || payload[key] === '') {
      throw new TokenVerificationError(
        TokenRejection.BAD_CLAIMS,
        `Token claim "${key}" is not a non-empty string`,
      );
    }
  }
  for (const key of ['iat', 'exp'] as const) {
    if (typeof payload[key] !== 'number' || !Number.isInteger(payload[key])) {
      throw new TokenVerificationError(
        TokenRejection.BAD_CLAIMS,
        `Token claim "${key}" is not an integer`,
      );
    }
  }
  if (payload['sty'] !== SubjectType.USER && payload['sty'] !== SubjectType.SERVICE) {
    throw new TokenVerificationError(
      TokenRejection.BAD_CLAIMS,
      'Token claim "sty" is not a known subject type',
    );
  }

  return {
    iss: payload['iss'] as string,
    sub: payload['sub'] as string,
    sty: payload['sty'],
    cid: payload['cid'] as string,
    sid: payload['sid'] as string,
    iat: payload['iat'] as number,
    exp: payload['exp'] as number,
  };
}

export { JWT_SIGNING_ALGORITHM };
