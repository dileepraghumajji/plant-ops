/**
 * Where a request's verified JWT claims live between the guard and the
 * transaction wrapper (Doc 07 §5 PROVENANCE).
 *
 * {@link setVerifiedClaims} takes a `VerifiedClaims` — the branded type from
 * `@plantops/db`, obtainable only through `markClaimsVerified`, which the
 * AuthGuard calls after signature, expiry and revocation checks pass. So the
 * claims that reach the RLS context cannot have come from a body, a header or
 * a query parameter: there is no way to construct the argument from one.
 *
 * The store is a module-private symbol rather than a named property. That is
 * not paranoia about collisions — it means no middleware, no library, and no
 * `Object.assign(req, req.body)` anywhere in the stack can plant claims on a
 * request, because nothing else can name the key.
 *
 * The setter is called from exactly one place: `RequestClaimsSink`, the adapter
 * `AuthGuard` hands verified claims to. A `@Public()` route still reaches the
 * transaction wrapper with nothing here, so it runs with no RLS context and
 * every tenant policy matches nothing — open, unauthenticated, *and* empty.
 */

import type { VerifiedClaims } from '@plantops/db';

const VERIFIED_CLAIMS = Symbol('verifiedClaims');

interface RequestWithClaims {
  [VERIFIED_CLAIMS]?: VerifiedClaims;
}

/** Call from the AuthGuard, and from nowhere else. */
export function setVerifiedClaims(request: unknown, claims: VerifiedClaims): void {
  (request as RequestWithClaims)[VERIFIED_CLAIMS] = claims;
}

/** The verified claims for this request, or `undefined` if unauthenticated. */
export function verifiedClaimsOf(request: unknown): VerifiedClaims | undefined {
  return (request as RequestWithClaims | null)?.[VERIFIED_CLAIMS];
}
