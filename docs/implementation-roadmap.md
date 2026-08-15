# PlantOps IAM — Implementation Roadmap

> Sequenced development sessions for building the PlantOps IAM. **The spec suite (docs 00–10) is the sole authority** — where anything here is ambiguous, the spec wins.
> Each session is sized for one Claude Code conversation and ends in a working, testable milestone.
> Stack (per Doc 00): NestJS · Supabase (as plain Postgres — hand-written RLS, `ltree`) · TypeORM · Next.js · Redis · Nx monorepo. No UI library is mandated; Doc 09 leaves visuals to the frontend-design skill and the project's design language.
> Convention: every backend session includes its own unit/e2e tests and audit records per Doc 10 — "tested" is part of each Definition of Done, not deferred to the end.

---

## Phase 1 — Infrastructure

# Session 1 — Nx workspace scaffold & module boundaries
**Goal:** Initialize the Nx monorepo with both apps and all six libs, with tag-based dependency constraints enforced by lint (Doc 08).
**Expected Output:** `nx graph` shows `iam-api`, `admin-web`, and `contracts/auth-kit/db/iam-client/ui/config`; both apps build and serve a hello-world; a lint violation fires if `admin-web` imports `libs/db`.
**Files to Create:** `nx.json`, `tsconfig.base.json`, `package.json`, `apps/iam-api/**` (NestJS skeleton), `apps/admin-web/**` (Next.js skeleton), `libs/{contracts,auth-kit,db,iam-client,ui,config}/**` (empty libs with `project.json` tags), root ESLint config with `@nx/enforce-module-boundaries` `depConstraints` per Doc 08 §2, `.gitignore`, `docker-compose.yml` (local Postgres + Redis for dev).
**Files to Modify:** —
**Dependencies:** none
**Acceptance Criteria:**
- `nx build iam-api` and `nx build admin-web` succeed.
- Tags exactly as Doc 08 §2 (`app:iam-api` extra tag on iam-api; `scope:*` on libs).
- A temporary test import of `libs/db` from `admin-web` fails `nx lint` (then remove the import, keep a fixture note).
- `docker compose up` provides Postgres (with `ltree` available) and Redis locally.
**Definition of Done:** Fresh clone → `npm i` → `docker compose up` → both apps run; lint boundary rule demonstrably enforced; repo committed with initial CI-less green state.
**Suggested Commit Message:** `chore(workspace): scaffold Nx monorepo with apps, libs, and boundary constraints`

# Session 2 — libs/config + libs/contracts (shared foundation)
**Goal:** Build the two dependency-free foundation libs: validated env schema and the public contract types every project imports (Doc 08 §3, §5).
**Expected Output:** Type-safe env parsing that fails fast on boot; `contracts` exporting `JwtClaims`, `ResolvedGrants`, `NavNodeDTO`, `IamErrorCode`, pagination envelope, manifest DTO, and shared constants (`CLOCK_SKEW_LEEWAY_SECONDS = 60`, token TTLs).
**Files to Create:** `libs/config/src/env.schema.ts`, `libs/config/src/index.ts`, `libs/contracts/src/{jwt.ts,grants.ts,nav.ts,errors.ts,manifest.ts,pagination.ts,constants.ts,index.ts}`, type-level tests in `libs/contracts`.
**Files to Modify:** `apps/iam-api` bootstrap to load/validate env; `.env.example`.
**Dependencies:** Session 1
**Acceptance Criteria:**
- Missing/invalid env var aborts boot with a clear message (DB pooler URL, DB direct URL, Redis URL, JWT key config, bootstrap secret all in schema).
- `contracts` has zero dependencies (boundary lint passes).
- Error codes match Doc 06 §2 exactly.
**Definition of Done:** `nx test contracts config` green; iam-api boots only with a valid `.env`.
**Suggested Commit Message:** `feat(contracts,config): shared contract types, error codes, and validated env schema`

# Session 3 — libs/db: DataSource, extensions, registry/catalog entities
**Goal:** TypeORM DataSource (pooler vs direct URL split), base migrations (extensions, enums), and the registry/catalog entities: `application`, `permission`, `nav_node` (Docs 01 §3.1–3.3, 07 §2–4).
**Expected Output:** Migrations run and revert cleanly against local Postgres; catalog tables exist with all constraints.
**Files to Create:** `libs/db/src/data-source.ts` (prepared statements disabled for PgBouncer transaction mode; direct URL for migrations), `libs/db/src/entities/{application,permission,nav-node}.entity.ts`, `libs/db/src/migrations/0001-extensions-enums.ts` (`ltree`, `pgcrypto`, enums, `iam` schema), `libs/db/src/migrations/0002-registry-tables.ts`, migration npm scripts.
**Files to Modify:** `libs/config` (DB URL entries if missing).
**Dependencies:** Session 2
**Acceptance Criteria:**
- `unique(application_id, key)` on both `permission` and `nav_node` enforced (insert test).
- `nav_node` has `kind` enum, self-FK `parent_id`, `is_public` default `false`, `sort_order`, `is_active`.
- `synchronize: true` nowhere; snake_case, singular table names.
**Definition of Done:** `migration:run` + `migration:revert` both succeed on a clean DB; constraint tests green.
**Suggested Commit Message:** `feat(db): TypeORM data source, extensions, and registry/catalog entities with migrations`

# Session 4 — libs/db: tenant & mapping entities + audit_trail
**Goal:** All remaining tables: `client`, `scope_node` (ltree path + GiST), `user`, `user_identity`, `service_account`, `client_application`, `role`, `role_permission`, `menu_permission`, `role_binding`, `session`, `audit_trail`, with every constraint from Doc 01 §6 / Doc 07 §9.
**Expected Output:** Complete schema; DB-level integrity tests proving the invariants.
**Files to Create:** `libs/db/src/entities/*.entity.ts` (11 entities), `libs/db/src/migrations/0003-tenant-tables.ts`, `0004-mapping-tables.ts`, `0005-audit-trail.ts`, `0006-indexes.ts` (GiST on `scope_node.path`, `role_binding(client_id,user_id)`, `(role_id)`), integrity tests.
**Files to Modify:** `libs/db/src/index.ts` exports.
**Dependencies:** Session 3
**Acceptance Criteria:**
- `role_binding`: XOR check constraint (user_id ⊕ service_account_id) and expression unique index `(coalesce(user_id, service_account_id), role_id, scope_node_id)` — both proven by failing-insert tests.
- `unique(client_id, email)` on user; `unique(client_id, name)` on role.
- `scope_node.path` is real `ltree` type; FK `on delete restrict` for scope_node with bindings.
- `audit_trail` has no updated_at — insert-only shape.
**Definition of Done:** Full migration chain runs/reverts on clean DB; every invariant in Doc 01 §6 has a passing test.
**Suggested Commit Message:** `feat(db): tenant, mapping, and audit_trail entities with integrity constraints`

# Session 5 — RLS policies, request context, write_audit, bootstrap seed
**Goal:** Hand-written RLS for every table, the JWT-sourced transaction-local context helper, the non-forgeable `write_audit` SECURITY DEFINER function, the non-BYPASSRLS startup assertion, and the platform-admin bootstrap seed (Doc 07 §5–8, Doc 00 §5.0).
**Expected Output:** Cross-tenant reads return zero rows at the DB layer even from deliberately buggy queries; audit is append-only and unspoofable.
**Files to Create:** `libs/db/src/migrations/0007-rls-tenant.ts`, `0008-rls-catalog.ts`, `0009-rls-join-tables.ts` (role_permission via parent role; menu_permission as catalog), `0010-audit-write-fn.ts` (`iam.write_audit` + grants/revokes incl. TRUNCATE), `0011-bootstrap-seed.ts` (platform service account from env secret, audited `platform.bootstrap`), `libs/db/src/rls-context.ts` (accepts **only** the AuthGuard token object — structurally impossible to feed from `req`), a lint gate (custom ESLint rule or restricted-import check) so no code path can call `set_config`/the context-setter with request-derived values (Doc 07 §5), `libs/db/src/startup-checks.ts` (assert connection role is non-superuser, non-BYPASSRLS, **and owns no `iam` table** — Doc 07 §5.1), RLS isolation test suite (run under the **app** role, never the owner).
**Files to Modify:** `apps/iam-api` bootstrap to run startup checks; `docker-compose`/local setup to create **both** roles per Doc 07 §5.1 — an owner role for migrations and a non-owner `app_role` for requests; `.env` so `DATABASE_URL` and `DATABASE_DIRECT_URL` differ by role, not only endpoint.
**Dependencies:** Session 4
**Acceptance Criteria:**
- With context set to client A, a raw `SELECT * FROM iam.role` returns only A's rows; with no context, zero tenant rows.
- Platform-admin context reads across tenants but `with check` blocks writing a row under another `client_id`.
- Direct `INSERT/UPDATE/DELETE/TRUNCATE` on `audit_trail` as `app_role` all fail; `write_audit()` succeeds and stamps actor/client from session vars.
- Startup aborts if connected as a BYPASSRLS role, a superuser, **or the role owning the `iam` tables** (Doc 07 §5.1 — ownership exempts a role from its own policies, so this check passing is otherwise no evidence of isolation).
- Every RLS-enabled table carries `force row level security`, except `audit_trail` (its `SECURITY DEFINER` writer inserts via the owner path; the app role is blocked there by privilege, not policy).
- Bootstrap seed creates the platform service account; secret comes from env, never logged.
**Definition of Done:** RLS isolation suite green against a two-tenant fixture; seed idempotent (re-run safe).
**Suggested Commit Message:** `feat(db): hand-written RLS policies, JWT-sourced request context, non-forgeable audit fn, bootstrap seed`

# Session 6 — iam-api foundation: error model, health, Redis, RLS wiring
**Goal:** NestJS app skeleton that all feature modules plug into: global validation pipe, the Doc 06 §2 error envelope, request-id, Redis module, rate limiting (the 429 `RATE_LIMITED` path in the error table), `/health` + `/ready`, and the per-request transaction wrapper that applies the RLS context.
**Expected Output:** A running API with correct error semantics and readiness checks; a placeholder authenticated route proving the RLS context flows.
**Files to Create:** `apps/iam-api/src/main.ts`, `app.module.ts`, `common/{http-exception.filter.ts,request-id.middleware.ts,validation.pipe.ts}`, `redis/redis.module.ts`, `health/health.controller.ts`, `common/tenant-context.interceptor.ts` (wraps request DB work in a txn and calls `rls-context` from token — inert until Session 8 provides tokens).
**Files to Modify:** `libs/config` (add any missing ops env).
**Dependencies:** Sessions 2, 5
**Acceptance Criteria:**
- Every error response is `{ error: { code, message, requestId } }` with the Doc 06 §2 code table (incl. 423, 429).
- Throttling returns 429 `RATE_LIMITED` in the standard envelope (tightened per-endpoint later, esp. `/auth/*`).
- `/health` 200 always; `/ready` 503 when Postgres or Redis is down.
- Validation failures → 400 `VALIDATION_FAILED` with field details.
**Definition of Done:** e2e tests for error envelope + health/ready green; app boots against docker-compose services.
**Suggested Commit Message:** `feat(iam-api): app foundation with error model, request-id, redis, health/ready, RLS txn wrapper`

---

## Phase 2 — Authentication

# Session 7 — JWT issuance & JWKS
**Goal:** Key management (RS256 with `kid`), the token-signing service producing the exact Doc 03 §2 claim shape, `/iam/.well-known/jwks.json`, and a key-rotation script honoring the mandatory rotation ordering (Doc 03 §1).
**Expected Output:** Tokens signable and verifiable via published JWKS; rotation tooling that never invalidates in-flight tokens.
**Files to Create:** `apps/iam-api/src/auth/token.service.ts`, `auth/keys.service.ts`, `auth/jwks.controller.ts`, `tools/rotate-keys.ts` (publish-new-public-first → wait → switch signer → retire after max TTL), key config in `libs/config`.
**Files to Modify:** `libs/contracts` if claim type needs refinement.
**Dependencies:** Session 6
**Acceptance Criteria:**
- Access token contains exactly `iss, sub, sty, cid, sid, iat, exp` — no permissions/roles/scopes.
- JWKS serves current + retained keys; verification selects by `kid`; unknown `kid` path documented (refetch-then-reject).
- Signing keys never appear in logs or audit.
**Definition of Done:** Unit tests: sign→verify roundtrip, expired token rejected, rotation keeps old tokens valid.
**Suggested Commit Message:** `feat(auth): RS256 JWT issuance with kid-based JWKS and safe key rotation`

# Session 8 — Login, sessions, logout, revocation + AuthGuard
**Goal:** Human login (`POST /auth/login` with client_slug + argon2id), session rows, logout, per-session revoke, session list, the Redis revoked-`sid` cache, and `AuthGuard` in `libs/auth-kit` (JWKS verify + revocation check + 60 s leeway). Wire the guard into iam-api so the RLS context is now fed by real claims (Doc 03 §3, §6).
**Expected Output:** Full login → authenticated request → force-logout lifecycle working end-to-end.
**Files to Create:** `apps/iam-api/src/auth/{auth.controller.ts,auth.service.ts,session.service.ts,password.util.ts}`, `libs/auth-kit/src/{auth.guard.ts,revocation-cache.ts,jwks-verifier.ts,index.ts}`, e2e suite.
**Files to Modify:** `common/tenant-context.interceptor.ts` (consume AuthGuard claims), `app.module.ts`.
**Dependencies:** Sessions 5, 7
**Acceptance Criteria:**
- Login resolves client by slug, requires `status=active`, creates session, returns access+refresh, audits `auth.login.success/failed`.
- Unknown user and bad password both → identical generic 401; `locked` → 423.
- `POST /auth/sessions/:id/revoke` → subsequent requests with that `sid` rejected within seconds (Redis set), no DB hit on the happy path.
- Clock-skew leeway of 60 s applied from the shared constant.
**Definition of Done:** e2e: login/logout/revoke/sessions-list green; RLS context now derives from verified JWT only.
**Suggested Commit Message:** `feat(auth): password login, sessions, revocation cache, and shared AuthGuard`

# Session 9 — Refresh rotation with reuse detection & grace window
**Goal:** `POST /auth/refresh` with rotation, compromise detection, and the concurrent-refresh grace window (Doc 03 §4).
**Expected Output:** Token refresh that survives the two-tabs race but revokes on real replay.
**Files to Create:** `apps/iam-api/src/auth/refresh.service.ts`, migration adding `session.previous_token_hash` + `rotated_at` (grace state), race-condition e2e tests.
**Files to Modify:** `auth.controller.ts`, `session.service.ts`.
**Dependencies:** Session 8
**Acceptance Criteria:**
- Rotation issues a new refresh token, keeps `session.id`, updates hash.
- Presenting the immediately-previous token **within** the grace window (configurable 10–30 s) returns the already-rotated successor idempotently.
- Presenting it **after** the grace window, or a two-generations-old token, revokes the session and audits `auth.refresh.reuse_detected`.
**Definition of Done:** Concurrency test simulating simultaneous refresh from two clients passes deterministically.
**Suggested Commit Message:** `feat(auth): refresh rotation with reuse detection and concurrent-refresh grace window`

# Session 10 — Password reset & account states
**Goal:** Tokenized time-boxed password reset, lock/unlock semantics (manual + failed-attempt policy), disable-with-session-revocation (Doc 03 §7–8).
**Expected Output:** The full account-state machine: active/locked/disabled with correct login behavior and audits.
**Files to Create:** `apps/iam-api/src/auth/password-reset.service.ts`, reset-token storage (hashed, expiring), lockout policy config.
**Files to Modify:** `auth.controller.ts` (`/auth/password/reset-request`, `/auth/password/reset`), `auth.service.ts` (failed-attempt counter → auto-lock).
**Dependencies:** Session 8
**Acceptance Criteria:**
- Reset request always 202 (no enumeration); token single-use and time-boxed; completion audits both events.
- Minimum password policy enforced at the API on set/reset (length; breach-list optional) per Doc 03 §7.
- N failed logins → auto-lock → 423 + `auth.account.locked` audit; unlock restores login.
- Disabling a user revokes all their sessions immediately.
**Definition of Done:** e2e state-machine matrix (each state × login/refresh/reset) green.
**Suggested Commit Message:** `feat(auth): tokenized password reset and account lock/disable state machine`

# Session 11 — Service accounts & client-credentials token exchange
**Goal:** Service-account CRUD (`/iam/service-accounts` — secret shown once, rotate, revoke) and `POST /auth/token` issuing short-TTL ephemeral-sid tokens (Doc 03 §5, Doc 06 §10).
**Expected Output:** Machine identities that authenticate, get revoked at next exchange, and are bindable like users.
**Files to Create:** `apps/iam-api/src/service-accounts/{controller,service}.ts`, `auth/service-token.service.ts`, e2e suite.
**Files to Modify:** `auth.controller.ts`.
**Dependencies:** Session 8
**Acceptance Criteria:**
- Secret returned exactly once at create/rotate; only the hash is stored; secret never in audit payload.
- `/auth/token` verifies against `key_hash`, requires `active`, issues `sty=service` token with TTL ≤ 5 min and ephemeral `sid`.
- `status=revoked` fails the next exchange; audits `service_account.created/rotated/revoked`.
**Definition of Done:** e2e: create → exchange → call API → revoke → next exchange fails.
**Suggested Commit Message:** `feat(auth): service accounts with one-time secrets and client-credentials token exchange`

# Session 12 — AuditService baseline (same-transaction writes, redaction)
**Goal:** The Nest-side audit layer over `iam.write_audit`: `AuditService.record()` participating in the caller's transaction, the redaction boundary, action-catalog constants, and a best-effort denial writer hook (Doc 10 §3–4, §8).
**Expected Output:** Every existing mutation (auth flows, service accounts) writes atomically-coupled audit records; secrets structurally cannot reach `payload`.
**Files to Create:** `apps/iam-api/src/audit/{audit.service.ts,audit-actions.ts,redact.ts}`, unit tests for redaction and txn coupling.
**Files to Modify:** Auth + service-account services to route through `AuditService` (consolidating ad-hoc audit calls from Sessions 8–11).
**Dependencies:** Sessions 5, 8–11
**Acceptance Criteria:**
- A rolled-back business transaction leaves **no** audit row (same-txn proof test).
- Redaction strips password/hash/token/secret-shaped fields (unit-tested denylist + shape checks).
- Action strings come from the typed catalog, matching Doc 10 §4.
**Definition of Done:** All existing mutations audited through one path; redaction tests green.
**Suggested Commit Message:** `feat(audit): transactional AuditService with redaction boundary and action catalog`

---

## Phase 3 — Platform registry APIs

# Session 13 — Applications, permissions & nav CRUD (platform)
**Goal:** The platform registry endpoints: application CRUD, permission add/list, nav-node add/list, menu-permission mapping (Doc 06 §4). Interim authorization: platform-subject check from the bootstrap account (real `PermissionGuard` retrofit lands in Session 23).
**Expected Output:** An application catalog fully constructible at runtime via API.
**Files to Create:** `apps/iam-api/src/registry/{applications.controller.ts,applications.service.ts,nav.service.ts,permissions.service.ts,dto/*.ts}`, e2e suite.
**Files to Modify:** `app.module.ts`.
**Dependencies:** Sessions 6, 12
**Acceptance Criteria:**
- Duplicate `(application_id, key)` → 409 `CONFLICT`; nav parent must belong to same application.
- Deactivating an application preserves all data (`is_active=false`).
- Every mutation audited (`application.created`, `permission.created`, `nav.node.*`, `menu_permission.mapped/unmapped`).
**Definition of Done:** e2e builds a small app catalog end-to-end via HTTP only.
**Suggested Commit Message:** `feat(registry): platform application, permission, and nav catalog APIs`

# Session 14 — Manifest upsert (idempotent, transactional)
**Goal:** `POST /iam/applications/:id/manifest` — the declarative upsert of permissions + nav + menu_permission keyed by natural keys, with soft-deactivation of removed nodes (Doc 02 §2, §7).
**Expected Output:** Repeatable catalog evolution with zero deploys; the primary app-registration path.
**Files to Create:** `apps/iam-api/src/registry/manifest.service.ts`, manifest validation (against `contracts` manifest DTO), diff computation (reused later by UI preview), `tools/upload-manifest.ts` CLI (the Doc 08 §1 tools entry — repeatable seeding across environments), e2e suite with evolving manifests.
**Files to Modify:** `applications.controller.ts`.
**Dependencies:** Session 13
**Acceptance Criteria:**
- Uploading the same manifest twice is a no-op (idempotent upsert by `(application, key)`).
- Changed labels/routes update in place; keys absent from a re-upload soft-deactivate their nodes/permissions (never hard-delete).
- Entire upsert is one transaction — a mid-manifest validation failure changes nothing.
- Audits `application.manifest.upserted` with a compact diff payload.
**Definition of Done:** e2e: register → evolve → shrink manifest scenarios all green.
**Suggested Commit Message:** `feat(registry): transactional idempotent manifest upsert with soft-deactivation`

# Session 15 — Clients, app enablement & initial client admin
**Goal:** Tenant provisioning: client CRUD/suspend, `client_application` enable/toggle, and `POST /clients/:id/admins` creating the first client-admin user + root scope node + admin binding (Doc 02 §3, Doc 06 §5).
**Expected Output:** A new tenant onboardable entirely via API, ready for self-service.
**Files to Create:** `apps/iam-api/src/clients/{clients.controller.ts,clients.service.ts,dto/*.ts}`, e2e suite.
**Files to Modify:** `app.module.ts`.
**Dependencies:** Sessions 13, 12
**Acceptance Criteria:**
- Creating the initial admin atomically creates: user, root `scope_node` (kind=group, correct `n_<hex>` ltree label), client-admin role (`is_system`), and root-scope binding.
- Disable/re-enable of `client_application` preserves mappings (inert, not deleted).
- Suspended client's users cannot log in.
- Audits `client.created/suspended`, `client_application.enabled/disabled`.
**Definition of Done:** e2e: platform onboards a tenant → tenant admin logs in.
**Suggested Commit Message:** `feat(clients): tenant provisioning, app enablement, and initial client-admin bootstrap`

---

## Phase 4 — Client-admin APIs

# Session 16 — Scope tree API (ltree paths, transactional move)
**Goal:** The org-tree CRUD with materialized-path integrity: id-derived labels, single-statement subtree rewrite on move at `REPEATABLE READ`, guarded delete (Doc 01 §3.5, Doc 06 §6, Doc 07 §7).
**Expected Output:** A correct, concurrency-safe WHERE dimension. (Cache invalidation hooks are stubbed; wired in Session 22.)
**Files to Create:** `apps/iam-api/src/scopes/{scopes.controller.ts,scopes.service.ts,path.util.ts,dto/*.ts}`, concurrency tests.
**Files to Modify:** `app.module.ts`.
**Dependencies:** Sessions 6, 12, 15
**Acceptance Criteria:**
- Path labels are always `n_` + UUID-hex — display names like `"Plant B"` or `"Gate-3"` never appear in `path` (test with hostile names).
- Rename changes `name` only; `path` untouched.
- Move: affected-subject ids captured pre-rewrite → `BEGIN` (REPEATABLE READ) → one `subpath`-based `UPDATE` → `COMMIT` → invalidation hook fires post-commit (stub asserts ordering); serialization failure retried.
- Delete with existing bindings → 409 with clear message.
**Definition of Done:** Deep-tree e2e (insert/move/rename) green incl. a concurrent move-vs-binding-insert test.
**Suggested Commit Message:** `feat(scopes): org-tree API with ltree path integrity and transactional subtree moves`

# Session 17 — Roles & role-permission mapping
**Goal:** Role CRUD and `PUT /roles/:id/permissions` validated against the client's **enabled** applications; guarded delete cascading bindings with audit (Doc 06 §7, Doc 02 §6).
**Expected Output:** Tenant-defined permission bundles, cross-tenant-safe.
**Files to Create:** `apps/iam-api/src/roles/{roles.controller.ts,roles.service.ts,dto/*.ts}`, e2e suite.
**Files to Modify:** `app.module.ts`.
**Dependencies:** Sessions 15, 12
**Acceptance Criteria:**
- Mapping a permission from a non-enabled app → 400/409, no partial write.
- `unique(client_id, name)` → 409 on duplicate role name.
- Role delete: service writes audit for cascaded bindings before deletion.
- RLS e2e: client B cannot see or reference client A's roles (404/403 without existence leak).
**Definition of Done:** e2e role lifecycle green including enabled-app validation and RLS negative tests.
**Suggested Commit Message:** `feat(roles): client role CRUD and permission mapping validated against enabled apps`

# Session 18 — Users CRUD & state management
**Goal:** User create/list/search/detail/update with lock/unlock/disable semantics tied to session revocation (Doc 06 §8, Doc 03 §8).
**Expected Output:** Full tenant user management incl. the "Account Locked Users" data path (status filter).
**Files to Create:** `apps/iam-api/src/users/{users.controller.ts,users.service.ts,dto/*.ts}`, e2e suite.
**Files to Modify:** `app.module.ts`.
**Dependencies:** Sessions 15, 12, 10
**Acceptance Criteria:**
- Same email creatable under two different clients; duplicate within one client → 409.
- Lock/disable revokes all the user's sessions and invalidates grants (hook stub until Session 22); audits `user.locked/unlocked/disabled`.
- List supports `?status=locked` filter, search, pagination envelope.
- Detail includes the user's bindings.
**Definition of Done:** e2e user lifecycle + status transitions green.
**Suggested Commit Message:** `feat(users): tenant user CRUD with lock/disable state and session revocation`

# Session 19 — Bulk user upload & users-by-role
**Goal:** `POST /iam/users/bulk` (CSV/JSON) with per-row result report, and `GET /iam/users/by-role/:roleId` (Doc 06 §8).
**Expected Output:** The "Bulk User Upload" and "Users by Role" features, backend-complete.
**Files to Create:** `apps/iam-api/src/users/bulk-upload.service.ts`, CSV parser util, e2e with mixed-validity fixture files.
**Files to Modify:** `users.controller.ts`.
**Dependencies:** Session 18
**Acceptance Criteria:**
- Mixed file → per-row report `{ row, status: created|skipped|errored, reason? }`; valid rows commit even when others fail (documented partial-success semantics).
- Duplicate-in-file and duplicate-in-db both reported as `skipped` with reason.
- Bulk operation audited once (`user.bulk_uploaded` with counts), rows individually attributable.
**Definition of Done:** e2e fixtures (clean, mixed, all-bad) produce exact expected reports.
**Suggested Commit Message:** `feat(users): bulk upload with per-row result report and users-by-role query`

# Session 20 — Role bindings API (the WHO × WHAT × WHERE write path)
**Goal:** `POST/GET/DELETE /iam/role-bindings` enforcing subject XOR, duplicate prevention, cross-tenant safety rules, and optional `expires_at` (Doc 01 §4.5, Doc 02 §6, Doc 06 §9).
**Expected Output:** The central grant primitive, fully validated.
**Files to Create:** `apps/iam-api/src/bindings/{bindings.controller.ts,bindings.service.ts,dto/*.ts}`, e2e suite.
**Files to Modify:** `app.module.ts`.
**Dependencies:** Sessions 16, 17, 18, 11
**Acceptance Criteria:**
- Exactly one of user/service-account; duplicate (subject, role, node) → 409; ancestor+descendant duplicate is permitted.
- Role, scope node, and subject must all belong to the caller's client — violations → 409/403 with no cross-tenant existence leak.
- `expires_at` stored; expired bindings still listable (for audit/history) but flagged.
- List filters by user/role/scope; audits `role_binding.created/deleted`.
**Definition of Done:** e2e covering every cross-tenant safety rule in Doc 02 §6.
**Suggested Commit Message:** `feat(bindings): scope-aware role bindings with subject XOR and cross-tenant safety`

---

## Phase 5 — Authorization core

# Session 21 — Resolution engine, Redis cache, resolve/check/introspect endpoints
**Goal:** The heart of the system: `resolve()` with path minimization and expiry filtering, the versioned Redis cache, and `GET /iam/permissions/resolve` (+`?applicationId=`), `POST /iam/permissions/check`, `POST /iam/introspect` (Doc 04 §4–6, Doc 06 §11).
**Expected Output:** Correct, cached WHO×WHAT×WHERE answers.
**Files to Create:** `apps/iam-api/src/authz/{resolver.service.ts,grants-cache.service.ts,authz.controller.ts}`, exhaustive unit tests for minimization/coverage, e2e suite.
**Files to Modify:** `app.module.ts`.
**Dependencies:** Sessions 20, 6
**Acceptance Criteria:**
- **`resolve()` takes an explicit `EntityManager` as its first parameter and never calls `entityManager()`** — a deliberate, documented exception to the ambient-transaction convention, decided in `docs/adr/0001-permission-guard-connection-strategy.md`. Session 23's `PermissionGuard` runs before the request transaction exists and must be able to call it on its own connection; writing it against `entityManager()` would force a rewrite inside Session 23. The controller's own routes pass `entityManager()`, so their behaviour inside the request transaction is unchanged. `resolver.service.ts`'s header states the reason and points at the ADR.
- Grants = union over non-expired bindings of role permissions × covering paths; `scopes[permKey]` reduced to the **minimal covering set** (descendant dropped when ancestor present).
- Point check: binding at Plant covers its Gates (ltree `<@`); sibling/other-plant nodes denied; permission asymmetry preserved (`dc.approve` ⇏ `dc.create`).
- Cache key `perms:{clientId}:{sty}:{subjectId}` with version field + ≤10 min TTL; cache miss repopulates from Postgres.
- `?applicationId=` filter returns only that app's slice; disabled `client_application` → its permissions absent from grants.
**Definition of Done:** Resolution correctness matrix (≥15 cases from Doc 04) green; cache hit path verified DB-free.
**Suggested Commit Message:** `feat(authz): WHO×WHAT×WHERE resolution engine with minimized grants and versioned Redis cache`

# Session 22 — Cache invalidation wiring & expiry sweep
**Goal:** Version-bump invalidation at **every** mutation point in the Doc 04 §7 table, post-commit ordering for scope moves (§7.1), `perms.invalidated` pub/sub, and the periodic binding-expiry sweep.
**Expected Output:** Grant changes take effect immediately, never via TTL luck; the highest-risk concurrency case handled per spec.
**Files to Create:** `apps/iam-api/src/authz/{invalidation.service.ts,expiry-sweep.job.ts}`, invalidation e2e suite.
**Files to Modify:** `bindings.service.ts`, `roles.service.ts`, `users.service.ts`, `service-accounts/service.ts`, `clients.service.ts` (app toggle), `manifest.service.ts` (permission deactivation), `scopes.service.ts` (replace Session 16 stub — capture subjects pre-rewrite, publish **after** commit).
**Dependencies:** Sessions 21, 16
**Acceptance Criteria:**
- For each row of the Doc 04 §7 table: perform the change → immediate `resolve()` reflects it (e2e per row).
- Scope move publishes invalidation only after commit (ordering asserted in test); mid-move resolve never caches a phantom path.
- Role-level changes use per-subject version bump (no subject enumeration required at write time) or documented fan-out.
- Sweep job invalidates subjects with newly-expired bindings and audits `role_binding.expired`.
**Definition of Done:** Full invalidation matrix e2e green; concurrent move-vs-resolve test stable across repeated runs.
**Suggested Commit Message:** `feat(authz): complete cache invalidation wiring, post-commit move ordering, and expiry sweep`

# Session 23 — auth-kit PermissionGuard + ScopeResolver + endpoint gating
**Goal:** The reusable authorization layer: `PermissionGuard`, `@RequirePermission(perm, { scopeFrom })`, `ScopeResolver` (coverage test + `allowedPaths` for query narrowing), denial auditing — then retrofit **every** IAM endpoint with its `iam.platform.*` / `iam.client.*` gate, replacing Session 13's interim check. Seed the IAM's own manifest (its permissions + admin-console nav) — dogfooding Doc 02.
**Expected Output:** The system enforces its own permission model end-to-end; `auth-kit` is ready for future modules.
**Files to Create:** `libs/auth-kit/src/{permission.guard.ts,require-permission.decorator.ts,scope-resolver.ts}`, `tools/seed-iam-manifest.ts` + `iam-manifest.json`, guard unit tests (covers(), deny-by-default), authorization e2e matrix.
**Files to Modify:** Every iam-api controller (decorators), `app.module.ts`, bootstrap seed (bind platform account to `iam.platform.*` at platform scope).
**Dependencies:** Sessions 21, 22, 12
**Acceptance Criteria:**
- **On a grants-cache miss the guard opens its own `QueryRunner`, applies `applyRlsContext` from the verified claims, calls `resolve(runner.manager, …)`, then commits and releases in a `finally`** — the `AuditService.recordDenial` pattern, per `docs/adr/0001-permission-guard-connection-strategy.md`. The guard must not open, reuse or leave open the request transaction: a guard has no "after" phase, so `TenantContextInterceptor` stays its sole owner. Denials go through the existing `recordDenial`, already narrowed to the two `authz.*` actions.
- Retrofitting the decorators deletes `common/platform-admin.ts` and `common/administrator.ts`; no endpoint, status code or envelope moves.
- Client admin calling a platform endpoint → 403 `PERMISSION_DENIED`; permission held but wrong scope → 403 `SCOPE_DENIED`; both audited (`authz.permission_denied/scope_denied` with attempted permission + target).
- No binding ⇒ no access (deny-by-default unit-tested); platform-admin path skips tenant coverage but stays permission-gated.
- IAM manifest seeds `iam.platform.*` / `iam.client.*` permissions + admin nav via the real manifest endpoint.
- 403s never reveal cross-tenant existence.
**Definition of Done:** Authorization matrix e2e (platform admin / client admin / plain user / service account × endpoint classes) green.
**Suggested Commit Message:** `feat(auth-kit): PermissionGuard, ScopeResolver, and full endpoint permission gating with IAM manifest dogfood`

# Session 24 — Dynamic navigation endpoint
**Goal:** `GET /iam/navigation(?applicationId=)` implementing the Doc 05 §5 pruning algorithm with `is_public` opt-in and nav-catalog version invalidation.
**Expected Output:** Menus as a pure function of grants + catalog — the visible proof the registry works.
**Files to Create:** `apps/iam-api/src/navigation/{navigation.controller.ts,navigation.service.ts}`, pruning unit tests, e2e.
**Files to Modify:** `registry/nav.service.ts` + `manifest.service.ts` (bump `app_nav_version` on catalog edits).
**Dependencies:** Sessions 21, 13, 23
**Acceptance Criteria:**
- Leaf visible iff subject holds ≥1 mapped permission (OR) — unmapped + `is_public=false` hidden; unmapped + `is_public=true` visible.
- Containers pruned when no visible descendant; inactive nodes excluded; ordering by `sort_order`; disabled apps never returned.
- Cross-application shell variant (no `applicationId`) returns one top-level node per enabled app.
- Admin adds a menu + mapping via API → target user's next nav call shows it (no deploy, no restart).
**Definition of Done:** Pruning unit matrix + live catalog-edit e2e green.
**Suggested Commit Message:** `feat(navigation): permission-driven dynamic nav resolution with catalog version invalidation`

# Session 25 — Audit read API
**Goal:** `GET /iam/audit` with actor/action/target/date filters, client-scoped vs platform-wide visibility, CSV export (itself audited) (Doc 06 §12, Doc 10 §7).
**Expected Output:** The queryable side of governance.
**Files to Create:** `apps/iam-api/src/audit/audit.controller.ts`, query service with pagination, export streamer, e2e.
**Files to Modify:** `audit/audit.service.ts`.
**Dependencies:** Sessions 12, 23
**Acceptance Criteria:**
- Client admin sees only own client's rows (RLS-backed, verified); platform admin sees all incl. `client_id IS NULL` rows.
- All four filters composable; paginated envelope.
- CSV export writes `audit.exported`; no mutate/delete endpoints exist.
**Definition of Done:** e2e filter + visibility matrix green.
**Suggested Commit Message:** `feat(audit): filtered audit read API with tenant scoping and audited CSV export`

# Session 26 — libs/iam-client (typed API client)
**Goal:** The typed HTTP client for `/auth/*` + `/iam/*` that `admin-web` and every future module consume: token lifecycle (login/refresh/logout), resolve caching, error mapping to `IamErrorCode` (Doc 08 §2).
**Expected Output:** One import gives any consumer authenticated, typed IAM access.
**Files to Create:** `libs/iam-client/src/{client.ts,auth.ts,resolve-cache.ts,endpoints/*.ts,index.ts}`, unit tests against a mocked server.
**Files to Modify:** —
**Dependencies:** Sessions 23, 24, 25 (surface frozen)
**Acceptance Criteria:**
- Every Doc 06 endpoint has a typed method returning `contracts` types.
- Automatic refresh-on-401 (single-flight — concurrent calls share one refresh).
- Depends only on `contracts` (boundary lint).
**Definition of Done:** Mocked-server test suite green; consumable from both Node and browser contexts.
**Suggested Commit Message:** `feat(iam-client): typed IAM API client with token lifecycle and resolve caching`

---

## Phase 6 — Admin console (frontend)

# Session 27 — admin-web foundation: auth, shell, dynamic nav
**Goal:** Next.js foundation: login page (client_slug + email + password), token storage with silent refresh, logout, the app shell, and the sidebar rendered **from `/iam/navigation`** — never hardcoded (Doc 09 §1, §4; Doc 05 §7). Visuals per Doc 09: governed by the frontend-design skill and the project design language — no mandated component library; shared primitives live in `libs/ui`.
**Expected Output:** Any user logs in and sees exactly the menu their permissions produce.
**Files to Create:** `apps/admin-web/src/app/{login,layout,providers}.tsx`, `lib/auth-context.tsx`, `components/shell/{sidebar,header}.tsx`, `lib/use-permission.ts` (permission-aware control hook — hide/disable actions the subject lacks, UX only; Doc 09 §4), icon-key → icon-set map (Doc 05 §7), API error → toast handler.
**Files to Modify:** `libs/ui` (shared tokens/components as they emerge).
**Dependencies:** Sessions 26, 24
**Acceptance Criteria:**
- Login/logout/silent-refresh work against the real API; 423 shows a distinct "account locked" message.
- Sidebar is a pure render of the nav response — platform admin and client admin see different consoles from the same app.
- Deep link to a hidden route still calls the API and renders the 403 cleanly (client-side hiding is UX only; the server enforces).
- Permission-aware controls: buttons/actions the subject lacks are hidden/disabled via the shared hook (Doc 09 §4) — used by every subsequent screen session.
**Definition of Done:** Manual walkthrough: platform admin and client admin both log in and see their correct shells.
**Suggested Commit Message:** `feat(admin-web): authenticated shell with dynamic permission-driven navigation`

# Session 28 — Platform console: applications screens
**Goal:** Applications list, create, and detail with the three tabs: permissions table, nav tree editor, menu-permission mapping (Doc 09 §2.1).
**Expected Output:** Full catalog management UI (form path; manifest path next session).
**Files to Create:** `apps/admin-web/src/app/platform/applications/{page.tsx,[id]/page.tsx}`, `components/applications/{permissions-tab,nav-tree-editor,menu-permissions-tab}.tsx`.
**Files to Modify:** —
**Dependencies:** Session 27 (+13 API)
**Acceptance Criteria:**
- List shows key/name/active; create + activate/deactivate work.
- Nav tree editor: add node (kind/route/icon/sort), reflecting immediately; menu-permission tab maps permissions per node.
- All mutations reflect API errors (409 duplicate key, etc.) inline.
**Definition of Done:** An app registrable and fully wired from the UI alone.
**Suggested Commit Message:** `feat(admin-web): platform application catalog screens with nav and permission editors`

# Session 29 — Platform console: manifest upload with diff preview
**Goal:** The primary registration path: paste/upload manifest JSON → preview diff (new/changed/deactivated permissions & nav) → confirm upsert (Doc 09 §2.1, Doc 02 §2).
**Expected Output:** Declarative catalog evolution from the UI.
**Files to Create:** `apps/admin-web/src/app/platform/applications/manifest/page.tsx`, `components/applications/manifest-diff.tsx`; backend: dry-run/preview mode on the manifest endpoint if not present.
**Files to Modify:** `manifest.service.ts` (+`?dryRun=` support), `applications.controller.ts`.
**Dependencies:** Sessions 28, 14
**Acceptance Criteria:**
- Invalid manifest → validation errors before any preview.
- Preview shows adds/changes/deactivations without committing; confirm applies exactly the previewed diff.
- Re-uploading an identical manifest previews "no changes."
**Definition of Done:** Register-by-manifest flow e2e from UI; audit shows the upsert.
**Suggested Commit Message:** `feat(admin-web): manifest upload with dry-run diff preview and confirmed upsert`

# Session 30 — Platform console: clients screens
**Goal:** Client list/create/detail: app enablement toggles, initial-admin creation, suspend/reactivate (Doc 09 §2.2).
**Expected Output:** Tenant onboarding entirely from the UI.
**Files to Create:** `apps/admin-web/src/app/platform/clients/{page.tsx,[id]/page.tsx}`, `components/clients/{app-toggles,admin-create}.tsx`.
**Files to Modify:** —
**Dependencies:** Session 27 (+15 API)
**Acceptance Criteria:**
- Create client (name/slug); detail shows enabled-app count and toggles.
- Initial-admin form creates user + root scope + binding in one action, surfacing the result.
- Suspend blocks that client's logins (verified manually).
**Definition of Done:** Fresh tenant onboarded UI-only; its admin can log in.
**Suggested Commit Message:** `feat(admin-web): client management screens with app enablement and admin bootstrap`

# Session 31 — Client console: scope tree editor
**Goal:** The org-structure tree editor: add child (kind picker), rename, move, delete-with-guard messaging — the WHERE dimension made visible (Doc 09 §3.1).
**Expected Output:** Tenant admins build Group→Plant→Department→Gate themselves.
**Files to Create:** `apps/admin-web/src/app/client/scopes/page.tsx`, `components/scopes/scope-tree-editor.tsx` (tree component with node actions).
**Files to Modify:** `libs/ui` (tree selector component — reused by bindings screen).
**Dependencies:** Session 27 (+16 API)
**Acceptance Criteria:**
- Add/rename/move reflect immediately; move UX communicates "access follows the tree."
- Delete of a node with bindings shows the API's 409 message clearly.
- Kinds rendered distinctly (group/plant/department/gate).
**Definition of Done:** A realistic 3-level tree buildable and reorganizable from UI.
**Suggested Commit Message:** `feat(admin-web): client scope-tree editor for the org structure`

# Session 32 — Client console: roles & permission picker
**Goal:** Role list/create/edit with the permission picker grouped by enabled application, searchable multi-select; delete with affected-bindings warning (Doc 09 §3.2).
**Expected Output:** Tenant role management UI.
**Files to Create:** `apps/admin-web/src/app/client/roles/{page.tsx,[id]/page.tsx}`, `components/roles/permission-picker.tsx`.
**Files to Modify:** —
**Dependencies:** Session 27 (+17 API)
**Acceptance Criteria:**
- Picker shows only enabled apps' permissions, grouped and searchable.
- Role list shows name / #permissions / #users bound.
- Delete warns with affected-binding count before confirming.
**Definition of Done:** Role created, mapped, edited, deleted from UI with correct API effects.
**Suggested Commit Message:** `feat(admin-web): role management with enabled-app-grouped permission picker`

# Session 33 — Client console: users screens
**Goal:** User list/search with status filters (the "Account Locked Users" view), create, detail with bindings panel and lock/unlock/disable/reset actions (Doc 09 §3.3).
**Expected Output:** Complete tenant user administration UI.
**Files to Create:** `apps/admin-web/src/app/client/users/{page.tsx,[id]/page.tsx}`, `components/users/{user-form,bindings-panel,status-actions}.tsx`.
**Files to Modify:** —
**Dependencies:** Session 27 (+18 API)
**Acceptance Criteria:**
- Status filter tabs (active/locked/disabled); locked tab is the Account Locked Users screen.
- Detail shows bindings (role + scope node names); lock/unlock/disable act immediately with confirmation.
- Reset triggers the tokenized flow.
**Definition of Done:** Full user lifecycle drivable from UI.
**Suggested Commit Message:** `feat(admin-web): user management screens with status filters and bindings panel`

# Session 34 — Client console: bulk upload & users-by-role
**Goal:** CSV/JSON bulk upload with the per-row result report, and the Users-by-Role view (Doc 09 §3.3).
**Expected Output:** The two remaining user features, UI-complete.
**Files to Create:** `apps/admin-web/src/app/client/users/bulk/page.tsx`, `components/users/{bulk-report-table,users-by-role}.tsx`.
**Files to Modify:** `users/page.tsx` (entry points).
**Dependencies:** Session 33 (+19 API)
**Acceptance Criteria:**
- Upload → progress → per-row table (created/skipped/errored with reason), filterable by outcome.
- Users-by-Role: role picker → bound-user list with scope context.
**Definition of Done:** Mixed-validity CSV produces the exact expected report in UI.
**Suggested Commit Message:** `feat(admin-web): bulk user upload with per-row report and users-by-role view`

# Session 35 — Client console: role bindings (assign access)
**Goal:** The key screen: pick user/service-account → role → **scope node via tree selector** → optional expiry; bindings list with filters and unbind (Doc 09 §3.4).
**Expected Output:** WHO × WHAT × WHERE grantable in one guided action.
**Files to Create:** `apps/admin-web/src/app/client/bindings/page.tsx`, `components/bindings/{assign-access-wizard,bindings-table}.tsx`.
**Files to Modify:** reuse `libs/ui` tree selector from Session 31.
**Dependencies:** Sessions 31, 32, 33 (+20 API)
**Acceptance Criteria:**
- Scope is mandatory and prominent — no grant without choosing where; the picker shows the tree.
- Post-change notice that access updates may take a few seconds (invalidation, Doc 09 §4).
- List filterable by user/role/scope; unbind with confirmation; duplicate binding shows the 409 clearly.
**Definition of Done:** Grant → target user's nav/permissions change on next resolve — demonstrated end-to-end.
**Suggested Commit Message:** `feat(admin-web): scope-aware role-binding screen (assign access)`

# Session 36 — Service accounts UI (platform + client)
**Goal:** Create/rotate/revoke service accounts at both tiers with the secret-shown-once UX (Doc 09 §2.4, §3.5).
**Expected Output:** Machine-identity management UI.
**Files to Create:** `apps/admin-web/src/app/{platform,client}/service-accounts/page.tsx`, `components/service-accounts/{secret-reveal-modal,accounts-table}.tsx`.
**Files to Modify:** —
**Dependencies:** Session 27 (+11 API)
**Acceptance Criteria:**
- Secret displayed exactly once in a copy-to-clipboard modal with an explicit "you won't see this again" warning; never re-fetchable.
- Rotate and revoke with confirmations; client-tier accounts bindable via the bindings screen.
**Definition of Done:** Create → copy secret → exchange token (manually) → revoke, all from UI.
**Suggested Commit Message:** `feat(admin-web): service-account management with one-time secret reveal`

# Session 37 — Audit views (platform + client)
**Goal:** The audit browsers: platform-wide and client-scoped, with actor/action/target/date filters and CSV export (Doc 09 §2.3, §3.6).
**Expected Output:** Governance made visible at both tiers.
**Files to Create:** `apps/admin-web/src/app/{platform,client}/audit/page.tsx`, `components/audit/{audit-table,audit-filters,payload-drawer}.tsx`.
**Files to Modify:** —
**Dependencies:** Session 27 (+25 API)
**Acceptance Criteria:**
- Filters composable; payload viewable in a detail drawer; pagination.
- Client console shows only own-tenant rows; platform shows all incl. platform-level actions.
- Export triggers download and (verifiably) writes `audit.exported`.
**Definition of Done:** Every action performed during a demo run is findable in the audit UI.
**Suggested Commit Message:** `feat(admin-web): platform and client audit browsers with filters and export`

---

## Phase 7 — Hardening & deployment

# Session 38 — E2E hardening & security test battery
**Goal:** The cross-cutting proof suite beyond per-session tests: RLS isolation battery, full auth-flow suite, resolution-correctness matrix, boundary-lint verification, and a resolve-endpoint load smoke (Doc 08 §7).
**Expected Output:** A regression wall for the system's security properties.
**Files to Create:** `apps/iam-api-e2e/src/{rls-isolation,auth-flows,resolution-matrix,authorization-matrix,invalidation}.e2e.ts`, two-tenant seed fixture, `tools/load-smoke.ts`, boundary-violation lint test.
**Files to Modify:** CI config placeholder (finalized Session 39).
**Dependencies:** Sessions 23, 24, 25, 26 (backend complete)
**Acceptance Criteria:**
- A deliberately tenant-unfiltered query in a test harness still returns only the context tenant's rows (RLS is the last line — proven).
- Auth suite: login/refresh-race/reuse/lockout/revocation/service-token, all green.
- Resolution matrix incl. ancestor coverage, minimization, expiry, disabled-app, deny-by-default.
- Load smoke: cached resolve stays DB-free under concurrent load.
**Definition of Done:** One command (`nx run-many -t e2e`) runs the whole battery green on a clean environment.
**Suggested Commit Message:** `test(e2e): RLS isolation, auth-flow, and resolution-correctness hardening battery`

# Session 39 — Deployment: containers, CI, environments
**Goal:** Production path per Doc 08 §6: iam-api container on Railway (+managed Redis), admin-web on Vercel, CI with `nx affected`, migration release step using the **direct** DB URL, env/secret documentation, and the ops runbook (key rotation, bootstrap, readiness).
**Expected Output:** Deployed staging environment reachable end-to-end.
**Files to Create:** `apps/iam-api/Dockerfile`, `.github/workflows/ci.yml` (lint→test→affected e2e→build), `railway.json`/deploy config, Vercel config, `docs/ops-runbook.md` (rotation ordering, bootstrap secret handling, pooler vs direct URLs, backup/restore of audit), `tools/release-migrate.ts`.
**Files to Modify:** `libs/config` (per-env vars), health/ready wiring to platform checks.
**Dependencies:** Session 38
**Acceptance Criteria:**
- CI green on PR: `nx affected` lint/test/build; e2e against ephemeral Postgres+Redis.
- Release runs migrations via direct URL before app swap; app uses pooler URL with prepared statements disabled.
- Staging: login → onboard tenant → grant → resolve works against Supabase + managed Redis; `/ready` wired to platform health checks.
- No secret in repo; bootstrap secret rotated after first use per runbook.
**Definition of Done:** Documented, repeatable deploy; staging demo of the full onboarding flow.
**Suggested Commit Message:** `chore(deploy): containerized CI/CD with migration release step and ops runbook`

---

## Dependency Graph

Linear backbone with these explicit edges (a session also implicitly depends on everything its dependencies depend on):

```
S1  → (root)
S2  → S1
S3  → S2
S4  → S3
S5  → S4
S6  → S2, S5
S7  → S6
S8  → S5, S7
S9  → S8
S10 → S8
S11 → S8
S12 → S5, S8–S11
S13 → S6, S12
S14 → S13
S15 → S12, S13
S16 → S6, S12, S15
S17 → S12, S15
S18 → S10, S12, S15
S19 → S18
S20 → S11, S16, S17, S18
S21 → S6, S20
S22 → S16, S21
S23 → S12, S21, S22
S24 → S13, S21, S23
S25 → S12, S23
S26 → S23, S24, S25
S27 → S24, S26
S28 → S27 (API: S13)
S29 → S14, S28
S30 → S27 (API: S15)
S31 → S27 (API: S16)
S32 → S27 (API: S17)
S33 → S27 (API: S18)
S34 → S33 (API: S19)
S35 → S31, S32, S33 (API: S20)
S36 → S27 (API: S11)
S37 → S27 (API: S25)
S38 → S23, S24, S25, S26
S39 → S38
```

Parallelizable clusters (if two conversations run side by side): {S9, S10, S11} after S8; {S16, S17, S18} after S15; {S28, S30–S33, S36} after S27.

---

## Milestones

**Milestone 1 — Infrastructure Complete** (Sessions 1–6)
Deliverables: Nx workspace with enforced boundaries; shared contracts/config; complete schema with every Doc 01 constraint; hand-written RLS proven by isolation tests; non-forgeable append-only audit at the DB layer; bootstrapped platform identity; API skeleton with error model and health checks.
Exit test: cross-tenant isolation suite green on a two-tenant fixture.

**Milestone 2 — Backend MVP** (Sessions 7–26)
Deliverables: full custom-JWT auth (login, rotation with grace window, reset, lockout, service accounts, revocation); transactional audit on every mutation; runtime registry (apps, manifests, clients, enablement); complete client-admin surface (scopes, roles, users, bulk, bindings); the resolution engine with versioned cache and full invalidation wiring; PermissionGuard-gated endpoints (dogfooded via the IAM's own manifest); dynamic navigation; audit read; typed `iam-client`.
Exit test: onboard a tenant, grant `x.y.z` at Plant B, and `/permissions/check` approves Gate 3 under Plant B while denying Plant A — all via HTTP, no code changes.

**Milestone 3 — Frontend MVP** (Sessions 27–37)
Deliverables: admin-web with dynamic nav shell; platform console (applications, manifest diff upload, clients); client console (scope tree, roles, users incl. locked view, bulk upload, users-by-role, scope-aware bindings); service-account and audit UIs at both tiers.
Exit test: complete platform-onboards-tenant → tenant-self-serves → guard-logs-in demo executed entirely through the UI.

**Milestone 4 — Production Ready** (Sessions 38–39)
Deliverables: hardening battery (RLS, auth, resolution, load smoke); CI with `nx affected`; containerized deploy to Railway/Vercel with migration release step; ops runbook.
Exit test: green CI + staging environment running the Milestone 3 demo.

---

## Explicitly deferred (per spec — do not build in v1)

The specs name these as out of scope or optional; the schema already accommodates them, so no session includes them:

- **OIDC/SSO federation** — `user_identity.provider` + `provider_subject` reserved (Doc 03 §10).
- **WhatsApp OTP login** — `user.phone` reserved (Doc 03 §10).
- **MFA/TOTP** — future additional `user_identity` factor (Doc 03 §10).
- **Audit hash chain** (`prev_hash`/`row_hash` tamper evidence) — optional, only if a customer's compliance regime demands it (Doc 10 §5).
- **Access reviews** ("who has what, where" attestation reports) — roadmap hook (Doc 10 §9).
- **Access-request → approval flow before binding creation** — waits for the future kernel ApprovalEngine (Doc 10 §9).
- **BullMQ queues** — arrive with the operational modules, not IAM (Doc 00 §6).
- **The shared kernel and the six operational modules** (gatepass, visitor, …) — separate spec suites after IAM is proven (Doc 00 §9).

---

## Estimates

| # | Session | Complexity | Est. hours | Risk | Model |
|---|---|---|---|---|---|
| 1 | Nx scaffold & boundaries | Medium | 4–6 | Low | Sonnet |
| 2 | config + contracts | Low | 3–4 | Low | Sonnet |
| 3 | db: registry entities | Medium | 4–6 | Low | Sonnet |
| 4 | db: tenant/mapping/audit | Medium | 5–7 | Medium | Sonnet |
| 5 | RLS + write_audit + seed | High | 8–12 | **High** | Opus |
| 6 | API foundation | Medium | 4–6 | Low | Sonnet |
| 7 | JWT + JWKS | Medium | 5–7 | Medium | Opus |
| 8 | Login/sessions/AuthGuard | High | 7–10 | Medium | Opus |
| 9 | Refresh rotation + grace | Medium | 5–7 | **High** | Opus |
| 10 | Password reset + states | Medium | 4–6 | Low | Sonnet |
| 11 | Service accounts + token | Medium | 4–6 | Medium | Sonnet |
| 12 | AuditService baseline | Medium | 4–6 | Medium | Sonnet |
| 13 | Registry CRUD APIs | Medium | 5–7 | Low | Sonnet |
| 14 | Manifest upsert | High | 6–8 | **High** | Opus |
| 15 | Clients + enablement | Medium | 5–7 | Medium | Sonnet |
| 16 | Scope tree API (ltree/move) | High | 8–12 | **High** | Opus |
| 17 | Roles + role_permission | Medium | 4–6 | Low | Sonnet |
| 18 | Users CRUD + states | Medium | 5–7 | Low | Sonnet |
| 19 | Bulk upload + by-role | Medium | 4–6 | Low | Sonnet |
| 20 | Role bindings API | Medium | 5–7 | Medium | Opus |
| 21 | Resolution engine + cache | High | 8–12 | **High** | Opus |
| 22 | Invalidation wiring + sweep | High | 8–12 | **High** | Opus |
| 23 | PermissionGuard + gating | High | 8–12 | **High** | Opus |
| 24 | Dynamic navigation | Medium | 5–7 | Medium | Sonnet |
| 25 | Audit read API | Low | 3–4 | Low | Sonnet |
| 26 | iam-client | Medium | 4–6 | Low | Sonnet |
| 27 | admin-web foundation | High | 7–10 | Medium | Opus |
| 28 | UI: applications | Medium | 6–8 | Low | Sonnet |
| 29 | UI: manifest diff upload | Medium | 5–7 | Medium | Sonnet |
| 30 | UI: clients | Medium | 4–6 | Low | Sonnet |
| 31 | UI: scope tree editor | Medium | 5–7 | Medium | Sonnet |
| 32 | UI: roles + picker | Medium | 4–6 | Low | Sonnet |
| 33 | UI: users | Medium | 5–7 | Low | Sonnet |
| 34 | UI: bulk + by-role | Low | 3–5 | Low | Sonnet |
| 35 | UI: role bindings | Medium | 5–7 | Medium | Sonnet |
| 36 | UI: service accounts | Low | 3–4 | Low | Sonnet |
| 37 | UI: audit views | Low | 3–5 | Low | Sonnet |
| 38 | E2E hardening battery | High | 8–12 | Medium | Opus |
| 39 | Deployment + CI + runbook | Medium | 6–8 | Medium | Sonnet |

**Total: ~205–285 hours across 39 sessions.** High-risk sessions (5, 9, 14, 16, 21–23) are the ones the spec itself flags as load-bearing — budget review time there and don't parallelize them with anything that touches the same tables.
