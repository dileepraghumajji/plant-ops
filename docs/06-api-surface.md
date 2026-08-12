# 06 — API Surface

> The complete IAM HTTP surface: auth, platform-admin registry, client-admin management, and the resolution endpoints modules consume. Contracts are at DTO level; agents implement validation, pagination, and error handling per the conventions here.

---

## 1. Conventions

- Base path: `/iam` (auth under `/auth`).
- JSON everywhere; `application/json`.
- Auth: `Authorization: Bearer <access_jwt>` except login/refresh/token.
- Tenant (`cid`) and subject come from the JWT, never from the body, for tenant-owned operations.
- Pagination: `?page=&limit=` → `{ data: [...], page, limit, total }`.
- Idempotent manifest uploads (upsert by natural key).
- Every mutating endpoint writes an audit record (Doc 10).

## 2. Error model

```json
{ "error": { "code": "SCOPE_DENIED", "message": "…", "requestId": "…" } }
```

| HTTP | code (examples) |
|---|---|
| 400 | VALIDATION_FAILED |
| 401 | AUTH_REQUIRED, INVALID_CREDENTIALS |
| 403 | PERMISSION_DENIED, SCOPE_DENIED |
| 404 | NOT_FOUND |
| 409 | CONFLICT (duplicate key, cross-tenant violation) |
| 423 | ACCOUNT_LOCKED |
| 429 | RATE_LIMITED |
| 500 | INTERNAL_ERROR |

Denials (`403`) never reveal whether the target exists across tenants.

`INTERNAL_ERROR` carries a fixed, generic `message` — an unhandled exception's own text may quote a query, a connection string, or a row, none of which belongs in a response. The `requestId` is the correlation handle: it appears in the response, in the logged stack trace, and in any audit record for the request.

`GET /health` and `GET /ready` (§13) are ops endpoints, not part of this surface: they answer with a readiness report and are exempt from the envelope, since a probe consumes status codes rather than error codes.

---

## 3. Auth (`/auth`)

| Method | Path | Body | Returns | Notes |
|---|---|---|---|---|
| POST | /auth/login | { email, password, client_slug } | { access_token, refresh_token, expires_in } | human login |
| POST | /auth/refresh | { refresh_token } | { access_token, refresh_token, expires_in } | rotates |
| POST | /auth/token | { account_key, account_secret } | { access_token, expires_in } | service account |
| POST | /auth/logout | { } (bearer) | 204 | revokes current session |
| POST | /auth/sessions/:id/revoke | — | 204 | force-logout a session |
| GET | /auth/sessions | — | list of subject's sessions | |
| POST | /auth/password/reset-request | { email, client_slug } | 202 | tokenized |
| POST | /auth/password/reset | { token, new_password } | 204 | |

---

## 4. Platform admin — application registry (`iam.platform.*`)

| Method | Path | Purpose |
|---|---|---|
| POST | /iam/applications | create application |
| GET | /iam/applications | list |
| PATCH | /iam/applications/:id | update / activate-deactivate |
| POST | /iam/applications/:id/manifest | **upsert** permissions + nav + menu_permission from a manifest (Doc 02 §2) |
| POST | /iam/applications/:id/permissions | add permission(s) |
| GET | /iam/applications/:id/permissions | list permissions |
| POST | /iam/applications/:id/nav | add nav node(s) |
| GET | /iam/applications/:id/nav | list nav tree |
| POST | /iam/applications/:id/nav-permissions | map permission(s) to nav node(s) |

## 5. Platform admin — clients (`iam.platform.*`)

| Method | Path | Purpose |
|---|---|---|
| POST | /iam/clients | create tenant |
| GET | /iam/clients | list |
| PATCH | /iam/clients/:id | update / suspend |
| POST | /iam/clients/:id/applications | enable application(s) for client |
| PATCH | /iam/clients/:id/applications/:appId | toggle enabled |
| POST | /iam/clients/:id/admins | create initial client-admin user + binding |

---

## 6. Client admin — scope tree (`iam.client.scope.*`)

| Method | Path | Purpose |
|---|---|---|
| POST | /iam/scopes | create scope node (parent_id, kind, name) |
| GET | /iam/scopes | get client's scope tree |
| PATCH | /iam/scopes/:id | rename / move (maintains path; triggers invalidation) |
| DELETE | /iam/scopes/:id | remove (guarded: reject if bindings exist) |

## 7. Client admin — roles & permissions (`iam.client.role.*`)

| Method | Path | Purpose |
|---|---|---|
| POST | /iam/roles | create role |
| GET | /iam/roles | list roles |
| PATCH | /iam/roles/:id | rename |
| DELETE | /iam/roles/:id | delete (guarded / cascades bindings with audit) |
| PUT | /iam/roles/:id/permissions | set role's permissions (from enabled apps only) |
| GET | /iam/roles/:id/permissions | list |

## 8. Client admin — users (`iam.client.user.*`)

| Method | Path | Purpose |
|---|---|---|
| POST | /iam/users | create user |
| GET | /iam/users | list / search / filter by status |
| GET | /iam/users/:id | detail (incl. bindings) |
| PATCH | /iam/users/:id | update, lock, unlock, disable |
| POST | /iam/users/bulk | bulk upload (CSV/JSON) → per-row result report |
| GET | /iam/users/by-role/:roleId | users holding a role ("Users by Role") |

## 9. Client admin — role bindings (`iam.client.binding.*`)

| Method | Path | Purpose |
|---|---|---|
| POST | /iam/role-bindings | bind (user\|service_account) + role + scope_node [+ expires_at] |
| GET | /iam/role-bindings | list / filter by user, role, scope |
| DELETE | /iam/role-bindings/:id | unbind |

## 10. Service accounts (`iam.client.svc.*` / platform)

| Method | Path | Purpose |
|---|---|---|
| POST | /iam/service-accounts | create (secret returned once) |
| GET | /iam/service-accounts | list |
| POST | /iam/service-accounts/:id/rotate | rotate secret |
| PATCH | /iam/service-accounts/:id | revoke / reactivate |

---

## 11. Resolution endpoints (consumed by modules & frontend)

These are the hot-path, cached endpoints. They are the contract every future PlantOps module depends on.

| Method | Path | Returns |
|---|---|---|
| GET | /iam/permissions/resolve | `{ permissions: [key...], scopes: { key: [paths...] } }` for the bearer subject. Returns the subject's complete grant set (not paginated — it is a single cacheable unit). Bound the payload by (a) path minimization at resolve time (Doc 04 §4.1 — only minimal covering paths, not every descendant) and (b) an optional `?applicationId=` filter to return grants for one app when a consumer only needs that slice. A pathological subject with thousands of bindings is a modeling smell (prefer higher-scope bindings); if it occurs, the minimized set stays small because ancestor paths absorb descendants. |
| POST | /iam/permissions/check | body `{ permission, scopeNodeId }` → `{ allowed: bool }` |
| GET | /iam/navigation?applicationId= | pruned nav tree for the subject (Doc 05) |
| POST | /iam/introspect | `{ token }` → `{ active, sub, sty, cid, sid }` (for modules verifying tokens) |
| GET | /iam/.well-known/jwks.json | public keys for local JWT verification |

> Modules should prefer **local JWT verification via JWKS** + a call to `/permissions/resolve` (cached client-side too), reserving `/introspect` for opaque/edge cases. This keeps the IAM off the per-request critical path.

## 12. Audit read (`iam.*.audit.read`)

| Method | Path | Purpose |
|---|---|---|
| GET | /iam/audit | filter by actor, action, target, date range (scoped to client; platform sees all) |

## 13. Health / ops

| Method | Path | Purpose |
|---|---|---|
| GET | /health | liveness |
| GET | /ready | readiness (db, redis) |
