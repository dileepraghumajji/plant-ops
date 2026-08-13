/**
 * `@plantops/auth-kit` — the verification half of PlantOps auth (Doc 08 §2).
 *
 * The IAM issues tokens; this library is how **everything else** — the IAM's
 * own endpoints included — decides whether to trust one. It depends on
 * `@plantops/contracts` and nothing else in the workspace, so a future
 * operational module can authenticate requests without importing the IAM's
 * database layer, or the IAM at all.
 *
 * What a consumer wires up (Session 8 wires exactly this inside `iam-api`):
 *
 * - a {@link TokenVerifier} — {@link JwksVerifier} for anyone but the signer;
 * - a {@link RevocationChecker} — {@link RevocationCache} over its Redis client;
 * - a {@link VerifiedClaimsSink} — the one adapter that turns verified claims
 *   into whatever that process's request context is;
 * - {@link AuthGuard} as a global guard, with {@link Public} on the routes that
 *   cannot carry a token.
 *
 * Session 23 adds `PermissionGuard` and `ScopeResolver` here, on top of the
 * same identity this guard establishes.
 */

export * from './auth.guard';
export * from './claims';
export * from './jwks-verifier';
export * from './jws';
export * from './revocation-cache';
