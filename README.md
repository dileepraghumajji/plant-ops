# PlantOps IAM — Development Specification Suite

Agent-executable specification for building the **PlantOps IAM/RBAC service** — a standalone, multi-tenant, self-service identity & access management system that every PlantOps operational module (visitor, rooms, vehicle, patrol, gatepass) will depend on.

**Scope:** IAM/RBAC only. The shared kernel and the six operational modules are specified separately, later.

## Stack

NestJS · Supabase (as plain Postgres) · TypeORM · Next.js · Redis · **Nx monorepo**

> Supabase is used only as the Postgres host — **not** Supabase Auth (we issue our own JWTs) and **not** the Supabase SDK. TypeORM owns the schema; RLS is hand-written in migrations.

## The one idea that shapes everything

```
Effective access = WHO × WHAT × WHERE
   WHO   = user | service_account
   WHAT  = permission (runtime-registered per application)
   WHERE = scope node in the client's org tree (Group→Plant→Dept→Gate)
```

Plus: **everything is data** — applications, clients, menus, permissions are created at runtime through the admin UI; no deploy to onboard a client or launch an app.

## Quickstart (workspace)

```sh
npm install          # install all workspace deps
docker compose up -d # local Postgres (ltree available) + Redis
npm run migration:run             # apply the schema + bootstrap seed
npx nx serve @plantops/iam-api    # NestJS API → http://localhost:3000
npx nx dev @plantops/admin-web    # Next.js console → http://localhost:4200
```

The console has its own env file — the API's `.env` deliberately holds nothing a
browser reads:

```sh
cp apps/admin-web/.env.example apps/admin-web/.env.local   # NEXT_PUBLIC_IAM_API_URL
```

The API's paths are the ones Doc 06 §1 fixes — `/iam`, `/auth`, and the two ops
endpoints — with no global prefix:

```sh
curl localhost:3000/health   # liveness: 200 whatever the dependencies are doing
curl localhost:3000/ready    # readiness: 503 (naming the culprit) if PG or Redis is down
```

Useful workspace commands:

```sh
npx nx graph                    # visualize projects & dependencies
npx nx run-many -t build --all  # build everything
npx nx run-many -t test --all   # run all unit tests
npx nx run-many -t lint --all   # lint incl. module-boundary rules (Doc 08 §2)
```

Module boundaries (e.g. only `iam-api` may import `libs/db`) are enforced by
`@nx/enforce-module-boundaries` in [eslint.config.mjs](eslint.config.mjs) — see
[docs/fixtures/boundary-lint-check.md](docs/fixtures/boundary-lint-check.md).

## Read in order

| Doc | Title | Read it for |
|---|---|---|
| [00](00-system-overview.md) | System Overview & Principles | the philosophy, stack rationale, monorepo decision |
| [01](01-data-model.md) | Data Model | every table and the scope tree |
| [02](02-registry-multitenancy.md) | Registry & Multi-tenancy | runtime registration, admin tiers |
| [03](03-authentication.md) | Authentication | custom JWT, login, sessions, service accounts |
| [04](04-authorization-scope-resolution.md) | Authorization & Scope Resolution | the resolution algorithm + caching (the core) |
| [05](05-dynamic-navigation.md) | Dynamic Navigation | permission-driven menus |
| [06](06-api-surface.md) | API Surface | every endpoint |
| [07](07-database-rls.md) | Database & RLS | TypeORM + Supabase + hand-written RLS |
| [08](08-nx-workspace-structure.md) | Nx Workspace & Structure | monorepo layout, shared libs |
| [09](09-admin-ui-spec.md) | Admin UI Spec | the two consoles |
| [10](10-audit-governance.md) | Audit & Governance | append-only trail, retention |

## Suggested build order

1. **`libs/db` + `libs/contracts`** — schema, migrations, RLS, shared types (Docs 01, 07, 08).
2. **`iam-api` auth** — login, JWT, sessions, service accounts (Doc 03).
3. **`iam-api` registry** — applications, clients, manifest upsert (Doc 02, 06).
4. **`iam-api` authz** — resolution algorithm + Redis cache + invalidation (Doc 04) and `libs/auth-kit`.
5. **Dynamic navigation** endpoint (Doc 05).
6. **`admin-web`** — platform + client consoles (Doc 09).
7. **Audit** woven through all mutations (Doc 10).

Once this is built and proven, the kernel + Gatepass spec suite follows — Gatepass becomes a new `apps/*` that imports `contracts`, `auth-kit`, and `iam-client` and writes zero new authorization logic.

## The frontend libraries

`admin-web` is the first console, not the only one, so the parts a second console
would otherwise copy live in two libraries rather than in the app:

| Lib | What it is | Depends on |
|---|---|---|
| [`libs/ui`](libs/ui) | Presentation: the design tokens, the Ant Design 6 theme built from them, `AppShell`, `NavMenu`, the `nav_node.icon` registry, page/table/state patterns. Calls nothing. | `contracts` |
| [`libs/web-kit`](libs/web-kit) | The browser runtime: `IamClient` in React providers, the token store, silent refresh, `useGrants`/`usePermission`, `useNavigation`, error → toast. Renders nothing of its own. | `contracts`, `iam-client`, `ui` |

A gatepass or visitor console mounts `<PlantOpsProvider>` and `<AppShell>`, renders
its own `/iam/navigation` response through the same `<NavMenu>`, and writes only
its screens. The `scope:ui` / `scope:web` boundaries in the root ESLint config
keep the split honest — see [`docs/fixtures/boundary-lint-check.md`](docs/fixtures/boundary-lint-check.md).
