/**
 * Shared constants every project agrees on. Values that IAM and consuming
 * modules must not disagree about live here (Doc 08 §3), never duplicated in a
 * service.
 *
 * These are *defaults and invariants*, not deployment configuration: anything an
 * operator may retune per environment is validated in `@plantops/config`, which
 * uses these values as its defaults.
 */

/** `iss` claim on every token the IAM signs (Doc 03 §2). */
export const IAM_ISSUER = 'plantops-iam';

/** Base path for the IAM surface (Doc 06 §1). */
export const IAM_ROUTE_PREFIX = '/iam';

/** Base path for the authentication surface (Doc 06 §1). */
export const AUTH_ROUTE_PREFIX = '/auth';

/**
 * Leeway applied to `exp`/`iat`/`nbf` checks in the IAM *and* in every consuming
 * module, absorbing clock drift between signer and verifiers (Doc 03 §6).
 * Shared so verifiers cannot drift apart.
 */
export const CLOCK_SKEW_LEEWAY_SECONDS = 60;

/**
 * The one signature algorithm the IAM issues and accepts (Doc 03 §1).
 *
 * Pinned as a constant because verification must never take the algorithm from
 * the token being verified. A verifier that honours the incoming `alg` header
 * accepts `alg: "none"`, and accepts an HS256 token forged with the *public*
 * key as the HMAC secret — the two classic JWT breaks, both of which look like
 * ordinary success. Comparing the header against this value and rejecting
 * anything else closes them.
 */
export const JWT_SIGNING_ALGORITHM = 'RS256';

/** Smallest RSA modulus the IAM will sign or verify with. */
export const JWT_MIN_RSA_KEY_BITS = 2048;

/**
 * `max-age` on the JWKS response (Doc 03 §1 step 2).
 *
 * Rotation says to wait for JWKS propagation — "allow at least one cache TTL" —
 * before switching signers. That step is only actionable if the TTL is a known
 * number, so the endpoint publishes this one and the rotation tool reads the
 * same constant when it computes the earliest safe activation time. Changing it
 * changes both ends together.
 */
export const JWKS_CACHE_MAX_AGE_SECONDS = 300;

/** Human access-token lifetime — 15 min (Doc 03 §1). */
export const ACCESS_TOKEN_TTL_SECONDS = 900;

/** Refresh-token lifetime — 7 days, inside the 7–30 day band (Doc 03 §1). */
export const REFRESH_TOKEN_TTL_SECONDS = 604_800;

/**
 * Service-account access-token lifetime — 5 min. Doc 03 §5 caps these at ≤5 min
 * because an ephemeral `sid` cannot be revoked mid-token; the TTL *is* the
 * revocation window.
 */
export const SERVICE_ACCESS_TOKEN_TTL_SECONDS = 300;
export const SERVICE_ACCESS_TOKEN_MAX_TTL_SECONDS = 300;

/**
 * Window during which the immediately-previous refresh token replays
 * idempotently instead of being treated as compromise, so two legitimate
 * clients refreshing at once do not kill a live session (Doc 03 §4: 10–30 s).
 */
export const REFRESH_REUSE_GRACE_SECONDS = 15;
export const REFRESH_REUSE_GRACE_MIN_SECONDS = 10;
export const REFRESH_REUSE_GRACE_MAX_SECONDS = 30;

/**
 * Grants-cache TTL — the safety net behind invalidation, and the staleness bound
 * on `role_binding.expires_at` (Doc 01 §4.5, Doc 04 §6: ≤10 min).
 */
export const GRANTS_CACHE_TTL_SECONDS = 600;
export const GRANTS_CACHE_MAX_TTL_SECONDS = 600;

/**
 * ltree labels are `n_` + the node's UUID hex — id-derived, never name-derived,
 * so a rename never rewrites a path (Doc 01 §3.5).
 */
export const SCOPE_PATH_LABEL_PREFIX = 'n_';

/** Permission namespaces for the two administrative tiers (Doc 02 §1). */
export const PLATFORM_PERMISSION_NAMESPACE = 'iam.platform';
export const CLIENT_PERMISSION_NAMESPACE = 'iam.client';

/** Redis pub/sub channel carrying grant-invalidation events (Doc 04 §7). */
export const PERMS_INVALIDATED_CHANNEL = 'perms.invalidated';

/**
 * Key namespace for the revoked-`sid` cache (Doc 03 §6).
 *
 * Shared rather than private to the IAM because the IAM *writes* these keys and
 * every consuming module *reads* them: a module that guesses a different prefix
 * finds no revocations and honours force-logout never. One entry per revoked
 * session, expiring on its own — see {@link revokedSessionKey}.
 */
export const REVOKED_SESSION_KEY_PREFIX = 'revoked-sid:';

/** The revoked-`sid` cache key for a session id. */
export function revokedSessionKey(sessionId: string): string {
  return `${REVOKED_SESSION_KEY_PREFIX}${sessionId}`;
}
