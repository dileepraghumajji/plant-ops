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

## Phase 8 — Single-tenant delivery (dedicated & self-hosted)

> **Authority:** Doc 11. Phase 7 delivers the managed multi-tenant path (Railway + Vercel); this phase delivers the two single-tenant ones — a dedicated instance we operate, and a self-hosted install the client operates. Doc 11 §3 is the constraint every session here obeys: **one codebase, one image set, no per-customer fork.** Everything that varies between deployments varies as configuration.
>
> These sessions modify code delivered in Sessions 1–38. That is expected and is why they are separate sessions: no entry above is edited, and each session below states exactly which shipped files it touches and what must not change about them.
>
> OIDC/SSO federation stays deferred per Doc 03 §10 and is not in this phase — but note Doc 11 §12: if the first enterprise client runs Active Directory, SSO outranks most of the work below and should be specced before it.

# Session 40 — Origin-agnostic admin console
**Goal:** Make `admin-web` work at any hostname without a rebuild, by defaulting its API base to the same-origin path `/api` (Doc 11 §8, gap 2). Today `NEXT_PUBLIC_IAM_API_URL` is substituted into the bundle at build time, so one image cannot serve two customer hostnames and a per-customer build would be a fork by another name.
**Expected Output:** One `admin-web` build that runs unchanged on `localhost`, on Vercel, on a dedicated instance, and inside a client's network.
**Files to Create:** `apps/admin-web/.env.example` (referenced by the README today but absent from the repo), `apps/admin-web/src/lib/api-config.spec.ts`.
**Files to Modify:** `apps/admin-web/src/lib/api-config.ts` (default `IAM_API_URL` to `/api`; `IAM_API_LABEL` must render a relative base as something meaningful rather than the result of stripping a scheme that is not there), `libs/web-kit/src/index.ts` (the `PlantOpsProvider` docblock example still shows `process.env.NEXT_PUBLIC_IAM_API_URL!`), `README.md` (quickstart env step), `.env.example` (`CORS_ALLOWED_ORIGINS` guidance — same-origin deployments need no entry at all).
**Dependencies:** Sessions 26, 27
**Acceptance Criteria:**
- A **relative** base works end-to-end without touching `libs/iam-client`: `http.ts` builds request URLs by concatenating `baseUrl + path`, so `/api` + `/auth/login` is already correct. Prove it with a test rather than assume it — that concatenation is the single line this session depends on.
- Setting `NEXT_PUBLIC_IAM_API_URL` to an absolute origin still works exactly as before; the local dev flow (console on 4200, API on 3000) is unchanged.
- Same-origin deployments require **no** `CORS_ALLOWED_ORIGINS` entry; the cross-origin dev flow still does, and `.env.example` says which is which.
- No change to `libs/iam-client` or `libs/web-kit` runtime code.
**Definition of Done:** `nx test admin-web` green; console verified against both an absolute base (dev) and a relative base (behind a local proxy).
**Suggested Commit Message:** `feat(admin-web): default the API base to a same-origin path so one build serves any hostname`

# Session 41 — Container images for both apps, proxy, and migration runner
**Goal:** The images a single-tenant stack needs. Session 39 containerizes `iam-api` for the managed platform, where `admin-web` is hosted by Vercel and migrations run as a release step; neither assumption holds on a client's server. This session adds the console image, the reverse proxy that makes §40's same-origin path real, and a **one-shot migration runner** so an upgrade never requires a Node toolchain on the host (Doc 11 §5.3).
**Expected Output:** `docker compose up` on any machine yields a working stack: proxy → console + API → Postgres + Redis.
**Files to Create:** `apps/admin-web/Dockerfile` (Next standalone output), `deploy/proxy/{Dockerfile,nginx.conf}` (serves the console at `/`, proxies `/api` → iam-api with the `/api` prefix stripped, forwards `X-Forwarded-For`), `deploy/migrate/Dockerfile` (runs `tools/release-migrate.ts` against the direct URL and exits), `apps/iam-api/src/health/version.spec.ts`.
**Files to Modify:** `apps/admin-web/next.config.js` (`output: 'standalone'`), `apps/iam-api/src/health/health.controller.ts` (report the build version — Doc 11 §8, gap 8: support cannot start without it), `libs/config/src/env.schema.ts` (`APP_VERSION`, stamped at build), `.github/workflows/ci.yml` (build and tag all images; digest-pin base images), `apps/iam-api/Dockerfile` (add the version label — **create it here if Session 39 has not run yet**, since this phase must not block on the managed deploy path), `.dockerignore` (Session 39 created it for the API image; extend it for the console's build context).
**Dependencies:** Session 40 (Session 39 if it has already run — see the note on `apps/iam-api/Dockerfile`)
**Acceptance Criteria:**
- `TRUST_PROXY=true` is correct and documented behind the bundled proxy, and the proxy rewrites `X-Forwarded-For` rather than passing a client-supplied value through — otherwise every caller picks their own rate-limit bucket (`env.schema.ts` already warns about exactly this).
- The console image contains no customer-specific value; the same digest runs on two different hostnames in the test.
- The migration runner exits non-zero on failure and is safe to re-run when already up to date.
- Version reported by `/health` matches the image tag; CI fails if they diverge.
**Definition of Done:** All four images build in CI; a compose stack assembled from them serves login end-to-end on a machine with no workspace checkout.
**Suggested Commit Message:** `chore(deploy): console, proxy, and migration-runner images with build version stamping`

# Session 42 — Offline production bundle & first-boot bootstrap
**Goal:** The handover kit of Doc 11 §5.3 — a versioned bundle that installs on a machine with **no internet access**, because plant networks routinely have no egress and an installer that needs one fails on site on day one (Doc 11 §5.1).
**Expected Output:** A single artifact a client's IT can copy to a server and install from, with no registry pull and no workspace checkout.
**Files to Create:** `deploy/docker-compose.prod.yml`, `deploy/.env.template` (every variable `libs/config` validates, with its meaning — the template is what stops a boot-time validation failure becoming a support call), `tools/build-bundle.mjs` (`docker save` the pinned digests + compose + template + runbooks into one tarball), `tools/bootstrap-install.mjs` (roles → migrate → platform identity → client → initial admin), `deploy/README.md`.
**Files to Modify:** `tools/setup-db-roles.sql` (invoked by bootstrap rather than run by hand), `.env.example` (point at the template for production).
**Dependencies:** Session 41
**Acceptance Criteria:**
- **Both database roles from Doc 07 §5.1 are created by bootstrap** — an owner for migrations and a non-owner `app_role` for requests. This is the load-bearing one: a self-hosted install that runs the app as the table owner silently exempts itself from every RLS policy, and `startup-checks.ts` is the only thing standing between that mistake and a shipped product. The install must fail loudly, not start.
- Install completes on a host with networking disabled, from the tarball alone.
- Bootstrap is idempotent — re-running changes nothing and re-reports the same state.
- `PLATFORM_BOOTSTRAP_SECRET` is consumed once, never written to a log or to the compose file, and the runbook step to rotate it immediately is part of the script's own output.
- The stack answers `/ready` 200 before the script reports success.
**Definition of Done:** A clean VM, network off, tarball copied in → working login, verified by a scripted smoke test that ships in the bundle.
**Suggested Commit Message:** `chore(deploy): offline installable production bundle with idempotent first-boot bootstrap`

# Session 43 — Application manifests as release artifacts
**Goal:** Ship manifests with the release and apply them idempotently at install and on every upgrade, so a single-tenant deployment never needs a human in the platform console to register an application (Doc 11 §6.3). Doc 02 §2 already defines manifest upload as an upsert keyed by `(application, key)` — this session makes the release, rather than an operator, the thing that performs it.
**Expected Output:** The permission and nav catalog on a client's box is always the catalog we tested, and re-converges on upgrade if anyone has edited it.
**Files to Create:** `deploy/manifests/` (the release's bundled manifest set, `tools/iam-manifest.json` among them), `tools/apply-manifests.ts`, `apps/iam-api-e2e/src/manifest-convergence.e2e.ts`.
**Files to Modify:** `tools/bootstrap-install.mjs` (apply after migrate), `deploy/migrate/Dockerfile` (apply as the second step of the upgrade path), `tools/seed-iam-manifest.ts` (fold into the general applier rather than duplicating it), `.github/workflows/ci.yml` (bundle the manifests into the images).
**Dependencies:** Sessions 14, 23, 42
**Acceptance Criteria:**
- Applying the shipped manifests twice is a no-op, and the second run audits nothing (Session 14's idempotence, now exercised by the release path).
- A catalog hand-edited through the API **re-converges** on the next upgrade: added permissions are restored, and keys absent from the manifest soft-deactivate rather than hard-delete, exactly as Doc 02 §7 requires.
- A failure part-way through leaves the catalog untouched — the whole application of one manifest is a single transaction.
- The IAM's own manifest continues to be seeded through the real endpoint (Session 23's dogfooding property is preserved, not bypassed).
**Definition of Done:** Install → hand-edit the catalog → upgrade → catalog matches the release, proven by e2e.
**Suggested Commit Message:** `feat(deploy): ship application manifests with the release and apply them idempotently on upgrade`

# Session 44 — Single-tenant deployment mode
**Goal:** `DEPLOYMENT_MODE=single_tenant`: one client pinned at boot, login without a tenant slug, client creation refused, platform routes hidden (Doc 11 §6.5, §8 gap 4). **This session changes the login path — treat it with the care Sessions 8 and 9 were given.**
**Expected Output:** A single-tenant install whose users type an email and a password, and nothing else.
**Files to Create:** `apps/iam-api/src/config/deployment-mode.ts`, `apps/iam-api-e2e/src/single-tenant.e2e.ts`.
**Files to Modify:** `libs/config/src/env.schema.ts` (`DEPLOYMENT_MODE`, `SINGLE_TENANT_CLIENT_SLUG`), `.env.example`, `deploy/.env.template`, `apps/iam-api/src/auth/auth.dto.ts` (`client_slug` optional in single-tenant mode only), `auth.service.ts` (resolve the pinned client server-side), `apps/iam-api/src/clients/clients.controller.ts` (refuse creation), `apps/admin-web/src/app/login/page.tsx` (drop the field), `apps/admin-web/src/components/shell/sidebar.tsx` (hide the platform section), `README.md`.
**Dependencies:** Sessions 8, 15, 42
**Acceptance Criteria:**
- **The pinned client id is resolved at boot from configuration and never from anything the browser sends.** A request supplying a different `client_slug` in single-tenant mode is refused, not honoured — the field being absent from the form is a UX change, not the control.
- **RLS is unchanged and still enforced.** `app.current_client_id` is still set per request, `force row level security` still applies, and `rls-isolation.e2e.ts` passes without modification. Doc 11 §3: a bypass path would be a second code path that nobody tests.
- **In `saas` mode, behaviour is identical to today** — every existing e2e in `apps/iam-api-e2e` passes unmodified. This is the property that makes the session safe; assert it, do not assume it.
- Client creation in single-tenant mode returns a clear error explaining that the deployment is pinned to one tenant. This is a coherence rule, not a licensing one: a second `client` row would be unreachable by every request the process serves.
- Boot fails loudly if `DEPLOYMENT_MODE=single_tenant` and the named client does not exist.
- Hiding platform routes in the console is UX only; the API still enforces (Doc 09 §4).
**Definition of Done:** Both modes green — the full existing e2e battery in `saas`, and the new single-tenant suite in `single_tenant`.
**Suggested Commit Message:** `feat(iam-api): single-tenant deployment mode with a boot-pinned client and slugless login`

# Session 45 — Restricted platform role & break-glass recovery
**Goal:** What a self-hosted client legitimately gets of the platform tier, and how they recover when locked out (Doc 11 §6.4). On their hardware we cannot withhold anything technically — so the aim is to make platform access unnecessary, and to make the one genuinely necessary capability auditable.
**Expected Output:** An on-prem platform role that grants visibility and nothing that writes to the catalog, plus a host-level recovery path.
**Files to Create:** `libs/db/src/migrations/0019-onprem-platform-role.ts` (seeds the role; **0019 is the next free number** — Session 44 took 0018 for the pinned-client lookup), `tools/break-glass-admin.ts`, `apps/iam-api-e2e/src/onprem-role.e2e.ts`.
**Files to Modify:** `tools/bootstrap-install.mjs` (seed the role in single-tenant mode only), `deploy/README.md`.
**Dependencies:** Sessions 23, 44
**Acceptance Criteria:**
- The role is assembled **entirely from permission keys that already exist** in `0017-iam-permission-seed.ts` — no new permission is invented. Granted: `iam.platform.{app,permission,nav,client,client.app}.read` and `iam.platform.audit.read`. Withheld: `app.create`, `app.update`, `app.manifest`, `permission.create`, `nav.create`, `nav.map`, `client.create`, `client.app.enable`, `client.app.update`.
- **No console change is needed** — `admin-web` already gates screen-by-screen on individual permissions (`applications/page.tsx` disables its button on `iam.platform.app.update`), so ungranted actions degrade to a disabled control naming the missing permission. Verify this rather than adding new gating.
- **Break-glass is a host command, not a standing permission.** `tools/break-glass-admin.ts` runs on the host, requires the bootstrap secret, creates or unlocks a client admin, and audits the action distinctly from a routine console operation. Rationale in Doc 11 §12 decision 4: a locked-out client on an air-gapped network with us unreachable must have a way back in, but it should not be a permission sitting in a role forever. *(If the alternative in that decision is chosen instead, this is one line in the seed — grant `iam.platform.client.admin.create` and drop the tool.)*
- The role is seeded only in `single_tenant` mode; a SaaS deployment is unaffected.
**Definition of Done:** e2e proves the role can read everything and write nothing; break-glass recovers a locked-out install and leaves an audit record.
**Suggested Commit Message:** `feat(iam): restricted on-prem platform role and audited break-glass admin recovery`

# Session 46 — Deployment-agnostic database configuration
**Goal:** Stop the DB layer assuming a Supabase pooler. `DATABASE_URL` is documented as the PgBouncer endpoint with prepared statements disabled accordingly; an on-premise Postgres has no pooler, both URLs are the same, and the decision should follow an explicit flag rather than an assumption about where the database lives (Doc 11 §8, gap 3).
**Expected Output:** One data source that is correct against Supabase, against a bundled container, and against a client's existing Postgres cluster.
**Files to Create:** `libs/db/src/data-source.spec.ts` (matrix over the supported combinations).
**Files to Modify:** `libs/db/src/data-source.ts` (prepared statements follow `DATABASE_POOLED`), `libs/config/src/env.schema.ts` (`DATABASE_POOLED`, richer `DATABASE_SSL` than a boolean — a client terminating TLS at their own Postgres needs a CA, not a yes/no), `.env.example`, `deploy/.env.template`, `docs/07-database-rls.md` §2 note.
**Dependencies:** Sessions 3, 5, 42
**Acceptance Criteria:**
- Both URLs pointing at the same non-pooled host is a supported, documented configuration — not a warning.
- Prepared statements are enabled when unpooled and disabled when pooled; the current Supabase behaviour is unchanged when `DATABASE_POOLED=true`, which must remain the managed default.
- TLS to a client-supplied Postgres works with a custom CA; the bundled-container case still needs no TLS config at all.
- The Doc 07 §5.1 two-role split is orthogonal to all of this and still enforced by `startup-checks.ts`.
**Definition of Done:** Integration tests green against a pooled and an unpooled Postgres; no behaviour change on the managed path.
**Suggested Commit Message:** `feat(db): explicit pooling and TLS configuration so one data source fits every deployment`

# Session 47 — SMTP password-reset delivery
**Goal:** Bind a real transport to the delivery port. `password-reset.delivery.ts` is deliberately a port with a logging default that refuses to print tokens in production — correct design, but nothing implements it, so password reset silently does nothing on any real deployment (Doc 11 §8, gap 6).
**Expected Output:** A self-hosted client points the IAM at their own SMTP relay and password reset works, with no egress beyond their relay.
**Files to Create:** `apps/iam-api/src/auth/smtp-password-reset.delivery.ts`, its unit tests against a fake transport.
**Files to Modify:** `apps/iam-api/src/auth/auth.module.ts` (bind SMTP when configured, keep the logging default otherwise), `libs/config/src/env.schema.ts` (`SMTP_*`, with the host treated as a secret-adjacent value in `redactEnv`), `.env.example`, `deploy/.env.template`.
**Dependencies:** Session 10
**Acceptance Criteria:**
- With SMTP unset, behaviour is exactly today's: the token is logged outside production, and production logs an error naming the misconfiguration **without** the token. That existing guard is not weakened — it is the only place in the codebase a credential reaches a log at all.
- Delivery failure never changes the endpoint's response: `/auth/password/reset-request` still answers 202 regardless, so the no-enumeration property of Session 10 survives.
- The transport is not in the request path — a hung relay cannot hold the endpoint open.
- The token appears in no audit payload (Doc 10 §8).
**Definition of Done:** Reset completes end-to-end against a local SMTP sink; the unconfigured path is unchanged, proven by the existing tests passing untouched.
**Suggested Commit Message:** `feat(auth): SMTP password-reset delivery behind the existing port`

# Session 48 — Entitlements & offline licence
**Goal:** Ceilings and term on the tenant, and a signed licence a self-hosted install can verify **offline** (Doc 11 §10). `client_application` carries `enabled` and a `config` jsonb today but no `expires_at` and no limits, so SaaS billing and self-hosted licensing have nowhere shared to read from.
**Expected Output:** One entitlement source serving both commercial models, and an expiry that degrades rather than detonates.
**Files to Create:** `libs/db/src/migrations/0019-entitlements.ts`, `apps/iam-api/src/licence/{licence.service.ts,licence.guard.ts}`, `tools/issue-licence.ts` (our signing side — never shipped in the bundle), `apps/iam-api-e2e/src/entitlements.e2e.ts`.
**Files to Modify:** `libs/db/src/entities/client-application.entity.ts` and `client.entity.ts` (`expires_at`, `max_users`, `max_sites`), `apps/iam-api/src/clients/client-applications.service.ts`, `users/users.service.ts` and `users/bulk-upload.service.ts` (user ceiling), `scopes/scopes.service.ts` (site ceiling — **not** keyed off `scope_node.kind`, per Doc 11 §10.1 and ADR 0002), `libs/config/src/env.schema.ts` (licence path + our public key), `apps/admin-web/src/components/shell/header.tsx` (expiry banner).
**Dependencies:** Sessions 15, 21, 44
**Acceptance Criteria:**
- **An expired licence blocks administrative writes but never blocks `/auth/*` or `/iam/permissions/resolve`.** This is the load-bearing criterion of the session: an IAM that stops issuing tokens is a plant that stops running, and no invoice is worth that (Doc 11 §10).
- Verification is offline — signature checked against a public key in the image, with no network call on any path.
- The console warns from 30 days out.
- Exceeding `max_users` fails the create with a clear, quotable error; the bulk upload reports it per row rather than failing the whole file.
- SaaS deployments read the same columns with no licence file present — absent licence means unlimited, not blocked.
- No DRM: the mechanism makes the honest path easy and is enforced contractually beyond that (Doc 11 §10).
**Definition of Done:** e2e over the matrix — valid, expiring, expired, absent — with the auth-and-resolve-still-work property asserted explicitly in the expired case.
**Suggested Commit Message:** `feat(iam): tenant entitlements with offline-verifiable licence and non-destructive expiry`

# Session 49 — Runbooks, upgrade testing & diagnostic bundle
**Goal:** Close the operational gaps (Doc 11 §8, gaps 7–8). A client applies their own upgrades, so the upgrade path must be tested rather than described; and support for an install we cannot see starts with a diagnostic bundle we can read.
**Expected Output:** Everything the handover kit still lacks, and a tested claim that upgrades work across a version gap.
**Files to Create:** `docs/runbooks/{install.md,backup-restore.md,upgrade.md,support.md}`, `tools/diagnostics.ts`, `apps/iam-api-e2e/src/upgrade-migration.e2e.ts`.
**Files to Modify:** `deploy/README.md`, `tools/build-bundle.mjs` (include the runbooks), `docs/11-deployment-models.md` (§5.3 checklist → shipped file references).
**Dependencies:** Sessions 43, 44, 45, 46, 47, 48
**Acceptance Criteria:**
- **Skipping versions works, and is tested**: a database migrated to an early version upgrades cleanly to head in one run. A client on 1.2 going to 1.9 will not stop at every release, and the migration runner's sequential application must be proven across that gap rather than assumed.
- The restore procedure is **executed** by a test, not merely written down — a backup taken, the volume destroyed, the restore run, and login working afterwards.
- `tools/diagnostics.ts` emits version, migration state, redacted config, recent logs and row counts, and **contains no secret** — assert against `SECRET_ENV_KEYS` so the redaction cannot drift.
- The support runbook states the Doc 11 §5.5 boundary explicitly, including what is out of scope.
- The upgrade runbook makes a backup step one and says the upgrade is unsupported without it.
**Definition of Done:** Cross-version migration e2e green; restore drill scripted and passing; a diagnostic bundle generated from a running stack and reviewed for leakage.
**Suggested Commit Message:** `docs(ops): install, backup, upgrade and support runbooks with tested restore and diagnostics`

---

## Phase 9 — Consumable IAM (products outside this repo)

> **Authority:** Doc 12. Doc 00 §7 chose a monorepo so PlantOps modules could share contracts without a publish-and-version dance, and Doc 08 §1 adds future modules as new `apps/*`. That reasoning still holds **for PlantOps modules**. It does not extend to unrelated products with independent release cadences, which is what this phase serves: they consume the IAM as a versioned dependency over HTTP and npm, not as workspace siblings.
>
> Nothing here is speculative packaging work. Sessions 50 and 51 are on the critical path for gatepass and visitor management too — those are the first consumers, whether they live in this repo or not.
>
> Two things are deliberately **not** sessions. `scope_node.kind` is an open fork recorded in ADR 0002 and closed by the gatepass spec, not by a session. The `aud` claim question (Doc 12 §5) is a conditional decision, not work.

# Session 50 — Split `auth-kit` into a framework-free core and adapters
**Goal:** Make server-side authorization usable outside NestJS. `libs/auth-kit` depends on `@nestjs/common` and `@nestjs/core`, so a Next.js route handler, an Express service or a Fastify one gets nothing from it — and the guard is the piece that enforces `@RequirePermission` (Doc 12 §4).
**Expected Output:** One verification-and-resolution core with no framework dependency, plus thin adapters that keep `iam-api`'s current usage byte-for-byte identical.
**Files to Create:** `libs/auth-kit/src/core/{verify.ts,resolve.ts,coverage.ts,index.ts}` (JWKS verification, grants fetch, `covers()` — no framework imports), `libs/auth-kit/src/adapters/nestjs/index.ts` (today's `AuthGuard`, `PermissionGuard`, `@RequirePermission`, `ScopeResolver`, re-exported unchanged), `libs/auth-kit/src/adapters/fetch/index.ts` (a `Request`-in, decision-out helper for Next.js route handlers and any WinterCG runtime), core unit tests with no Nest test harness.
**Files to Modify:** `libs/auth-kit/src/index.ts` (re-export both, so no existing import path breaks), `libs/auth-kit/package.json` (move `@nestjs/*` to `peerDependencies` and add subpath `exports` for `./core` and `./adapters/nestjs`), every `apps/iam-api` import site only if the barrel cannot keep them stable.
**Dependencies:** Session 23
**Acceptance Criteria:**
- **`libs/auth-kit/src/core/**` imports nothing from `@nestjs/*`** — enforced by a lint rule or an import test, not by review. This is the whole point of the session and it will regress silently otherwise.
- `iam-api`'s authorization behaviour is unchanged: the Session 23 authorization matrix e2e passes **unmodified**, including the `docs/adr/0001` connection strategy — the guard still opens its own `QueryRunner`, applies the RLS context and commits in a `finally`.
- The core is usable from a plain Node script with no Nest container: verify a token, resolve grants, answer a coverage question.
- Installing the package without NestJS present does not fail — `@nestjs/*` are peers, and the adapter is a subpath import.
- `ScopeResolver`'s coverage logic lives in core and is used by both adapters, not duplicated.
**Definition of Done:** `nx test auth-kit` green; a scratch Node script authorizes a request end-to-end without NestJS; iam-api's e2e battery unchanged.
**Suggested Commit Message:** `refactor(auth-kit): framework-free authorization core with NestJS and fetch adapters`

# Session 51 — Publishable shared libraries
**Goal:** Make the libs installable from outside this workspace. All five are `"private": true` at version `0.0.1`, and `web-kit` and `ui` publish **source** (`main: ./src/index.ts`) rather than a build — so an external repo cannot consume them at all (Doc 12 §3).
**Expected Output:** `@plantops/{contracts,iam-client,auth-kit,web-kit,ui}` installable from a private registry, versioned, with a documented release process.
**Files to Create:** `.npmrc` template for consumers, `docs/12-consuming-the-iam.md` companion release notes section, `.github/workflows/publish.yml` (tag-triggered, builds then publishes in dependency order), `CHANGELOG.md` per published lib.
**Files to Modify:** `libs/{contracts,iam-client,auth-kit,web-kit,ui}/package.json` (`private: false`, real version, `publishConfig`, `files`, `repository`, `license`), `libs/web-kit/package.json` and `libs/ui/package.json` (build to `dist`; `main`/`types`/`exports` point at the build, with the `@plantops/source` condition retained so in-workspace consumers still resolve to source), their `project.json`/build targets, `docs/08-nx-workspace-structure.md` §1 (a short note that libs are now published as well as imported in-workspace).
**Dependencies:** Session 50
**Acceptance Criteria:**
- `web-kit` and `ui` build to `dist` and are consumable by a plain `npm install` in a repo with no Nx and no path aliases — proven by installing the packed tarballs into a throwaway Next.js app, not by inspection.
- **In-workspace imports still resolve to source.** `admin-web` and `iam-api` must not start consuming stale `dist` builds; the `@plantops/source` export condition already in these manifests is what preserves that, and a test should pin it.
- Versions move together on a single release tag, and inter-lib dependency ranges are rewritten from `0.0.1` to the published version at pack time.
- `antd` and `react` stay `peerDependencies` on `web-kit`/`ui` — a consumer must not end up with two React copies.
- Publishing is tag-triggered and idempotent; re-running a published version fails loudly rather than overwriting.
- Boundary lint (Doc 08 §2) is unaffected — `contracts` still depends on nothing.
**Definition of Done:** A throwaway Next.js app outside this repo installs the packages, renders `PlantOpsProvider`, and completes a login against a running IAM.
**Suggested Commit Message:** `chore(libs): publish contracts, iam-client, auth-kit, web-kit and ui as versioned packages`

# Session 52 — Consumer integration guide & quickstart
**Goal:** The documentation an engineer outside this repo needs to put a product behind the IAM. Doc 12 states the model; this session ships the runnable path — the OpenAPI reference, a quickstart, and a working example app (Doc 12 §6).
**Expected Output:** A developer with no knowledge of this codebase integrates a new product in an afternoon.
**Files to Create:** `examples/nextjs-consumer/**` (a minimal Next.js app: login via `web-kit`, one server route authorized through `auth-kit`'s fetch adapter, nav rendered from `/iam/navigation?applicationId=`), `docs/quickstart-new-product.md` (register the application by manifest → enable for a client → verify tokens → authorize a route → render nav), `examples/README.md`.
**Files to Modify:** `tools/emit-openapi.ts` (publish the 44-path document as a browsable reference artifact rather than a checked-in file only), `README.md` (link the quickstart), `docs/12-consuming-the-iam.md` (point at the example rather than restating it).
**Dependencies:** Sessions 50, 51
**Acceptance Criteria:**
- The example app builds and runs in CI against an ephemeral IAM, and its login-plus-authorized-route path is asserted — a quickstart that rots is worse than none.
- The quickstart never instructs anyone to edit the IAM's code or run a migration: registering a product is a manifest upload and a `client_application` toggle (Doc 02 §8).
- Permission keys in the example are namespaced to the example's own application, demonstrating that `unique(application_id, key)` is what keeps products from colliding.
- The example verifies tokens against **JWKS**, never a shared secret, and the guide says why.
- The guide states the one-instance-versus-many decision (Doc 12 §5) plainly, including that a token carries no `aud` and is therefore valid at every application on its instance.
**Definition of Done:** CI builds and exercises the example; a reader following the quickstart on a clean machine reaches an authorized request.
**Suggested Commit Message:** `docs(consumers): integration guide, quickstart, and a runnable Next.js example`

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
S40 → S26, S27
S41 → S40 (and S39 if already run)
S42 → S41
S43 → S14, S23, S42
S44 → S8, S15, S42
S45 → S23, S44
S46 → S3, S5, S42
S47 → S10
S48 → S15, S21, S44
S49 → S43, S44, S45, S46, S47, S48
S50 → S23
S51 → S50
S52 → S50, S51
```

Parallelizable clusters (if two conversations run side by side): {S9, S10, S11} after S8; {S16, S17, S18} after S15; {S28, S30–S33, S36} after S27; {S43, S44, S46, S47} after S42 — though S44 touches the auth path and should not run beside anything else that does.

**Phase 8 does not depend on Session 39.** S39 delivers the managed Railway/Vercel path; S41 creates `apps/iam-api/Dockerfile` itself if S39 has not run. A pilot that is going out self-hosted can therefore go 38 → 40 → 41 → 42 and ship, deferring the managed deploy entirely.

**Phase 9 does not depend on Phase 8 at all.** S50 hangs off S23, which shipped. The two phases answer different questions — how the IAM is *delivered* versus how it is *consumed* — and can run in either order or side by side.

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

**Milestone 5 — Single-tenant Deliverable** (Sessions 40–49)
Deliverables: an origin-agnostic console; container images for both apps plus proxy and migration runner; an offline-installable bundle with idempotent bootstrap that creates both database roles; manifests applied by the release rather than by hand; single-tenant mode with a boot-pinned client; the restricted on-prem platform role and audited break-glass recovery; deployment-agnostic database and mail configuration; entitlements with an offline-verifiable licence; and the runbooks, tested restore, cross-version migration proof, and diagnostic bundle.
Exit test: on a clean VM with networking disabled, install from the tarball, log in without a tenant slug, upgrade across a version gap, and produce a diagnostic bundle containing no secret.

**Milestone 6 — Consumable IAM** (Sessions 50–52)
Deliverables: a framework-free authorization core with NestJS and fetch adapters; the five shared libs published as versioned packages consumable outside this workspace; and an integration guide with a runnable, CI-exercised example.
Exit test: a Next.js app in a separate repository installs the published packages, logs a user in, authorizes a server route, and renders its menu from the IAM — with no change to the IAM's code and no migration.

*Partial-credit checkpoint:* Sessions 40–42 alone are enough to hand a first client a working install — the slug and the licence are handled by hand for customer one. Sessions 43–49 are what make it repeatable rather than heroic.

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
| 40 | Origin-agnostic console | Low | 3–4 | Low | Sonnet |
| 41 | Container images + proxy + migrator | Medium | 5–7 | Medium | Sonnet |
| 42 | Offline bundle + bootstrap | Medium | 5–7 | **High** | Opus |
| 43 | Manifests as release artifacts | Medium | 4–6 | Medium | Sonnet |
| 44 | Single-tenant mode | Medium | 6–8 | **High** | Opus |
| 45 | On-prem role + break-glass | Low | 3–4 | Medium | Sonnet |
| 46 | Deployment-agnostic DB config | Low | 3–4 | Medium | Sonnet |
| 47 | SMTP delivery binding | Low | 3–5 | Low | Sonnet |
| 48 | Entitlements + licence | Medium | 6–8 | Medium | Opus |
| 49 | Runbooks + upgrade test + diagnostics | Medium | 6–8 | Medium | Sonnet |
| 50 | auth-kit core + adapters | Medium | 5–7 | **High** | Opus |
| 51 | Publishable shared libraries | Medium | 5–7 | Medium | Sonnet |
| 52 | Integration guide + example | Low | 4–6 | Low | Sonnet |

**Total: ~205–285 hours across 39 sessions**, plus **~44–61 hours** for single-tenant delivery (40–49) and **~14–20 hours** for consumability (50–52) — **~263–366 hours across 52 sessions.**

High-risk sessions (5, 9, 14, 16, 21–23) are the ones the spec itself flags as load-bearing — budget review time there and don't parallelize them with anything that touches the same tables.

Phase 8 adds two more. **Session 44** changes the login path, so it carries the same risk as Sessions 8 and 9 and its safety property is that `saas` mode stays byte-for-byte unchanged. **Session 42** is high-risk for a less obvious reason: it is where a self-hosted install can silently run the app as the table owner, which exempts it from every RLS policy in Doc 07. The bootstrap creating both roles correctly is the single most consequential line in the phase.

Phase 9 adds one. **Session 50** rearranges the module that decides every authorization answer in the system. It changes no behaviour by design, which is exactly what makes it dangerous — a refactor with no visible output is one where a regression hides easily. Its safety property is that Session 23's authorization matrix passes unmodified, and that is the criterion to check first, not last.
