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

That step matters locally and almost nowhere else. Unset, the console calls the
same-origin path `/api`, which is what lets one build serve any hostname (Doc 11
§3): nothing customer-specific is baked into the bundle, and the proxy in front
maps `/api` to the API. Local development is the case where that does not hold —
the console is on 4200, the API is on 3000, nothing proxies between them — so
here the variable names the API outright, and the API's `CORS_ALLOWED_ORIGINS`
names the console back.

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
npx nx run-many -t e2e          # the hardening battery — see below
```

## The hardening battery

[`apps/iam-api-e2e`](apps/iam-api-e2e) is the regression wall for the properties
that are expensive to get wrong: cross-tenant isolation at the database, the auth
lifecycle end to end, resolution correctness, who may call what, cache
invalidation, and the module boundaries. It is the one suite that runs against
the **built bundle over a real socket**, with a real Postgres and a real Redis —
everything else in the workspace tests the code in-process, with fakes.

```sh
docker compose up -d postgres redis   # or see docs/local-testing.md §1
npx nx run-many -t e2e                # migrates, builds, boots, runs, stops
```

| File | Proves |
|---|---|
| [`rls-isolation.e2e.ts`](apps/iam-api-e2e/src/rls-isolation.e2e.ts) | a deliberately unfiltered query still returns one tenant's rows (Doc 07 §5–6) |
| [`auth-flows.e2e.ts`](apps/iam-api-e2e/src/auth-flows.e2e.ts) | login, lockout, revocation, refresh rotation and reuse, reset, service tokens (Doc 03) |
| [`resolution-matrix.e2e.ts`](apps/iam-api-e2e/src/resolution-matrix.e2e.ts) | ancestor coverage, minimisation, expiry, disabled apps, deny-by-default (Doc 04 §4–6) |
| [`authorization-matrix.e2e.ts`](apps/iam-api-e2e/src/authorization-matrix.e2e.ts) | every subject class × endpoint class, and denials audited (Doc 04 §8–9, Doc 10 §3) |
| [`invalidation.e2e.ts`](apps/iam-api-e2e/src/invalidation.e2e.ts) | every row of the Doc 04 §7 table takes effect immediately, not via TTL |
| [`load-smoke.e2e.ts`](apps/iam-api-e2e/src/load-smoke.e2e.ts) | a cached resolve never reads the resolution tables, under concurrent load |
| [`boundary-lint.e2e.ts`](apps/iam-api-e2e/src/boundary-lint.e2e.ts) | Doc 08 §2's boundaries refuse the imports they are supposed to |

Running notes — the tenants it creates, the configuration it deviates on, and
where the API's log goes — are in
[`docs/local-testing.md`](docs/local-testing.md) §4.5.

Module boundaries (e.g. only `iam-api` may import `libs/db`) are enforced by
`@nx/enforce-module-boundaries` in [eslint.config.mjs](eslint.config.mjs) — see
[docs/fixtures/boundary-lint-check.md](docs/fixtures/boundary-lint-check.md).

## Deploying

The managed platform is `iam-api` on Railway, `admin-web` on Vercel, Postgres on
Supabase and a managed Redis (Doc 08 §6).
[`docs/ops-runbook.md`](docs/ops-runbook.md) is the operational authority —
standing up an environment, the release ordering, key rotation, and what to
check when paged. The short version:

| Piece | Where | What it does |
|---|---|---|
| [`.github/workflows/ci.yml`](.github/workflows/ci.yml) | GitHub Actions | `nx affected` lint/test/build, the hardening battery against a real Postgres and Redis, an image build, then — on `main` only — migrations followed by the app swap |
| [`apps/iam-api/Dockerfile`](apps/iam-api/Dockerfile) | Railway | Builds the workspace, prunes it to the bundle plus its runtime dependencies, and ships that. No `.env`, no keys, no customer-specific value |
| [`tools/release-migrate.ts`](tools/release-migrate.ts) | the release job | Applies migrations over the **direct** URL under an advisory lock, validating only the three variables a migration actually uses |
| [`railway.json`](railway.json) / [`vercel.json`](vercel.json) | both platforms | Deploy configuration as code — Dockerfile builder, `/ready` health check, `nx`-aware console builds |

Two ordering rules carry the whole thing, and both are easy to break by accident:

- **Migrations run before the app swaps**, so during a deploy the *previous*
  release runs against the *new* schema. Every migration must therefore be
  backward-compatible with the release before it — expand now, contract later.
- **Railway's own GitHub auto-deploy must stay off.** If it is on, a push
  deploys the app without waiting for the migration job, and the rule above
  stops holding silently.

### Single-tenant delivery

A dedicated instance, or an install a client runs themselves, is
[Doc 11](docs/11-deployment-models.md) — the same codebase, the same images, a
different shape of deployment. [`deploy/README.md`](deploy/README.md) is the
install guide; the short version is one tarball, one `.env`, one
`./bootstrap.sh`, on a machine that has never had a route to the internet.

Two settings decide which shape a process is:

| Variable | `saas` | `single_tenant` |
|---|---|---|
| `DEPLOYMENT_MODE` | many organisations, tenant chosen at login | one organisation, chosen by the deployment |
| `SINGLE_TENANT_CLIENT_SLUG` | must not be set | names the organisation; resolved to a client **at boot**, and the API refuses to start if it names nothing |

The difference is confined to *who supplies the tenant*, and that is worth being
precise about: the slug is still the tenant half of the credential, still
resolved to a client row, and still what `app.current_client_id` and every
row-level policy are keyed on. In single-tenant mode the deployment supplies it
and a login naming a different one is **refused** — the empty field on the login
form is a consequence of that rule, not the rule. Everything below the login
screen is one code path in both modes, which is why the whole e2e battery runs
against `saas` unmodified and proves it.

## Manuals (start here if you are not writing code)

[`docs/manuals/`](docs/manuals/README.md) holds four task-oriented guides, one
per persona — the [founder](docs/manuals/founder-guide.md) (what this is, in
plain English), the [platform admin](docs/manuals/platform-admin-manual.md)
(catalogue + tenant onboarding), the
[client admin](docs/manuals/client-admin-manual.md) (a tenant's own world), and
the [developer](docs/manuals/developer-manual.md) (architecture, local setup,
building a module on top). The spec suite below remains the authority.

The same four are also built as standalone, shareable web pages in
[`docs/manuals/html/`](docs/manuals/html/index.html) — one self-contained file
each, for handing to a customer at onboarding. Rebuild with `npm run manuals:html`
after editing any manual.

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
| [11](11-deployment-models.md) | Deployment Models | dedicated vs self-hosted, console tiering, licensing |
| [12](12-consuming-the-iam.md) | Consuming the IAM | using it from products outside this repo |

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
