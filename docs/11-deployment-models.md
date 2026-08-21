# 11 — Deployment Models: Dedicated Instance & Self-Hosted

> Defines the two single-tenant ways PlantOps IAM is delivered to a client — one we operate, one they operate — what is identical between them, what genuinely differs, and the work still outstanding before either can be sold. Read Doc 02 §5 first: everything here assumes the tenancy model already built, and changes none of it.

---

## 1. The two models in one sentence each

**Dedicated instance.** We run a complete, private copy of PlantOps on infrastructure we control, reserved for exactly one client. They get a URL and a login. They own nothing operationally.

**Self-hosted.** The client runs a complete copy of PlantOps on infrastructure *they* control — their datacentre, or their own cloud account. We ship them an artifact and a runbook. We own nothing operationally.

Both are **single-tenant**: one `client` row, one database, one blast radius. The difference between them is not the software. It is who holds the keys, who gets paged at 2am, and how the money moves.

> This is the sentence to keep hold of: *dedicated instance and self-hosted are the same product with a different operator.* Every decision below follows from that.

---

## 2. Side by side

| | Dedicated instance | Self-hosted |
|---|---|---|
| Runs on | Our cloud account | Client's datacentre or cloud account |
| Data location | Our region, their private DB | Entirely inside their network |
| Who operates it | Us | Them |
| Who does backups | Us | Them (we supply the procedure) |
| Who applies upgrades | Us, on our schedule | Them, on their schedule |
| Who holds DB credentials | Us | Them |
| Who can read their data | Us, technically | Only them |
| Network egress needed | n/a | **None required** — must run fully air-gapped |
| Buyer objection it answers | "Not on a server shared with my competitor" | "Our data does not leave our premises" |
| Time to onboard | Hours | Days to weeks (their IT, their change process) |
| Revenue shape | Subscription + setup fee | Annual licence + support % |
| Our cost per client | Real and recurring (infra) | Near zero after handover |
| Our support burden | Low — we can see everything | **High** — we can see nothing |
| Version sprawl | None; everyone on latest | Real; clients sit on old versions for years |

The last two rows are the ones people underestimate. Self-hosted looks cheaper because there is no infrastructure bill, but you pay for it in support calls where you are debugging blind, and in the cost of keeping three-year-old versions patchable.

---

## 3. Nothing forks

The most important engineering rule in this document:

> **There is exactly one codebase, one build, and one image set. A client never gets a special branch, a build flag that changes business logic, or a patched binary.**

This is affordable because the tenancy model was built correctly the first time. A dedicated or self-hosted deployment is *the multi-tenant product with one row in `client`*. RLS still runs. `app.current_client_id` is still set on every request. The resolution engine still does the same work.

Leaving RLS on in single-tenant mode is deliberate. It costs nothing measurable with one tenant, and it means the code path exercised by `rls-isolation.e2e.ts` is the same code path a client runs in production. A "simpler" single-tenant mode that bypassed tenant filtering would be a second code path, tested by nobody, and it would eventually be the one that leaked.

What *does* vary between deployments is configuration only:

- which secrets are loaded,
- whether the login screen asks for a tenant slug,
- which mail transport is bound,
- what the licence blob says.

If a requirement ever cannot be expressed as configuration, it is a product feature and it goes to every client — not a fork.

---

## 4. Model A — Dedicated instance

### 4.1 Topology

```
                    client's browser
                           │  https://contoso.plantops.in
                           ▼
              ┌────────────────────────────┐
              │  reverse proxy / TLS       │   ← we own the cert
              ├────────────────────────────┤
              │  admin-web  (Next.js)      │
              │  iam-api    (NestJS)       │   ← one container each
              ├────────────────────────────┤
              │  Postgres  (private)       │   ← dedicated instance: not a
              │  Redis     (private)       │      shared cluster, not a shared DB
              └────────────────────────────┘
                  our cloud account, one stack per client
```

The stack is provisioned per client from the same infrastructure definition. There is no shared database between two dedicated clients — that is the entire point of the model, and sharing one would quietly turn it back into SaaS while still charging dedicated prices.

### 4.2 Who does what

Us: provisioning, TLS certificates, backups, restore drills, monitoring, upgrades, patching, capacity.

The client: nothing operational. They use the product and manage their own users, roles and scope tree through the console exactly as Doc 02 §4 describes.

### 4.3 Onboarding a client

1. Provision the stack from the infrastructure definition, parameterised by client slug.
2. Run migrations against the fresh database.
3. Boot the API with `PLATFORM_BOOTSTRAP_SECRET` supplied out-of-band; create the platform identity (Doc 07 §8); rotate the secret immediately.
4. Create the `client` row and enable applications (Doc 02 §3).
5. Create the initial client-admin user; hand over credentials through a channel that is not plaintext email.
6. Point DNS at the stack and issue the certificate.
7. The client admin takes over: scope tree, roles, users (Doc 02 §4).

Steps 2–5 are the same sequence a self-hosted install runs. That is not a coincidence and it should stay that way — one documented bootstrap procedure, exercised in both models, is a procedure that actually works when it matters.

### 4.4 Upgrades

We upgrade on our schedule, with notice. Because we hold the database we can snapshot immediately before migrating and roll the whole stack back if a migration misbehaves. Every client sits on a recent version, so nothing is ever back-ported.

---

## 5. Model B — Self-hosted

### 5.1 Topology

```
              ┌──────────────────────────────────────┐
              │  client's network / VPC              │
              │                                      │
              │   reverse proxy / TLS  ← their cert  │
              │   admin-web + iam-api                │
              │   Postgres + Redis                   │
              │                                      │
              │   no outbound connection required    │
              └──────────────────────────────────────┘
                     we have no access at all
```

**The hard constraint: it must run with no internet access.** Manufacturing plant networks frequently have no egress, and an installer that fails without a licence-server callout is an installer that fails on site, on day one, in front of the customer's IT team. Every check must be offline-verifiable.

### 5.2 Who does what

Them: infrastructure, TLS certificates, backups, restore, monitoring, upgrades, patching, capacity.

Us: the artifact, the runbook, the upgrade path, and support at the boundary defined in §5.5.

### 5.3 The handover kit

This is the deliverable. It is not "the repo", and it is not "a zip of containers" — it is a versioned, reproducible bundle:

| Item | Why |
|---|---|
| Versioned container images (`iam-api`, `admin-web`, reverse proxy) | Loadable offline from a tarball; digest-pinned |
| `docker-compose.prod.yml` (a Helm chart later, if asked for) | The topology, declared |
| `.env.template` with every variable and its meaning | `libs/config` boot-fails on a bad value; the template is what stops that becoming a support call |
| Migration runner as a one-shot container | Upgrades must not require a Node toolchain on their server |
| Install runbook | Prerequisites, sizing, first boot, bootstrap, DNS, TLS |
| Backup & restore runbook | With a **tested** restore, not just a `pg_dump` line |
| Upgrade runbook | Version to version, with the rollback stance stated |
| Bundled application manifests | Applied by the runner, not uploaded by hand (§6.3) |
| Licence file | §10 |
| Support policy | §5.5 |

### 5.4 Upgrades

The client applies them, which means the upgrade path has to be boring and forgiving:

- **Migrations are forward-only, and additive wherever possible.** A client who cannot roll a migration back needs migrations that never require it.
- **Skipping versions must work.** A client on 1.2 upgrading to 1.9 will not stop at every intermediate release. The migration runner already applies in sequence — that behaviour must be *tested* across a version gap, not assumed.
- **Backup is step one of the runbook,** and the runbook states that the upgrade is unsupported without one.
- **`/health` and `/ready` already exist** (Doc 06) and are the post-upgrade gate.

### 5.5 Support boundary

Put this in writing before the first sale, because it is what gets argued about later.

**In scope:** defects in PlantOps, upgrade assistance, configuration guidance, security advisories.

**Out of scope:** their Postgres tuning, their network, their TLS certificates, their backups, their hardware, and performance problems traced to under-provisioned infrastructure.

Support requires a **diagnostic bundle** the client generates and sends: version, redacted config, recent logs, migration state, row counts. Without one, every ticket opens with a week of "can you check whether Redis is running." That bundle is a feature we have to build (§8, gap 8), not a document we can write.

---

## 6. Who gets the platform console

`admin-web` is one Next.js app with two route trees — `/platform/*` and `/admin/*` — gated by permission tier (Doc 09 §1). The platform tier registers applications, uploads manifests, creates clients, and enables applications for them. So: in a single-tenant deployment, does the client get it?

**Dedicated: no, and we can genuinely enforce that. Self-hosted: we cannot enforce it, so the design has to make it unnecessary instead.**

### 6.1 Dedicated — withheld, and actually enforced

We hold the only platform identity. The client admin holds `iam.client.*` and nothing more. Dynamic navigation (Doc 05) means `/platform/*` never renders for them, and the API refuses those calls regardless of what the browser asks for. Nothing new to build — the tier boundary Doc 02 §1 already defines does this on its own.

### 6.2 Self-hosted — we cannot withhold it, so we make it unnecessary

On their hardware they hold the database, the `PLATFORM_BOOTSTRAP_SECRET` (they run the install), and root on the box. Any attempt to withhold the platform tier is cosmetic. Designing as though it were not would build a false sense of control into the product.

The productive move is to notice **how little of the platform tier a single-tenant install actually needs at runtime**:

| Platform capability | In SaaS | In a single-tenant install |
|---|---|---|
| Register applications, upload manifests | Ongoing platform work | Fixed by the release — apps ship in the image |
| Create clients | Every new customer | Exactly once, at install |
| Enable applications for a client | Per contract | Determined by the licence |
| Platform (cross-tenant) audit | Genuinely global | Identical to client audit — there is one tenant |
| Service accounts for integrations | — | Already client tier: `iam.client.svc.*` |

The last row is the important one. Their ERP integration, their gate hardware, their middleware all authenticate through `iam.client.svc.*`, which the client console already exposes (Doc 09 §3). **The most common reason a client would ask for platform access does not require platform access.**

### 6.3 Manifests ship with the release

This is the design change the question forces, and it is worth making regardless of licensing.

Application manifests (Doc 02 §2) become **release artifacts** — bundled in the image, applied idempotently by the bootstrap and upgrade runner. Doc 02 §2 already specifies manifest upload as an upsert keyed by `(application, key)`, so re-applying on every upgrade is exactly the behaviour that spec describes.

Why this is right even setting the console question aside: a self-hosted client who hand-edits a permission catalog is running a deployment that has silently diverged from the product, and every support ticket after that is guesswork. Shipping manifests with the release means the catalog on their box is always the catalog we tested — and an upgrade quietly re-converges it if anyone has been poking at it.

### 6.4 What the client does get on-prem

A **restricted platform role**, assembled entirely from permission keys that already exist in migration 0017. No schema change, and no UI change either: the console already gates screen-by-screen on individual permissions rather than on the tier, so ungranted actions degrade to a disabled control explaining which permission is missing.

**Granted:**

| Permission | Why |
|---|---|
| `iam.platform.app.read`, `permission.read`, `nav.read` | Their IT can see what is installed |
| `iam.platform.client.read`, `client.app.read` | Visibility of their own tenant and entitlements |
| `iam.platform.audit.read` | Global audit — in a single-tenant install this is simply their audit |

**Not granted:**

| Permission | Why not |
|---|---|
| `app.create`, `app.update`, `app.manifest`, `permission.create`, `nav.create`, `nav.map` | The catalog belongs to the release, not to the deployment (§6.3) |
| `client.create`, `client.app.enable`, `client.app.update` | The tenant comes from the install; its entitlements come from the licence |
| `client.admin.create` | Genuinely needed, but not as a standing permission — see below |

**Break-glass is a host command, not a permission.** If they lock out their only client admin at 3am, on a network with no egress and with us unreachable, they need a route back in; withholding that manufactures an outage we are structurally unable to fix. But it does not follow that the capability should sit in a role forever. Session 45 ships it as `tools/break-glass-admin.ts` — run on the host, gated by the bootstrap secret, and audited distinctly from a routine console action. Someone who can run it already has the database.

The alternative — simply granting `iam.platform.client.admin.create` — is one line in the seed and remains open (§12, decision 4).

### 6.5 One hard rule, not a guardrail

In `DEPLOYMENT_MODE=single_tenant`, **client-creation endpoints are refused at the API.**

Not for commercial reasons — for coherence. The deployment pins one client id at boot (§9, session 44), so a second `client` row would be unreachable by every request the process serves. That is an incoherent state, so the API declines to create one.

This is the only restriction in this section that is a real control rather than a guardrail, because it holds no matter who holds the credentials.

### 6.6 Be honest about the rest

Everything else here is a guardrail on somebody else's hardware, and §10's reasoning applies unchanged: the mechanism exists to make the honest path easy, not to make the dishonest path impossible. The contract carries the weight — support is void for a deployment with a hand-modified catalog, and the upgrade re-applies the shipped manifests in any case.

---

## 7. Responsibility matrix

| Task | SaaS | Dedicated | Self-hosted |
|---|---|---|---|
| Provision infrastructure | Us | Us | Client |
| TLS certificates | Us | Us | Client |
| Database backups | Us | Us | Client |
| Restore drills | Us | Us | Client (we supply the procedure) |
| Monitoring / alerting | Us | Us | Client |
| Apply upgrades | Us | Us | Client |
| Patch OS and base images | Us | Us | Client |
| Publish security advisories | Us | Us | **Us** |
| Tenant admin (roles, users, scopes) | Client | Client | Client |
| Incident diagnosis | Us | Us | Joint, via diagnostic bundle |

---

## 8. What the codebase does not have yet

The honest gap list as of today. None of it is hard; all of it is unbuilt.

**1. There is no *complete* release artifact.** Session 39 added `apps/iam-api/Dockerfile` and a `.dockerignore`, so the API has a reproducible image. Nothing else does: there is no console image, no reverse proxy, no migration runner, and no version stamped into any of them. The root `docker-compose.yml` still starts Postgres and Redis for local development only. Both single-tenant models need the full set before either can be delivered — Session 41.

**2. `admin-web` baked the API URL in at build time — half fixed.** Session 40 closed the console's half: `apps/admin-web/src/lib/api-config.ts` now defaults to the same-origin path `/api`, so a build made without `NEXT_PUBLIC_IAM_API_URL` carries no hostname at all and one bundle serves any origin. An absolute value still overrides it, which is what local development and the managed platform use, since neither has the console and the API on one origin. What remains is the other half — **the bundled reverse proxy that maps `/api` to the API, Session 41**. Until it exists, nothing serves that path outside a hand-rolled dev proxy, and the two single-tenant models still cannot be delivered.

**3. The database configuration assumes a Supabase pooler.** `DATABASE_URL` is documented as the PgBouncer endpoint and `DATABASE_DIRECT_URL` as the direct one, with prepared statements disabled accordingly. An on-premise Postgres has no pooler: both URLs will be identical, and the prepared-statement decision should follow an explicit flag rather than an assumption about where the database lives. `DATABASE_SSL` defaults to false, which is right for a bundled container and wrong for a client who terminates TLS at their own Postgres.

**4. There is no single-tenant mode.** `POST /auth/login` still takes `client_slug` (Doc 03 §3), and users are unique per `(client_id, email)`. In a single-tenant install that slug is a constant the user should never see or type. Needed: a `DEPLOYMENT_MODE` config (`saas` | `single_tenant`), and in single-tenant mode a pinned client resolved at boot with the login screen dropping the field. Resolution stays server-side — the client id is never taken from a browser-supplied value.

**5. There is no licence or entitlement concept.** `client_application` carries `enabled` and a `config` jsonb, but no `expires_at`, no user ceiling, no scope-node ceiling. Both models need entitlements, and they belong in the same place so that SaaS billing and self-hosted licensing read from one source instead of diverging.

**6. Password-reset delivery has no transport bound.** `apps/iam-api/src/auth/password-reset.delivery.ts` is deliberately a port whose logging default refuses to print tokens in production. That design is right, but no real binding exists. A self-hosted client needs to point it at their own SMTP relay, and that must be configuration rather than code.

**7. There is no backup, restore, or upgrade runbook,** and no test proving a migration sequence applies cleanly across a version gap.

**8. There is no diagnostic bundle command** (§5.5), and no version surfaced at runtime. Support for a self-hosted install begins with "what version are you on," and today the client has no reliable way to answer.

**9. Application manifests are upload-only.** Doc 02 §2 makes manifest upload an idempotent upsert, which is exactly right, but the only path to it is a human at `POST /iam/applications/:id/manifest`. Nothing bundles manifests into a release or applies them at install and upgrade, which §6.3 requires for both single-tenant models.

**10. There is no restricted platform role.** The permission keys §6.4 needs all exist in migration 0017 and the console already gates screen-by-screen on individual permissions, so this is a seed and a documented role definition rather than a feature — but neither exists yet.

**11. ~~Roadmap session 39 — "Deployment + CI + runbook" — is still open.~~** Delivered: the API image, the three-job pipeline, the migration release step over the direct URL, and `docs/ops-runbook.md`. It covers the *managed* path only, and it deploys nothing on its own — no environment has been stood up against it yet. The plan below extends it rather than duplicating it.

---

## 9. The build plan

**Phase 8 of the implementation roadmap, Sessions 40–49.** The roadmap holds the full entries — goal, files, acceptance criteria, definition of done — for each. Summarised here:

| # | Session | Delivers | Hours | Risk |
|---|---|---|---|---|
| 40 | Origin-agnostic console | `api-config.ts` defaults to same-origin `/api`; one build serves any hostname | 3–4 | Low |
| 41 | Images + proxy + migrator | Console image, reverse proxy, one-shot migration runner, version stamping | 5–7 | Medium |
| 42 | Offline bundle + bootstrap | `docker-compose.prod.yml`, `.env.template`, image tarball, idempotent first-boot script | 5–7 | **High** |
| 43 | Manifests as release artifacts | Bundled in the image, applied idempotently at install and on every upgrade (§6.3) | 4–6 | Medium |
| 44 | Single-tenant mode | `DEPLOYMENT_MODE`, boot-pinned client, slugless login, client creation refused (§6.5) | 6–8 | **High** — touches auth |
| 45 | On-prem role + break-glass | The §6.4 grant list, seeded; recovery as an audited host command | 3–4 | Medium |
| 46 | Deployment-agnostic DB config | Explicit pooling flag, real TLS options, both-URLs-same supported | 3–4 | Medium |
| 47 | SMTP delivery binding | A real transport behind the existing port; unconfigured path unchanged | 3–5 | Low |
| 48 | Entitlements + licence | Ceilings and term, offline-verifiable signed licence, non-destructive expiry | 6–8 | Medium |
| 49 | Runbooks + diagnostics | Install / backup / restore / upgrade runbooks, tested restore, cross-version migration test, diagnostic bundle | 6–8 | Medium |

**Roughly 44–61 hours.** Sessions 40–42 are what unblock a pilot: with those three you can hand a client a working install and handle the slug and the licence by hand for customer one. The rest is what makes it repeatable rather than heroic.

**Phase 8 does not depend on session 39.** That session delivers the managed Railway/Vercel path; session 41 creates the API image itself if 39 has not run. A pilot going out self-hosted can go 38 → 40 → 41 → 42 and ship.

Two sessions carry real risk. **44** changes the login path, so it belongs beside sessions 8 and 9 in the care it gets; its safety property is that `saas` mode stays byte-for-byte unchanged, asserted by the existing e2e battery passing unmodified. **42** is riskier than it looks: it is where a self-hosted install can silently run the app as the table *owner*, which exempts it from every RLS policy in Doc 07 §5.1. The bootstrap creating both database roles correctly is the most consequential thing in this phase.

---

## 10. Licensing & entitlements

Entitlements belong on `client_application` and the `client` row, not in a separate licensing subsystem. The same fields serve both models:

- `expires_at` — when the subscription or licence term ends
- `max_users` — ceiling on active users
- `max_sites` — the site count, metered as §10.1 describes

### 10.1 What the site meter must not be

The obvious meter is "count `scope_node` rows of kind `plant`." **Do not build that.** `scope_node.kind` may become tenant-defined (ADR 0002), and a meter that counts a field the customer controls is a meter the customer can rename their way out of. It is also wrong on its own terms: a tenant whose sites are called `branch` or `campus` would meter as zero.

Two safe alternatives:

- **Total `scope_node` count** — crude, unspoofable, and needs no vocabulary at all. A tenant that models more finely pays more, which is defensible but not quite what is being sold.
- **A platform-set flag on the node** (or on the client's kind definitions) marking which nodes are billable sites — set at onboarding by us, not editable by the tenant.

The second is the better meter and the one Session 48 should implement. Either survives ADR 0002 resolving in either direction, which matters because that ADR may close *after* Session 48 ships.

**Dedicated instance:** we hold the database, so entitlements are rows we set, and enforcement is real.

**Self-hosted:** the client holds the database and could edit any row. So the licence is a **signed blob** — a file carrying client name, term and limits, signed with our private key and verified at boot against a public key compiled into the image. It must verify **offline**; no callout.

Be clear-eyed about what that achieves. A signed licence prevents accidental over-use and makes term expiry visible in the console. It does not stop a determined customer willing to patch a binary. That is fine — this is enforced contractually, with an audit clause, and the technical mechanism exists to make the honest path easy rather than to make the dishonest path impossible. **Do not build DRM.** The engineering cost is high, the deterrent value is low, and the failure mode is a licence check that locks out a paying customer's night shift.

Expiry behaviour should degrade, never detonate: warn in the console from 30 days out, then block administrative changes while leaving authentication and permission resolution working. An IAM that stops issuing tokens is a plant that stops running, and no invoice is worth that.

---

## 11. Commercial shape

| | Dedicated instance | Self-hosted |
|---|---|---|
| Model | Annual subscription | Annual licence — prefer term over perpetual |
| Setup fee | Yes; provisioning is real work | Yes; installation and handover is more work |
| Support | Included | 18–22% of licence value, annually |
| Meter | Per plant, plus module bundles | Same meter, same numbers |
| Rough ratio | 1× | 2.5–3× the annual subscription |

Prefer **term licences over perpetual** for self-hosted. A perpetual licence with optional support produces exactly the client you cannot help: four-year-old version, unsupported, and still your reputation when it breaks.

Do not price per seat. This product's users include gate guards and floor supervisors numbering in the thousands; per-head pricing either loses the deal or pushes the client to under-license and route around the system. The site count is the meter (§10.1) and `client_application` is the module bundle.

---

## 12. Open decisions

These change what gets built first, and they are not ours to assume:

1. **Is the apparel pilot genuinely on-premise, or is "dedicated" enough?** If dedicated is enough, sessions 43 and 46 can wait and the pilot ships on 40–42 alone.
2. **Kubernetes or Docker Compose at the client?** Compose is right for a single plant group and far easier to support. Helm only if their IT already runs Kubernetes and insists on it.
3. **Do they have Active Directory or Azure AD?** If so, per-tenant SSO becomes the gating feature for the deal and outranks most of this list.
4. **Break-glass as a command, or as a standing permission?** §6.4 and session 45 ship it as an audited host command, which keeps `iam.platform.client.admin.create` out of every role. The alternative is simply to grant that permission in the on-prem role — one line in the seed, no tool to maintain, and a recovery path their admin can reach from a browser rather than from a shell on the server. Worth choosing deliberately: the command is the better security posture, the permission is the better 3am experience.
5. **Who supplies Postgres in a self-hosted install** — our bundled container, or their existing database team's cluster? The second is common in larger groups and substantially changes the backup and upgrade runbooks.
