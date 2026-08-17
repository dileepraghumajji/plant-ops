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
 * On top of the identity `AuthGuard` establishes, Session 23 added the
 * authorization half:
 *
 * - {@link PermissionGuard} as a second global guard, with
 *   {@link RequirePermission} on every gated route and
 *   {@link NoPermissionRequired} on the few that answer questions about the
 *   bearer themselves;
 * - a {@link GrantsSource} — the IAM binds its own resolution engine, a module
 *   binds a cached `/iam/permissions/resolve` call;
 * - a {@link VerifiedClaimsSource}, the read side of the sink above;
 * - optionally a {@link DenialAuditor}.
 *
 * {@link ScopeResolver} is injectable for a module's own services too: Doc 04
 * §5's `allowedPaths` is what turns authorization into a `WHERE … <@ ANY(...)`
 * predicate on a list query.
 */

export * from './auth.guard';
export * from './claims';
export * from './jwks-verifier';
export * from './jws';
export * from './permission.guard';
export * from './require-permission.decorator';
export * from './revocation-cache';
export * from './scope-resolver';
