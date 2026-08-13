/**
 * The closed claim set, and the checks every verifier must apply identically
 * (Doc 03 §2, §6).
 *
 * ## Why this is not in the IAM
 *
 * The IAM signs; `admin-web`, `iam-client` and every future operational module
 * verify — locally, from the published JWKS, without calling the IAM (Doc 06
 * §11). "Verify the same way" is therefore a property of *separate processes*,
 * and the only way to hold it is for all of them to run this code. A module
 * that reimplements the expiry check with a different leeway rejects tokens the
 * IAM considers live for a whole minute at every token edge; one that skips the
 * issuer check accepts another deployment's tokens outright.
 *
 * ## The claim set is closed, in both directions
 *
 * Doc 03 §2 lists exactly seven claims: `iss, sub, sty, cid, sid, iat, exp`.
 * Not "at least" — permissions, roles and scope nodes are *deliberately* absent
 * so that a grant change takes effect on cache invalidation (Doc 04 §7) rather
 * than on token expiry. So {@link assertExactClaims} refuses to sign an eighth,
 * and {@link readAccessTokenClaims} refuses to accept one: a token this IAM
 * issued cannot carry extras, so their presence means the payload came from
 * somewhere else, and silently reading the seven we recognise is how a second
 * issuer goes unnoticed.
 */

import {
  CLOCK_SKEW_LEEWAY_SECONDS,
  JWT_CLAIM_KEYS,
  SubjectType,
  type JwtClaims,
} from '@plantops/contracts';

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
  /** `iss` is not the expected issuer. */
  WRONG_ISSUER: 'wrong_issuer',
  /** Claim set is not the Doc 03 §2 shape. */
  BAD_CLAIMS: 'bad_claims',
  /** The session behind `sid` has been revoked (Doc 03 §6). */
  REVOKED: 'revoked',
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

/**
 * Guards the closed claim set at signing time (Doc 03 §2).
 *
 * Typed input alone does not cover this: a structurally-typed object may carry
 * extra properties at runtime, and `JSON.stringify` would faithfully sign them.
 */
export function assertExactClaims(claims: JwtClaims): Record<string, unknown> {
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

/**
 * Validates a **signature-verified** payload against the Doc 03 §2 shape.
 *
 * Call this only after the signature checks out. A token signed by a legitimate
 * key is still attacker-influenced if any upstream path ever let a caller
 * choose a claim value, which is why every field is re-validated on the way in
 * and not merely on the way out.
 *
 * @throws {TokenVerificationError}
 */
export function readAccessTokenClaims(payload: Record<string, unknown>): JwtClaims {
  const missing = JWT_CLAIM_KEYS.filter((key) => payload[key] === undefined);
  if (missing.length > 0) {
    throw new TokenVerificationError(
      TokenRejection.BAD_CLAIMS,
      `Token is missing required claims: ${missing.join(', ')}`,
    );
  }
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

/**
 * Checks issuer and the time window, with the shared 60 s leeway.
 *
 * The leeway is {@link CLOCK_SKEW_LEEWAY_SECONDS}, not a local number: the IAM
 * and every consuming module must agree, or a token is live in one process and
 * expired in the next at the edges (Doc 03 §6). Note that the issuer is a claim
 * like any other and is worthless until the document is known to be genuine —
 * so this runs after signature verification, never before it.
 *
 * @throws {TokenVerificationError}
 */
export function assertClaimsAcceptable(
  claims: JwtClaims,
  expectedIssuer: string,
  now: Date = new Date(),
): void {
  if (claims.iss !== expectedIssuer) {
    throw new TokenVerificationError(
      TokenRejection.WRONG_ISSUER,
      'Token was issued by a different issuer',
    );
  }

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
}
