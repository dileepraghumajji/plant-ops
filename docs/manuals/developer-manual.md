# Developer Manual

**Who this is for:** anyone writing code in this repository, or building a
PlantOps application on top of the IAM.

**What it gives you:** the mental model, the code map, the request pipeline, the
rules that must not be broken and why, and a recipe for plugging a new
application in without writing a line of authorization logic.

The specification suite in [`docs/`](../) (00–10) is the authority. This manual
is the orientation and the day-to-day; where the two disagree, the spec wins and
this file needs fixing.

---

## 1. What the system is

A standalone, multi-tenant IAM service. Every PlantOps operational module —
gatepass, visitor, rooms, vehicle, patrol — depends on it and none of them
reimplements authorization.

```
Effective access  =  WHO  ×  WHAT  ×  WHERE
   WHO    subject: user | service_account
   WHAT   permission, registered per application at runtime
   WHERE  scope node in the client's org tree (Group → Plant → Dept → Gate)
```

Two properties fall out of that and drive nearly every design decision:

**Everything is data.** Applications, permissions, nav trees, clients, roles,
scopes — all runtime rows. Onboarding a tenant or launching an application is an
API call, never a migration and never a deploy. If you find yourself adding a
permission key to an `enum` as a *source of truth*, stop: that is the design
failing.

**Scope is a materialized path.** `scope_node.path` is a real PostgreSQL `ltree`
(`acme.pune.north_gate`). Coverage is therefore a prefix test — `target <@
binding_path` — which makes both the point check and query-narrowing cheap SQL
rather than a tree walk.

### The stack, and the two things people get wrong about it

NestJS · PostgreSQL (hosted on Supabase) · TypeORM · Next.js 16 · Redis · Nx
monorepo · Ant Design 6.

1. **Supabase is a Postgres host, nothing more.** Not Supabase Auth, not the
   Supabase SDK. We issue our own JWTs, because the WHERE dimension and the
   revocation semantics are not expressible in a provider's token model.
2. **RLS is hand-written SQL in migrations.** TypeORM owns entities and
   migrations; it does not own the policies. `synchronize` is off everywhere.

---

## 2. Repository map

```
apps/
  iam-api/          NestJS — the IAM service
  admin-web/        Next.js — platform + client consoles (one app, two menus)
  iam-api-e2e/      end-to-end suite
libs/
  contracts/        framework-agnostic types & constants. Depends on nothing.
  config/           validated env schema, key rotation helpers
  db/               TypeORM entities, migrations, RLS SQL, RLS context helper
  auth-kit/         AuthGuard, PermissionGuard, @RequirePermission, ScopeResolver
  iam-client/       typed HTTP client for /iam/* (browser + node)
  ui/               design tokens, AntD theme, AppShell, table/page patterns
  web-kit/          browser runtime: providers, token store, useGrants/useNavigation
tools/              manifest upload/seed, key rotation, OpenAPI emit, db role SQL
docs/               the spec suite (00–10), roadmap, local-testing, ADRs, manuals
```

### Boundaries, and the one that matters most

Enforced by `@nx/enforce-module-boundaries` in
[eslint.config.mjs](../../eslint.config.mjs) via project tags:

| Project | Tags | May depend on |
|---|---|---|
| `iam-api` | `type:app`, `app:iam-api` | `scope:db`, `scope:auth`, `scope:contracts`, `scope:client`, `scope:config` |
| `admin-web` | `type:app` | `type:lib` — **not** `scope:db` |
| `libs/db` | `type:lib`, `scope:db` | `scope:contracts` only |
| `libs/contracts` | `type:lib`, `scope:contracts` | nothing |

> **`libs/db` is importable by `iam-api` and by nothing else.** No other app —
> including every future operational module — touches IAM tables. They call the
> API. This is what preserves "the IAM is the authority" *inside* a monorepo,
> and `nx lint` fails on violation. See
> [docs/fixtures/boundary-lint-check.md](../fixtures/boundary-lint-check.md).

The frontend split is worth internalising too: `libs/ui` renders and calls
nothing; `libs/web-kit` calls and renders nothing. A second console (gatepass,
visitor) mounts `<PlantOpsProvider>` and `<AppShell>` and gets auth, dynamic nav
and the design language for free.

---

## 3. Running it locally

The machine-specific walkthrough — with the exact Postgres and Redis start
commands, database credentials and the bootstrap sequence — is
[docs/local-testing.md](../local-testing.md), which was executed end-to-end and
works as written. Condensed:

```sh
npm install
# start Postgres and Redis (see local-testing.md §1)
npm run migration:run                       # schema + bootstrap seed
npm run manifest:seed-iam                   # the IAM's own catalog — no menu without it
cp apps/admin-web/.env.example apps/admin-web/.env.local

npx nx run @plantops/iam-api:serve          # http://localhost:3000
npx nx dev @plantops/admin-web              # http://localhost:4200
```

Then create a human platform admin and a test tenant — local-testing.md §4, two
`curl` sequences.

**Things that will confuse you once, each:**

- **Redis is optional.** Without it the grants cache misses through to Postgres
  and revocation falls back to the `session` table. `Revocation cache
  unavailable` in the log is expected, not a fault. Several `iam-api` integration
  suites currently fail *when Redis is up*, because their fixtures insert
  `role_binding` rows in raw SQL and skip the invalidation hook — a fixture
  defect, not a product one. Check whether Redis is running before diagnosing a
  red suite.
- **Everything lives in the `iam` schema**, not `public`, and `"user"` needs
  quoting.
- **psql shows you fewer rows than you expect.** The `plantops` role is
  deliberately not superuser and not BYPASSRLS. That is isolation working.
- **The API refuses to start** with *"cannot enforce row-level security"* after
  some `libs/db` suites, which leave `force row level security` off. Restore it:
  `npx nx run @plantops/db:test -- --testPathPatterns "rls-isolation"`.
- **CORS**: the API's `.env` needs `CORS_ALLOWED_ORIGINS=http://localhost:4200`
  or every console request dies before it is sent.

### Everyday commands

```sh
npx nx graph                             # project & dependency graph
npx nx run-many -t build --all
npx nx run-many -t test --all
npx nx run-many -t lint --all            # includes the boundary rules
npx nx affected -t test                  # what CI should run
npm run openapi                          # regenerate apps/iam-api/openapi.json
npx nx run @plantops/iam-api:openapi:check   # fails if it is stale
npm run keys:rotate                      # JWKS rotation (ordering is mandatory)
npm run manifest:upload                  # upload an application manifest
```

Always go through `nx`, always prefixed with the package manager. The
`nx-workspace` skill has the querying patterns.

---

## 4. How a request actually flows

This is the part to hold in your head. Ten steps, and three of them are places
people introduce security bugs.

```
1  request-id middleware            → correlates response, logs and audit
2  body-parser middleware           → per-route ceilings (64 kB / 1 MB / 4 MB)
3  ThrottlerGuard                   → 429 RATE_LIMITED in the standard envelope
4  AuthGuard (libs/auth-kit)        → JWKS verify (kid), exp ±60 s leeway,
                                       sid not revoked → VerifiedClaims
5  PermissionGuard                  → grants from cache; permission held?
                                       scope target resolved from the request;
                                       coverage test; denial audited
6  TenantContextInterceptor         → opens the txn, applies the RLS context
                                       from the *token object* — never from req
7  ValidationPipe (zod)             → 400 VALIDATION_FAILED with field detail
8  controller → service             → business logic, inside that txn
9  AuditService.record(...)         → same transaction as the change
10 HttpExceptionFilter              → { error: { code, message, requestId } }
```

**Step 4/5 vs step 6 — the connection question.** Guards run *before* the
per-request transaction, so on a cache miss the resolver cannot use the ambient
transaction, and a query on a bare pooled connection would match nothing under
RLS. `resolve()` therefore takes an explicit executor: handlers pass the request
transaction; the guard opens a short-lived connection with the RLS context
applied from verified claims and releases it before the handler's transaction
opens. The reasoning is in
[docs/adr/0001-permission-guard-connection-strategy.md](../adr/0001-permission-guard-connection-strategy.md).

**Step 6 — the single most important line in the codebase.** `client_id` and
`sub` come *exclusively* from verified JWT claims. Never from a body, header,
query or path. `libs/db/src/rls-context.ts` accepts only the AuthGuard's token
object, so feeding it from `req` is structurally impossible rather than merely
discouraged, and a lint gate blocks any other call into `set_config`. One code
path that trusts a request-supplied `client_id` collapses tenant isolation
silently and completely.

**Step 9 — same transaction, always.** A committed change with no audit record is
drift; an audit record with no committed change is a lie. Denials (403) are
written by a guard-level writer outside the business transaction — best-effort,
but never silently dropped.

---

## 5. The subsystems, and where they live

| Subsystem | Where | What to know |
|---|---|---|
| **Tokens & JWKS** | `apps/iam-api/src/auth`, `tools/rotate-keys.ts` | RS256 with `kid`. Access 15 min, refresh 7 days, service tokens 5 min. Claims are exactly `iss, sub, sty, cid, sid, iat, exp` — **never** permissions or roles, so a grant change takes effect on invalidation rather than on token expiry. Rotation order is mandatory: publish public key → wait a JWKS TTL → switch signer → retain old public key ≥ max access TTL |
| **Login & sessions** | `auth/auth.service.ts`, `session.service.ts` | argon2id. Unknown user and bad password are indistinguishable (401); locked is a distinct 423 and the console must not flatten it. Refresh rotates, with reuse detection and a ~15 s grace window so two tabs racing a refresh do not look like a compromise |
| **Resolution engine** | `apps/iam-api/src/authz` | `resolver.service.ts` builds `{ permissions[], scopes{perm → paths[]} }`; paths are **minimized** (drop a descendant when an ancestor is present) before caching. `grants-cache.service.ts` is Redis with a per-(client,subject) version counter — a version mismatch is a miss, which avoids enumerating subjects on role changes |
| **Invalidation** | `authz/invalidation.service.ts`, `expiry-sweep.job.ts` | Every mapping change invalidates. Scope moves: `BEGIN → single-statement subtree rewrite (REPEATABLE READ) → COMMIT → publish invalidation`. Never invalidate before commit — a reader repopulates from the old tree and re-poisons the cache. Expiry fires no event (time is not a hook), so a sweep job handles it |
| **Guards for consumers** | `libs/auth-kit` | `@RequirePermission('gatepass.dc.approve', { scopeFrom: 'params.gateId' })`, plus `ScopeResolver` for coverage tests and `allowedPaths` query narrowing |
| **Navigation** | `apps/iam-api/src/navigation` | Pure function of grants + catalog. Leaf visible iff it holds one mapped permission (OR); container visible iff a descendant leaf is; **unmapped leaf is hidden** unless `is_public`. Nav is permission-based, never scope-based — scope filters data *inside* a screen |
| **Registry & manifest** | `apps/iam-api/src/registry` | Manifest upsert is transactional and idempotent, keyed by `(application, key)`. Removals soft-deactivate. `?dryRun=true` produces the console's diff via the same code path |
| **Audit** | `apps/iam-api/src/audit`, `libs/db` migration 0010 | `iam.write_audit` is `SECURITY DEFINER`; the app role has no INSERT/UPDATE/DELETE/TRUNCATE on `audit_trail`. Actor and client are stamped from session vars, so a record cannot be forged from the service layer. Read is filtered by the `audit_trail_read` policy alone — never by a `?tier=` parameter |
| **RLS & schema** | `libs/db/src/migrations` | Every tenant table `force row level security`. Startup asserts the connection role is non-superuser, non-BYPASSRLS **and owns no `iam` table** — ownership exempts a role from its own policies, so the first two checks alone prove nothing |
| **Console runtime** | `libs/web-kit` | Token store, silent refresh, `useGrants`/`usePermission`/`useNavigation`, error → toast. Permission-aware controls are UX only; the server enforces |

---

## 6. Invariants — the things that must not break

Every one of these is load-bearing. If a change requires breaking one, the change
is wrong or the spec needs amending first.

1. **Tenant context is JWT-sourced only.** (§4, step 6.)
2. **`libs/db` is imported by `iam-api` and by nothing else.**
3. **Deny by default.** No binding ⇒ no access. An unmapped nav leaf is hidden.
   Inheritance exists on the *scope* axis only — never across permissions.
4. **Audit is append-only, and written in the same transaction as the change.**
   No UPDATE/DELETE path exists at any layer.
5. **The JWT carries identity, not authority.** No permissions in the token.
6. **Permission keys are data.** Consumers may reference known keys as constants;
   the IAM never enumerates them as the source of truth.
7. **Navigation is never a static file.**
8. **Secrets are shown once and stored hashed** — service-account secrets,
   passwords, refresh tokens. Never in logs, never in `audit_trail.payload`. The
   single deliberate exception is the dev-only password-reset logger, which
   refuses in production by design.
9. **Cross-tenant safety at the write path:** a role may only map permissions of
   applications enabled for its client; a binding's scope node must belong to the
   role's client; a subject may only hold roles of its own client.
10. **Prefer under-privileging on uncertainty.** A stale cache that lost a path
    denies — safe. One that gained a path grants — not safe. Ordering decisions
    follow from this.

---

## 7. Adding an endpoint — the checklist

1. **Spec first.** Doc 06 fixes the surface; this document is the specification
   and `openapi.json` is a projection of the implementation. Where they disagree
   the implementation is wrong.
2. DTOs as zod schemas; types into `libs/contracts` if any consumer needs them.
3. Gate it: `@RequirePermission('iam.<tier>.<resource>.<action>')`, with
   `scopeFrom` where a tenant scope target exists.
4. Add the permission to `tools/iam-manifest.json`, map it to a nav node if it
   has a screen, and re-run `npm run manifest:seed-iam`. **The IAM dogfoods its
   own registry** — a permission that is not in the manifest cannot be granted.
5. Write the audit record in the same transaction, action from the Doc 10 §4
   catalog (extend the catalog if genuinely new).
6. Invalidate if the change can alter anyone's grants (Doc 04 §7 table).
7. Errors through `IamException` and the closed code table — the envelope is
   `{ error: { code, message, requestId } }` and consumers branch on `code`.
8. Tests: unit for logic, integration for RLS and cross-tenant refusal. "Tested"
   is part of done, not a later session.
9. `npm run openapi`, and confirm `openapi:check` is green.
10. Add the screen in `admin-web` only after the API is gated — hiding a control
    is UX, not enforcement.

---

## 8. Building a new application on top (the payoff)

Gatepass is `apps/gatepass-api` + optionally `apps/gatepass-web`. It writes
**zero** authorization logic and **cannot** touch IAM tables.

**Back end**

```ts
// 1. Verify locally via JWKS — do not put the IAM on your per-request path.
// 2. Resolve grants through the typed client; it caches.
const iam = new IamClient({ baseUrl: process.env.IAM_URL });

// 3. Gate handlers with the shared decorator.
@RequirePermission('gatepass.dc.approve', { scopeFrom: 'params.gateId' })
async approve(@Param('gateId') gateId: string) { … }

// 4. Narrow list queries by covered scope instead of filtering in code.
const allowed = grants.scopes['gatepass.dc.read'];
// where dc.gate_path <@ any($1)
```

**Front end** — mount `<PlantOpsProvider>` and `<AppShell>` from `libs/web-kit`
and `libs/ui`. You get login, silent refresh, the dynamic menu, the design
language and error toasts. Render the tree from `/iam/navigation`; never keep
menu constants.

**Registration** — ship a manifest with your permissions and nav tree, and have
a platform admin upload it. Every release that adds a screen or an ability adds
it to the manifest; the platform admin previews the diff and confirms. No IAM
code changes, ever, for a new application.

**Service-to-service** — get a service account, exchange key+secret at
`POST /auth/token`, bind it to a role at the narrowest scope that works. Service
tokens are ephemeral and unrevokable mid-token (≤5 min exposure by design); if an
integration needs instant kill, issue it a session-backed token instead.

**What you must not do:** import `libs/db` (lint fails), read IAM tables, cache
grants without honoring invalidation, or trust anything a client sends about
identity or tenancy.

### 8.1 If the product lives outside this repository

Everything above assumes `apps/gatepass-api` — a workspace sibling. That is right
for PlantOps modules, which share this IAM's contracts and ship on its cadence
(Doc 00 §7). It is **not** right for an unrelated product with its own release
schedule, which should consume the IAM as a versioned dependency instead.

The mechanism is unchanged and already domain-neutral: `resolver.service.ts`
never reads `scope_node.kind`, coverage is `ltree` containment on `path` alone,
and `unique(application_id, key)` keeps two products' permission catalogues from
colliding. A CRM's *Region → Branch → Team* resolves through the identical code
as *Group → Plant → Gate*.

Two things block it today, both packaging rather than capability:

- **`auth-kit` is Nest-only.** `@nestjs/common` and `@nestjs/core` are hard
  dependencies, so a Next.js route handler gets nothing from the module that
  enforces `@RequirePermission`. Session 50 splits it into a framework-free core
  plus adapters — and the package boundary is the part that cannot be changed
  later without breaking every consumer, which is why it precedes publishing.
- **The libs are not installable.** All five are `"private": true` at `0.0.1`,
  and `web-kit`/`ui` set `main: ./src/index.ts` — they ship source, relying on the
  consumer's bundler and tsconfig paths. Session 51 fixes this.

`libs/web-kit` imports nothing from `next`, by design — its header says redirects
are callbacks precisely so no consumer is pinned to one router. So the React side
already works anywhere once it is installable.

**Decide deliberately: one IAM instance or several.** Tokens carry no `aud`
claim (Doc 03 §2), so a token issued by an instance is valid at *every*
application registered on it. For products serving the same people that is real
SSO for free; for unrelated products it means a token minted for one is accepted
by the other, and one outage takes down everything. [Doc
12 §5](../12-consuming-the-iam.md) has the trade-off in full.

---

## 9. Testing

| Layer | What it must prove |
|---|---|
| `contracts` | Type-level assertions; the error-code table matches Doc 06 §2 exactly |
| `auth-kit` | The `covers()` prefix logic and deny-by-default — the highest-risk code in the repo |
| `libs/db` | Every invariant in Doc 01 §6 has a failing-insert test; RLS isolation runs **as the app role**, never as the owner |
| `iam-api` | Auth flows, registry upserts, resolution correctness, cross-tenant reads returning zero rows even from deliberately buggy queries |
| Tools | Smoke tests for seed and manifest scripts |

The RLS suites are the ones to run when in doubt: they are the difference between
believing in isolation and having evidence of it.

---

## 10. Configuration and operations

Full schema in `libs/config/src/env.schema.ts`; the app fails fast on boot rather
than starting misconfigured. The ones you will actually touch:

| Variable | Default | Note |
|---|---|---|
| `DATABASE_URL` / `DATABASE_DIRECT_URL` | — | Pooler vs direct. They differ by **role**, not only endpoint: an owner role for migrations, a non-owner `app_role` for requests |
| `REDIS_URL` | — | Optional in dev |
| `ACCESS_TOKEN_TTL_SECONDS` | 900 | |
| `REFRESH_TOKEN_TTL_SECONDS` | 604800 | |
| `SERVICE_TOKEN_TTL_SECONDS` | 300 | The service-account revocation window |
| `REFRESH_REUSE_GRACE_SECONDS` | 15 | The two-tabs race window |
| `GRANTS_CACHE_TTL_SECONDS` | 600 | Safety net; invalidation is the primary freshness mechanism |
| `EXPIRY_SWEEP_INTERVAL_SECONDS` | 60 | Time is not a hook |
| `LOGIN_MAX_FAILED_ATTEMPTS` | 5 | Produces the 423 state |
| `PASSWORD_RESET_TTL_SECONDS` | 3600 | |
| `RATE_LIMIT_*`, `*_BODY_LIMIT_BYTES` | see `.env.example` | 64 kB default, 1 MB bulk, 4 MB manifest |
| `PLATFORM_BOOTSTRAP_SECRET` | — | Creates the first identity in an environment. Vault it |
| `OPENAPI_ENABLED` | false | `GET /openapi.json` 404s when off |
| `CORS_ALLOWED_ORIGINS` | — | The console cannot talk to the API without it |

`GET /health` is liveness (200 regardless of dependencies); `GET /ready` is
readiness and returns 503 **naming the failing dependency**. Both are exempt from
the error envelope — a probe consumes status codes.

---

## 11. Known gaps

| Gap | Detail |
|---|---|
| **No live environment yet** | The deploy path exists and is documented — [`apps/iam-api/Dockerfile`](../../apps/iam-api/Dockerfile), the three-job pipeline in [`ci.yml`](../../.github/workflows/ci.yml), the migration release step in [`release-migrate.ts`](../../tools/release-migrate.ts), and [`ops-runbook.md`](../ops-runbook.md) — but nothing has been stood up against real Supabase and Redis. §5 of the runbook is the checklist |
| **CI does not publish images** | The image job proves the Dockerfile builds; Railway builds what it deploys, and no version is reported at runtime. Session 41 |
| **Phase 8 — single-tenant delivery** (40–49) | No installable artifact. `admin-web` bakes its API URL in at build time (`api-config.ts`), so one build cannot serve two hostnames; there is no single-tenant mode, no entitlements, and no upgrade or restore runbook. See [Doc 11](../11-deployment-models.md) |
| **Phase 9 — consumability** (50–52) | `auth-kit` hard-depends on `@nestjs/*`, so nothing outside Nest can use the guard; all five libs are `private: true`, and `web-kit`/`ui` publish source rather than a build. See [Doc 12](../12-consuming-the-iam.md) |
| **Password-reset delivery** | `PASSWORD_RESET_DELIVERY` is a port with a dev-only logging binding. Production logs an error and sends nothing. Bind a real channel |
| **Human platform admin** | Two-step (create user in `platform`, then bind the Platform Admin role). Worth an endpoint or a seed flag |
| **Integration-suite fixtures** | Some insert `role_binding` rows in raw SQL and skip invalidation, so they fail when Redis is up. Fix the fixtures, not the product |

---

## 12. Where to look things up

| Question | File |
|---|---|
| Why is it built this way? | [docs/00-system-overview.md](../00-system-overview.md) |
| What tables exist, what constraints? | [01](../01-data-model.md), [07](../07-database-rls.md) |
| How does registration work? | [02](../02-registry-multitenancy.md) |
| Token, session, refresh semantics | [03](../03-authentication.md) |
| The resolution algorithm and cache | [04](../04-authorization-scope-resolution.md) — read §7.1 before touching scope moves |
| Nav visibility rules | [05](../05-dynamic-navigation.md) |
| Every endpoint and error code | [06](../06-api-surface.md) |
| Boundaries, tags, deploy shape | [08](../08-nx-workspace-structure.md) |
| Screen-by-screen intent | [09](../09-admin-ui-spec.md) |
| What is audited, and retention | [10](../10-audit-governance.md) |
| Dedicated vs self-hosted, licensing | [11](../11-deployment-models.md) — §6 for which console a client gets |
| Using the IAM from another repository | [12](../12-consuming-the-iam.md) |
| Running it on this machine | [local-testing.md](../local-testing.md) |
| Session-by-session build history | [implementation-roadmap.md](../implementation-roadmap.md) |
| Decisions with reasoning | [docs/adr/](../adr/) |

A note on the code itself: the file-header comments in `apps/admin-web` and
`apps/iam-api` explain *why* a screen or module is shaped the way it is, and
usually cite the spec section. They are the fastest way into an unfamiliar file —
read the header before the implementation.
