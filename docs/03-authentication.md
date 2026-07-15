# 03 — Authentication

> Defines how subjects prove identity and obtain tokens: login, the custom JWT shape, refresh, sessions, service accounts, and revocation. We build our own auth — Supabase Auth is **not** used.

---

## 1. Token strategy — custom JWT (chosen)

We issue our own signed JWTs. This gives full control over claims (client, session, subject type) and avoids coupling to any external auth provider. Two tokens:

- **Access token (JWT)** — short-lived (recommend 15 min). Stateless-ish: verified by signature, but every access is still gated by the session's revocation state via cache (see §6).
- **Refresh token** — long-lived (recommend 7–30 days), opaque, stored hashed in `session.refresh_token_hash`, rotated on use.

Signing: asymmetric **RS256/ES256** with a rotating key set (JWKS). The IAM holds the private key; consuming modules verify with the public key — they never call IAM just to check a signature. Each token carries a `kid` header identifying the signing key.

**Key rotation ordering (mandatory).** Rotation must never invalidate in-flight tokens:
1. Generate the new keypair and **publish its public key in JWKS first**, alongside the current one.
2. Wait for JWKS propagation (consumers cache JWKS; allow at least one cache TTL).
3. Only then switch signing to the new private key.
4. Retain the old public key in JWKS for **at least the maximum access-token lifetime** (15 min) after the last token was signed with it, then remove.

Consumers select the verification key by the token's `kid`; an unknown `kid` triggers a JWKS refetch before rejecting.

## 2. Access token claims

Keep the JWT **small** — it carries identity, not the full permission set (permissions are resolved separately, Doc 04, to stay fresh and cacheable).

```json
{
  "iss": "plantops-iam",
  "sub": "<user_id | service_account_id>",
  "sty": "user | service",          // subject type
  "cid": "<client_id>",             // tenant
  "sid": "<session_id>",            // for revocation
  "iat": 1710000000,
  "exp": 1710000900
}
```

Explicitly **not** in the token: permissions, roles, scope nodes. Those are resolved from `/permissions/resolve` and cached (Doc 04). This keeps tokens small and lets a permission change take effect on cache-invalidation rather than on token expiry.

## 3. Login flow (password, v1)

```
POST /auth/login  { email, password, client_slug }
  1. Resolve client by slug → client_id
  2. Find user by (client_id, email); must be status=active
  3. Verify password against user_identity.secret_hash (argon2id)
  4. Create session row (device_label optional)
  5. Issue access JWT (sid=session.id) + refresh token
  6. Audit: auth.login.success  (or auth.login.failed on failure)
  → { access_token, refresh_token, expires_in }
```

Failure rules:
- Unknown user / bad password → generic `401` (no user-enumeration hints).
- `status=locked` → `423 Locked` (the "Account Locked Users" concept). Locking is manual or policy-driven (repeated failures).
- Always audit failures with reason code.

## 4. Refresh flow

```
POST /auth/refresh  { refresh_token }
  1. Hash + look up session by refresh_token_hash
  2. Reject if revoked_at set or expired
  3. Rotate: issue new refresh token, update hash, keep same session.id
  4. Issue new access JWT
  → { access_token, refresh_token, expires_in }
```

Refresh-token **rotation** with reuse detection: if an already-used (old) refresh token is presented, treat as compromise → revoke the session and audit `auth.refresh.reuse_detected`.

**Concurrent-refresh race (must handle).** Two legitimate clients on the same session (e.g. mobile + desktop, or two browser tabs) can each present the *current* refresh token within milliseconds of each other; naive reuse detection would flag the second as compromise and revoke a live session. Mitigation: on rotation, retain the immediately-previous token hash with a short **reuse grace window** (recommend 10–30 s). A presented old token *within* the grace window returns the already-rotated successor (idempotent replay) rather than triggering compromise; presentation of a token older than one generation, or an old token *after* the grace window, is real reuse → revoke + audit. Store the grace on the `session` row (previous hash + rotation timestamp).

## 5. Service-account authentication

Machine identities authenticate with a client-credentials style exchange:

```
POST /auth/token  { account_key, account_secret }   // or HTTP Basic
  1. Look up service_account by key; verify secret against key_hash
  2. status must be active
  3. Issue access JWT (sty=service, sid=ephemeral session)
  → { access_token, expires_in }        // no refresh; re-request as needed
```

Service accounts are used for module-to-module calls (e.g. Gatepass calling IAM to resolve a user's scope). They are bound to roles just like users (Doc 01 §4.5) and are subject to the same WHO×WHAT×WHERE resolution.

**Revocation model (deliberate decision).** Service-account access tokens carry an **ephemeral `sid` not backed by a persistent `session` row**, so they cannot be revoked *mid-token* the way a user session can. This is an accepted trade for machine identities: revocation is instead enforced by (a) short access-token TTL (recommend ≤5 min for service tokens, tighter than the human 15 min) and (b) setting `service_account.status = revoked`, which fails the *next* `/auth/token` exchange immediately. The bounded exposure window equals the token TTL. If a specific integration needs instant mid-token kill, issue it a session-backed token instead — but the default is ephemeral. Revoking a service account also invalidates its cached grants (Doc 04 §7).

## 6. Sessions & revocation

Every login creates a `session` row keyed by the `sid` claim. Revocation is essential for **shared gate-terminal devices** (log the terminal out at shift end).

- **Revoke one session:** `POST /auth/sessions/:id/revoke` → set `revoked_at`.
- **Revoke all sessions for a user:** force-logout everywhere (e.g. on lock/disable).
- **Enforcement:** maintain a Redis set / short-TTL cache of revoked `sid`s. Consuming modules and the IAM check `sid` against this on each request (cheap). Because access tokens are short-lived, the revocation window is bounded even without a per-request DB hit.

Recommended: a lightweight `AuthGuard` verifies signature + `exp`, then checks `sid` is not revoked (cache), then proceeds. This keeps most requests DB-free while honoring force-logout within seconds.

**Clock skew.** `exp`/`iat`/`nbf` checks (in the IAM and in every consuming module) MUST allow a fixed leeway of **60 seconds** to absorb clock drift between the signer and verifiers. Without it, minor NTP drift produces spurious `401`s at the token edges. The leeway is a shared constant in `libs/config` so IAM and modules agree.

## 7. Password & credential rules

- Hash with **argon2id** (never bcrypt-as-afterthought; never plaintext).
- Enforce minimum policy at the API (length, breach-list optional).
- Password reset is a tokenized, time-boxed flow (audit `auth.password.reset_requested/completed`).
- Service-account secrets are shown **once** at creation, stored only as hash.

## 8. Account states

| State | Login | Notes |
|---|---|---|
| active | allowed | normal |
| locked | denied (423) | manual or auto (failed attempts); the "Account Locked Users" list |
| disabled | denied (403) | offboarded; sessions revoked |

## 9. What is audited (auth events)

`auth.login.success`, `auth.login.failed`, `auth.logout`, `auth.refresh.rotated`, `auth.refresh.reuse_detected`, `auth.session.revoked`, `auth.password.reset_requested`, `auth.password.reset_completed`, `auth.account.locked`, `auth.account.unlocked`. See Doc 10.

## 10. Explicitly out of scope for v1 (design for later)

- OIDC/SSO federation (schema already supports via `user_identity.provider` + `provider_subject`).
- WhatsApp OTP login (phone column reserved).
- MFA/TOTP (add as an additional `user_identity` factor).
