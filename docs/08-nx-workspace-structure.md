# 08 — Nx Workspace & Structure

> The monorepo layout, library boundaries, the shared contracts/guards that make the IAM consumable by future modules, and build/deploy. Rationale for Nx-over-separate-repos is in Doc 00 §7.

---

## 1. Workspace layout

```
plantops/
  apps/
    iam-api/            NestJS — the IAM service (this suite's deliverable)
    admin-web/          Next.js — platform + client admin consoles (Doc 09)
  libs/
    contracts/          framework-agnostic TS types & constants (the public contract)
    auth-kit/           NestJS guards, decorators, ScopeResolver, token verify
    db/                 TypeORM entities, migrations, RLS SQL, data-source
    iam-client/         typed client for calling the IAM (used by future modules)
    ui/                 shared Next.js/React components, design tokens
    config/             env schema, constants
  tools/                scripts (seed, manifest upload, key rotation)
  nx.json  tsconfig.base.json  package.json
```

Only **two apps** in this suite (`iam-api`, `admin-web`). Future operational modules (gatepass, visitor, …) will be added as new `apps/*` that depend on `libs/contracts`, `libs/auth-kit`, and `libs/iam-client` — which is the entire reason for the monorepo.

## 2. Library responsibilities & boundaries

| Lib | Contains | May depend on | Consumed by |
|---|---|---|---|
| `contracts` | JWT claim type, permission-key type, DTOs, resolve/nav response types, error codes | (nothing) | everyone |
| `auth-kit` | `AuthGuard`, `PermissionGuard`, `@RequirePermission`, `ScopeResolver`, JWKS verify | contracts | iam-api, future modules |
| `db` | entities, migrations, RLS migrations, TypeORM DataSource, RLS context helper | contracts | iam-api (only) |
| `iam-client` | typed HTTP client for `/iam/*` endpoints | contracts | future modules, admin-web |
| `ui` | shared React components, tokens | contracts | admin-web |
| `config` | env parsing/validation | contracts | apps |

**Boundary rules (enforced via Nx tags + lint):**
- `db` is imported **only** by `iam-api`. No other app touches IAM tables directly — they call the API. This preserves the "IAM is the authority" property even inside the monorepo.
- `contracts` depends on nothing and is depended on by everything (no cycles).
- Apps never import other apps.

Tag scheme — each project gets **two** tags, a `type:*` and a `scope:*`, plus `iam-api` carries an extra identifying tag so the db rule can name it precisely (Nx `depConstraints` match on tags, and cannot express "exactly one project" without one):

```
apps/iam-api:    type:app,  app:iam-api
apps/admin-web:  type:app
libs/*:          type:lib,  scope:contracts|auth|db|client|ui|config
```

`@nx/enforce-module-boundaries` `depConstraints` (in the root ESLint config):

```jsonc
{
  "depConstraints": [
    // db is importable ONLY by iam-api — the onlyDependOnLibsWithTags list for
    // scope:db consumers is empty; instead we allow-list the consumer:
    { "sourceTag": "app:iam-api", "onlyDependOnLibsWithTags": ["scope:db", "scope:auth", "scope:contracts", "scope:client", "scope:config"] },
    { "sourceTag": "type:app",    "onlyDependOnLibsWithTags": ["type:lib"] },
    // No sourceTag other than app:iam-api lists scope:db, so any non-iam-api
    // project importing libs/db fails lint. Reinforce from the db side:
    { "sourceTag": "scope:db",    "onlyDependOnLibsWithTags": ["scope:contracts"] },
    { "sourceTag": "scope:contracts", "onlyDependOnLibsWithTags": [] }
  ]
}
```

The guarantee that only `iam-api` imports `scope:db` comes from **omitting `scope:db` from every `onlyDependOnLibsWithTags` list except `app:iam-api`'s**. Because `admin-web` is only `type:app` (no `app:iam-api` tag), its allow-list (`type:lib`) still permits libs in general — so add a second, tighter rule if you want to *forbid* admin-web from db explicitly: `{ "sourceTag": "type:app", "notDependOnLibsWithTags": ["scope:db"] }` combined with the `app:iam-api` allow above (Nx evaluates all matching constraints; the `notDependOnLibsWithTags` on the broad `type:app` tag blocks db for every app, and the specific `app:iam-api` allow does not re-grant it — so instead, drop the blanket block and rely solely on allow-lists: **only** `app:iam-api`'s constraint names `scope:db`, and Nx denies any dependency not permitted by *some* matching constraint). Net rule to implement and test (Doc 08 §7): a build of `admin-web` or any future module that imports from `libs/db` must **fail** `nx lint`.

## 3. What `contracts` exports (the public API of the IAM)

This is the single source of truth every future module imports. Keep it stable and versioned.

```ts
// identity
type JwtClaims = { iss; sub; sty:'user'|'service'; cid; sid; iat; exp };

// resolution
type ResolvedGrants = {
  permissions: string[];
  scopes: Record<string /*permKey*/, string[] /*ltree paths*/>;
};
type NavNodeDTO = { id; kind:'module'|'menu'|'sub_menu'; key; label; route?; icon?; children:NavNodeDTO[] };

// errors
enum IamErrorCode { VALIDATION_FAILED, AUTH_REQUIRED, PERMISSION_DENIED, SCOPE_DENIED, ACCOUNT_LOCKED, ... }
```

Permission keys are **data** (Doc 02), so `contracts` does not enumerate them as the source of truth; it may re-export a *generated* constants file produced from application manifests for editor autocomplete in consumers — clearly marked as generated.

## 4. `auth-kit` — the reusable guard layer

The abstraction that lets every future module authorize with one decorator:

```ts
@RequirePermission('gatepass.dc.approve', { scopeFrom: 'params.gateId' })
```

`auth-kit` provides:
- `AuthGuard` — verifies JWT via JWKS (cached keys), checks `sid` not revoked.
- `PermissionGuard` — loads `ResolvedGrants` (via `iam-client`, cached), checks permission + scope coverage (Doc 04 §4.2/§8).
- `ScopeResolver` — helper to turn a request-referenced entity (a gate id) into a scope path and test coverage; and to hand modules the `allowedPaths` for query narrowing (Doc 04 §5).

Because `auth-kit` lives in `libs/`, the IAM itself and every future module use the **same** guard code — no drift.

## 5. Environments & config

- `config` defines a validated env schema (fail fast on boot): DB pooler URL, DB direct URL (migrations), Redis URL, JWT private key / key id, JWKS, token TTLs, platform bootstrap secret.
- Separate `.env` per environment; secrets from the platform's secret store, never committed.

## 6. Build & deploy

- Nx caches builds; CI runs `nx affected` to build/test only what changed.
- `iam-api`: containerized NestJS; deploy to Railway (per stack choice). Runs migrations on release (a dedicated migration step using the **direct** DB URL, not the pooler).
- `admin-web`: Next.js; deploy to Vercel or Railway.
- Redis: managed instance.
- Health/readiness endpoints (Doc 06 §13) wired to the platform's checks.

## 7. Testing structure

- `contracts`: type-level tests.
- `auth-kit`: unit tests for coverage/scope logic (the highest-risk code — test the `covers()` prefix logic and deny-by-default thoroughly).
- `iam-api`: e2e tests for auth flows, registry upserts, resolution correctness, and **RLS isolation** (a cross-tenant read must fail at the DB even with a coding mistake).
- Seed/manifest scripts have their own smoke tests.

## 8. Why this structure serves the roadmap

When Gatepass is built next, it is a new `apps/gatepass-api` that imports `contracts` (types), `auth-kit` (guards), and `iam-client` (to resolve grants). It writes **zero** new authorization logic and cannot touch IAM tables. That is the payoff of doing IAM first, in an Nx monorepo, with these boundaries.
