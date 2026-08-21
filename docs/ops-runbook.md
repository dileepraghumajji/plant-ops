# Ops Runbook — the managed platform

> **Scope:** the multi-tenant platform we operate — `iam-api` on Railway, `admin-web` on Vercel, Postgres on Supabase, managed Redis. Doc 08 §6 is the authority for the shape; this document is what you actually do.
>
> **Not in scope:** the two single-tenant models. A dedicated instance and a self-hosted install are Doc 11, delivered by Phase 8 (Sessions 40–49), and they deliberately share this codebase but not this runbook.
>
> Everything below is written to be followed at 3 a.m. by someone who did not build it. Where a step is dangerous, the danger is stated before the command, not after.

---

## 1. The two connection strings

Almost every serious mistake available in this system is a connection string in the wrong place, so start here.

| | `DATABASE_URL` | `DATABASE_DIRECT_URL` |
|---|---|---|
| Endpoint | Supabase **pooler** (PgBouncer, transaction mode) | **Direct**, non-pooled |
| Role | `plantops_app` — owns nothing | `plantops` — owns schema `iam` and every table |
| Used by | every request the API serves | migrations, and nothing else |
| Why | the pooler multiplexes; nothing may pin session state to a connection | DDL, advisory locks and long transactions need a real session |

They differ in **two** dimensions, not one: a different endpoint *and* a different role (Doc 07 §2). On Supabase the *endpoint* row needs one qualification — see §5.1, which is where the direct connection's IPv6-only default collides with an IPv4-only CI runner. The *role* row admits no qualification anywhere. The endpoint split is a performance decision. The role split is the security one, and it is the reason the whole system's tenant isolation works:

> A table's **owner is exempt from its own RLS policies** — independently of `SUPERUSER` and `BYPASSRLS`. Point `DATABASE_URL` at the owning role and every policy in Doc 07 §6 goes silently inert. Nothing errors. The API keeps returning perfectly plausible rows, belonging to other tenants.

Two things defend against this, and both are already in place:

- Every RLS-enabled table carries `force row level security`, so ownership alone cannot re-open the hole.
- `assertRlsEnforceable` runs at boot (`libs/db/src/startup-checks.ts`) and refuses to start a process whose connection role is a superuser, holds `BYPASSRLS`, or **owns any table in `iam`**.

If the API refuses to boot with an RLS startup error, do not work around it. It has caught exactly the misconfiguration it exists to catch — almost always `DATABASE_URL` pointing at the owner.

**Supabase's built-in `postgres` role is unsuitable as either role.** It is privileged and would own everything the migrations create. Use it exactly once, to create the two roles (§5), and never place it in a connection string again.

---

## 2. Environments and where secrets live

Three places hold configuration, and nothing is duplicated between them.

| Where | Holds | Notes |
|---|---|---|
| Railway service variables | the API's full environment (`.env.example` is the list) | The only place `JWT_PRIVATE_KEY` and `DATABASE_URL` exist. |
| GitHub Environment `staging` / `production` | secrets `STAGING_DATABASE_DIRECT_URL`, `RAILWAY_TOKEN`, and (first release only) `PLATFORM_BOOTSTRAP_SECRET`; variables `RAILWAY_SERVICE`, `RAILWAY_ENVIRONMENT`, `STAGING_DATABASE_CA_CERT` | Only what the release job needs — see §3. The job's first step checks all four deploy values are present and fails naming any that are missing. **Environment-scoped values are invisible to a job's `if:`** — a job's `environment:` resolves after its condition is evaluated, so `vars.X` there sees repository variables only. A guard written that way skips the job silently, with a green tick and no deploy. |
| Vercel project | `NEXT_PUBLIC_IAM_API_URL` | The console's whole configuration, and needed here only because the console and the API sit on different origins. Public by construction: Next inlines it into the browser bundle. |

Rules that are not negotiable:

- **No secret in the repository.** `.env` is git-ignored; `.env.example` ships placeholders and a test (`libs/config/src/env-example.spec.ts`) fails the build if it ever contains a real one.
- **Never log the config object.** `redactEnv()` exists for this; `main.ts` uses it. `DATABASE_URL`, `DATABASE_DIRECT_URL`, `REDIS_URL`, `JWT_PRIVATE_KEY` and `PLATFORM_BOOTSTRAP_SECRET` are masked by it (Doc 07 §8, Doc 10 §8).
- **`REDIS_KEY_PREFIX` must differ between environments** whenever they share a managed Redis instance. Without it, a staging deploy flushing `perms:*` silently invalidates production's grants cache.
- **`TRUST_PROXY=true` on Railway, and only behind a proxy that rewrites `X-Forwarded-For`.** On without one, every caller picks their own rate-limit bucket by sending the header themselves, which is the same as having no IP rate limiting at all.
- **`DATABASE_SSL=true`** against Supabase, **with `DATABASE_CA_CERT` set** — the pooler's chain is not publicly rooted, so TLS without the anchor cannot connect at all (§5.1). Both are `false`/unset only for a local docker-compose Postgres.
- **`OPENAPI_ENABLED`** is off by default in every environment including staging. The document is a build artefact (`npm run openapi`, committed at `apps/iam-api/openapi.json`), so an integrating team does not need a deployment to serve it.

---

## 3. Release: what a deploy does, in order

`.github/workflows/ci.yml` runs three jobs. On a push to `main`:

```
verify ─┐
        ├─→ release ─→ 1. migrations (direct URL)   ← must succeed
image ──┘             2. railway up                 ← app swap
```

`verify` and `image` are also the pull-request checks. `release` never runs from a pull request.

### 3.1 Why migrations run first, and what it costs

Migrations are applied **before** the new image serves traffic. For the length of the deploy, the **previous** version of the code is running against the **new** schema.

That is the correct order — the alternative is new code querying columns that do not exist — but it imposes a rule on every migration you will ever write:

> **Each migration must be backward-compatible with the release before it.**
> Expand now, contract a release later.

| Change | Release *n* | Release *n+1* |
|---|---|---|
| Add a column | `add column … null` (or with a default) | start writing it; make it `not null` |
| Rename a column | add the new one, write both | drop the old one |
| Drop a column | stop reading it | `drop column` |
| Add a `not null` constraint | backfill | add the constraint |

A migration that renames a column in one step will break production for the length of the deploy, and the failure will look like a bug in the old code.

### 3.2 The release step

`tools/release-migrate.ts`, behind `npm run release:migrate`. It differs from the developer's `npm run migration:run` in four ways that matter to a deploy:

1. **It validates only the migration subset of the environment** — `DATABASE_DIRECT_URL`, `DATABASE_SSL`, `NODE_ENV`. The release job therefore never holds the signing key, the Redis URL, or the bootstrap secret.
2. **It takes a Postgres advisory lock**, so a re-run of a stuck job cannot race the deploy it was re-run for.
3. **It cannot revert.** Rolling a schema back under a running fleet is §10, done by a human with this document open.
4. **`--check` reports without applying**, exiting non-zero if anything is pending.

```sh
npm run release:migrate -- --check   # what would this release apply?
npm run release:migrate              # apply it
```

A non-zero exit stops the workflow before the deploy step. **That is the entire ordering guarantee**: there is no path from a failed migration to an app swap.

It also bounds its own shutdown. The first real release applied all seventeen migrations correctly, printed its summary, and then failed to exit for twenty-three minutes — a connection through the pooler that never closed. The schema was right the whole time; the deploy behind it simply never happened. A release step that hangs *after* succeeding is worse than one that fails, because nothing is wrong to find. It now exits regardless after fifteen seconds, preserving its exit code, and the job carries a twenty-minute `timeout-minutes` behind that.

### 3.3 Railway's own auto-deploy must stay off

Railway can deploy on push from its GitHub integration. For `iam-api` that setting must be **disabled**. If it is on, a push deploys the app without waiting for the migration job, and §3.1's ordering — the one thing this pipeline exists to impose — silently stops holding.

The deploy is instead `railway up` from the release job, against the root `railway.json`, which pins the Dockerfile builder, `/ready` as the health-check path, and `ON_FAILURE` restarts.

### 3.4 Verifying a release

```sh
curl -s https://<api-host>/health          # {"status":"ok","uptimeSeconds":…}  — process is alive
curl -si https://<api-host>/ready | head -1  # 200 ready; 503 names the failing dependency
```

`/health` says nothing about dependencies **on purpose**: it is the liveness probe, and a failing liveness probe kills the container. If it consulted Postgres, a thirty-second database blip would restart every replica at once, turning a recoverable dependency failure into a cold start of the whole fleet. `/ready` is the one that reports Postgres and Redis, and a failing readiness probe only removes the instance from the load balancer.

Then the real check, which no probe can make for you — log in to the console, and confirm the nav renders. Navigation is resolved from the database through the grants cache (Doc 05), so a rendered menu exercises Postgres, Redis, the signing key and the resolution path in one action.

---

## 4. The console

`admin-web` is deployed by Vercel's GitHub integration from the root `vercel.json`, on the same push. It is safe for that to race the API deploy: the console holds no schema of its own and learns its menu, its permissions and its error codes from the API at run time (Doc 05, Doc 09).

`ignoreCommand` runs `nx-ignore`, so a push that does not affect `admin-web` does not spend a Vercel build.

`NEXT_PUBLIC_IAM_API_URL` is substituted into the browser bundle **at build time**, so a console built with it is bound to that API origin: changing it requires a redeploy of the console, not a restart. On the managed platform that is the price of hosting the two halves separately — Vercel serves the console, Railway serves the API, and two origins cannot be bridged by a relative path. Unset, the console calls the same-origin path `/api` instead, which is what lets one image serve any hostname on a dedicated or self-hosted install (Doc 11 §3); a single-tenant deployment therefore sets nothing here and gets its proxy to map `/api` to the API.

Whatever origin the console is served from must appear in the API's `CORS_ALLOWED_ORIGINS`, comma-separated. Vercel preview deployments get a new hostname per deploy and will therefore be blocked by CORS unless explicitly added — that is the allow-list working, not a bug.

---

## 5. Standing up a new environment

Once per environment, in this order. Steps 1–3 cannot be done by the pipeline: creating roles needs `CREATEROLE`, which the migration role deliberately does not have.

1. **Create the Supabase project**, then collect three things from **Connect**: the project ref, the direct host, and the **pooler** host (`aws-<n>-<region>.pooler.supabase.com`). Which endpoint each variable gets is §5.1 — on Supabase the answer is not the obvious one.

2. **Create the two database roles**, connected as `postgres` — the one and only time that role is used. Supabase ships `postgres` and neither of ours, so create both before running the script:

   ```sql
   create role plantops     login password '<owner-pw>';
   create role plantops_app login password '<app-pw>';
   ```

   Then:

   ```sh
   psql "<postgres url — see §5.1>" \
     -v owner_role=plantops -v app_login_role=plantops_app \
     -f tools/setup-db-roles.sql
   ```

   The script is idempotent, creates the `iam_app` privilege group, grants the owner `CREATE` on the database (needed on Supabase, where `PUBLIC` holds only `CONNECT` and `TEMP`), refuses an app role that is a superuser or holds `BYPASSRLS`, and prints the resulting role attributes. **Read that output** — `plantops_app` must show `superuser` and `bypassrls` both false.

   The two passwords are yours to choose. Nothing in Supabase generates or stores them.

3. **Provision managed Redis.** Give this environment its own `REDIS_KEY_PREFIX` if the instance is shared.

4. **Generate the signing keypair** (RS256, ≥2048 bits — Doc 03 §1) and put it in the Railway service variables:

   ```sh
   openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out jwt.key
   openssl rsa -in jwt.key -pubout -out jwt.pub
   ```

   `JWT_SIGNING_KEY_ID` is any stable identifier; it is the `kid` consumers match against JWKS. Shred `jwt.key` once it is in the secret store.

5. **Set the rest of the environment** from `.env.example` — it is the complete list, kept honest by a test.

6. **Run the first migration** with `PLATFORM_BOOTSTRAP_SECRET` set (§6), then remove it from the release job.

7. **Seed the IAM's own manifest** so the console has navigation:

   ```sh
   npm run manifest:seed-iam
   ```

8. **Verify** per §3.4, then run the load smoke (`npm run load:smoke`) once to confirm a cached resolve stays off the database.

---

### 5.1 Which endpoint goes in which variable (Supabase specifics)

Supabase offers three endpoints, and the obvious mapping — "the direct URL gets the direct connection" — does not survive contact with CI.

| Variable | Endpoint | Port |
|---|---|---|
| `DATABASE_URL` | Transaction pooler | 6543 |
| `DATABASE_DIRECT_URL` | **Session pooler** | 5432 |

Both also need `DATABASE_SSL=true` **and** `DATABASE_CA_CERT` — see below.

**The direct connection is IPv6-only** unless you buy the dedicated IPv4 add-on, and **GitHub Actions runners are IPv4-only**. Point `DATABASE_DIRECT_URL` at `db.<ref>.supabase.co` and the migration job simply cannot reach it — failing with a connection error that reads like an outage rather than an addressing problem. Check what you have before choosing:

```sh
nslookup db.<ref>.supabase.co     # AAAA only → use the session pooler
```

The **session pooler** on port 5432 is a real fix rather than a workaround: session mode gives each client a dedicated connection for the life of the session, so DDL, long transactions, and the session-scoped advisory lock `release-migrate` takes all behave exactly as on a direct connection.

**Do not use port 6543 for the direct URL.** That is transaction mode, and the migration advisory lock would be released out from under the release step.

**On the pooler, usernames are tenant-qualified.** Supavisor routes by username, so it is `<role>.<project-ref>`, not bare `<role>`. This catches everyone once:

```
DATABASE_URL=postgresql://plantops_app.<ref>:<app-pw>@aws-<n>-<region>.pooler.supabase.com:6543/postgres
DATABASE_DIRECT_URL=postgresql://plantops.<ref>:<owner-pw>@aws-<n>-<region>.pooler.supabase.com:5432/postgres
```

The database is **`postgres`**, not `plantops_iam` — that name is local-only. The migrations create schema `iam` inside whatever database you connect to.

**TLS needs a trust anchor, and without one there is no working configuration.** Measured against `aws-0-ap-south-1.pooler.supabase.com:5432`: the server presents `CN=*.pooler.supabase.com`, issued by `Supabase Intermediate 2021 CA` under a **self-signed** `Supabase Root 2021 CA`. Node's default store does not contain that root, so a connection with `rejectUnauthorized: true` fails with `SELF_SIGNED_CERT_IN_CHAIN` — while `DATABASE_SSL=false` would send the database password in cleartext across the public internet.

So set both:

```
DATABASE_SSL=true
DATABASE_CA_CERT=<contents of prod-ca-2021.crt>
```

Download it from **Project Settings → Database → SSL Configuration → Download certificate**. It is a public certificate, not a secret — it is the anchor verification is performed *against*, not a credential. Verified against this project's pooler: the chain validates and `authorized` is true.

There is deliberately **no** setting that disables certificate verification. The usual `rejectUnauthorized: false` workaround encrypts the connection while authenticating nothing, which would leave an active attacker able to sit between the API and the one component Doc 07 §5.1 treats as the last line of defence. `libs/db/src/data-source.ts` builds the TLS options in one function for both connections so the app and the migrations cannot end up trusting different things.

**Never put Supabase's `postgres` role in either variable.** Measured on a fresh project: `rolsuper = f` but `rolbypassrls = t`. It would pass a naive superuser check while bypassing every policy in Doc 07 §6 — which is exactly why the boot check in §1 tests table ownership as well.

---

## 6. The bootstrap secret — used once, rotated immediately

The first platform admin cannot be created through the authorized API, because authorizing the call would require the identity the call creates. Migration `0011-bootstrap-seed` resolves the chicken-and-egg: it reads `PLATFORM_BOOTSTRAP_SECRET` from the environment, hashes it with argon2id, and stores only the hash against a platform service account keyed `platform-bootstrap` (Doc 07 §8).

Consequences worth being precise about:

- The secret is needed for **exactly one** migration run in the life of a database — the first. Every release after it runs without the variable, and `release-migrate` checks before applying anything: if `0011` is pending and the secret is missing or under 32 characters, it fails **before** the first migration rather than eight migrations in.
- The plaintext is never written to the database, the audit payload, or the log. The bootstrap itself is audited as `platform.bootstrap` — the event, not the credential.
- **Rotate it immediately after first use.** It is a long-lived platform-wide credential delivered through a CI job's environment; treat it as burned the moment it has been used.

```
1. First release of a new environment: set PLATFORM_BOOTSTRAP_SECRET in the
   GitHub Environment, run the release.
2. Log in with it, create a real platform admin through the console.
3. Rotate the bootstrap service account's secret (or revoke it outright —
   it has served its only purpose).
4. Delete PLATFORM_BOOTSTRAP_SECRET from the GitHub Environment.
```

Step 4 is the one that gets skipped. A secret that stays in the release job's configuration is a secret that will still be there in a year, still valid, protecting nothing.

---

## 7. Rotating the JWT signing key

**This is three deploys, not one command**, and the ordering is the whole point. Every wrong order silently breaks tokens that are already in flight — sporadic 401s across the fleet, at the moment someone has just changed the keys and is inclined to blame something else.

Doc 03 §1:

```
1. generate the new keypair, publish its PUBLIC key in JWKS first
2. wait for JWKS propagation (at least one cache TTL)
3. only then switch signing to the new private key
4. keep the old public key published for at least one access-token lifetime
   after the last token it signed, then remove it
```

`npm run keys:rotate` enforces this. It refuses a step whose predecessor has not happened and a step whose waiting period has not elapsed, and prints the environment for the next deploy. The rules themselves are unit-tested in `libs/config/src/key-rotation.ts` — the tool is a thin CLI over them.

```sh
npm run keys:rotate -- status
npm run keys:rotate -- publish  --private-key-file ./new.key
# deploy the printed JWT_RETIRED_PUBLIC_KEYS, then wait — the tool prints until when
npm run keys:rotate -- activate --kid <kid> --published-at <iso> --private-key-file ./new.key
# deploy, wait one access-token lifetime
npm run keys:rotate -- retire   --kid <kid> --deactivated-at <iso>
```

Between `publish` and `activate` the new private key must live somewhere that is **not** `JWT_PRIVATE_KEY`: a key in that variable is a key that signs, and signing before propagation is exactly the failure the ordering prevents. The tool writes it to a file you name, mode `0600`, rather than to stdout — a private key in CI logs and shell history is the failure mode it is avoiding.

Do not hand-edit `JWT_RETIRED_PUBLIC_KEYS`. Despite the name it carries keys at *both* ends of their life — published-ahead-of-activation and retained-after-retirement sit in the same map, and JWKS cannot tell them apart. That is precisely why the ordering has to be enforced by something other than memory.

Verify after each step:

```sh
curl -s https://<api-host>/iam/.well-known/jwks.json
```

**Emergency rotation (key believed compromised).** The safe ordering exists to protect valid tokens; a compromised key means you no longer want them valid. Publish and activate the new key immediately, skipping the wait, and accept that consumers with a cached JWKS will reject new tokens until they refetch — at most one cache lifetime. Then revoke sessions rather than waiting for tokens to expire, and treat every token signed by the old key as untrusted.

---

## 8. When you are paged

Work outwards from the process.

| Symptom | First check | Then |
|---|---|---|
| API returns 503 on everything | `curl -si /ready` — it names the failing dependency | §8.1 (Postgres) or §8.2 (Redis) |
| API will not start | Railway deploy logs, first 20 lines | Boot fails loudly and specifically: an env validation error lists the variable names; an RLS startup error means `DATABASE_URL` is pointing at the owning role (§1); a key configuration error means the keypair is malformed or mismatched |
| Everyone gets 401 | `curl /iam/.well-known/jwks.json` | A rotation is mid-flight and step 3 happened before step 2 (§7). Republish the previous public key — it is additive and safe |
| One tenant sees another's data | **Stop. Page a human.** | §8.3 — this is the one failure that is not self-correcting |
| Logins fail for one account only | Lockout: five consecutive failures locks an account (Doc 03 §8) | The lock is administrative and does not lift on its own — unlock through the console |
| Everything is slow | `/ready` latency, then Supabase connection count | The pooler is the usual answer; `APP_POOL_SIZE` is 10 per replica |

### 8.1 Postgres down or unreachable

The API stays alive and answers `/ready` with 503, naming `postgres: down`. Replicas leave the load balancer and rejoin on their own. Nothing to restart. Check Supabase status and the connection count; if the pooler is saturated, reduce `numReplicas` before raising the pool size.

### 8.2 Redis down or unreachable

Also 503 — and Redis being **required** for readiness is deliberate, not an oversight. Redis holds the revoked-`sid` set (Doc 03 §6), so an instance serving without it would honour tokens that have been revoked. Out of rotation is the better failure.

### 8.3 Suspected cross-tenant exposure

The one thing here that cannot be undone by fixing it afterwards.

1. **Do not restart anything.** A restart re-runs the startup check, which may pass, and destroys the evidence of which connection role was in use.
2. Capture the current `DATABASE_URL`'s role: `select current_user, session_user;` and check ownership — `select tablename, tableowner from pg_tables where schemaname = 'iam';`
3. If the app role owns anything in `iam`, the exposure window is the whole time that configuration was live. Every RLS policy was inert.
4. Fix the connection string, redeploy, confirm the startup check passes.
5. Query `audit_trail` for the window. It is append-only and the app role holds no `INSERT` on it directly — writes go through `iam.write_audit`, a `SECURITY DEFINER` function — so the trail is trustworthy even if the tables were not (Doc 07 §6, Doc 10 §5).

---

## 9. Backup and restore

Supabase's automated backups cover the database. Two things about this schema need saying beyond that.

**Audit is a record of record.** `audit_trail` is append-only by privilege, not by convention: the application role holds no `UPDATE` or `DELETE` on it (Doc 07 §6, Doc 10 §5). Its backups inherit that status — they are evidence, and they are the reason retention is indefinite by default (Doc 10 §6). Never "clean up" audit rows in place. If a client's compliance regime requires archival, move older rows to cold storage; do not delete.

**A restore does not restore the roles.** Roles are cluster-level, not database-level, and `tools/setup-db-roles.sql` is a deployment precondition rather than schema (§5). After any restore into a fresh cluster:

```sh
psql "<direct url as postgres>" \
  -v owner_role=plantops -v app_login_role=plantops_app \
  -f tools/setup-db-roles.sql
npm run migration:show     # confirm the chain matches the deployed code
```

Then boot the API and confirm it does not fail the RLS startup check — a restore that silently left the app role owning the tables is exactly the §8.3 shape.

**Exporting audit for a client** goes through the console (Doc 09 §2.3), not through `psql`. The export is itself audited as `audit.exported`, and a direct database dump is not.

---

## 10. Rollback

Rolling back application code is a Railway redeploy of the previous image and needs nothing from this document.

Rolling back **schema** is different, and the honest answer is that you usually should not.

- If the migration was expand-only (§3.1), the previous code runs fine against the new schema. Roll the code back and leave the schema alone. This is the case the expand/contract rule buys you, and it is why the rule exists.
- If it was not, `npm run migration:revert` undoes exactly one migration, from a human's shell, against the direct URL. Read `down()` first. A `down()` that drops a column drops the data in it; a `down()` that was never exercised is not a rollback plan.
- The release step deliberately cannot revert. Nothing automated should be able to.

Before reverting anything, take a snapshot. A revert is a schema change made under pressure, which is the change most likely to need undoing itself.

---

## 11. What this pipeline does not do yet

Stated plainly, because a runbook that implies more automation than exists is worse than none.

- **CI does not publish images.** The `image` job proves the Dockerfile builds; Railway builds what it deploys. Session 41 makes a tagged, published image the artifact — which a self-hosted install needs and the managed platform does not.
- **The deployed version is not visible at runtime.** `/health` reports uptime, not a build. Support for any install begins with "what version are you on", and today the answer comes from the Railway dashboard. Session 41 stamps `APP_VERSION` and reports it (Doc 11 §8, gap 8).
- **Migrations run from CI, not from the release image.** That is fine here — the runner has a Node toolchain. It is not fine on a client's server, which is why Session 41 adds a one-shot migration container (Doc 11 §5.3).
- **There is no production environment yet.** The release job targets `staging`. Promoting to production is the same job against a second GitHub Environment, with a required reviewer on it.
- **The resolve load smoke reports but does not gate.** `load-smoke.e2e.ts` asserts that a cached resolve reads none of the resolution tables, measured as a delta over `pg_stat_all_tables`. Those counters are global and flushed asynchronously — a backend holds its counts pending until something gives it another query — so work finished *before* the measurement can land inside it. On CI it reported 44–68 scans against a budget of 30, spread evenly across tables in a way no number of cache misses could produce, and it has never reproduced locally: not on CI's exact Postgres image, not under CPU throttling, not at four times the concurrency, not across the full battery.
  It therefore runs in its own `continue-on-error` step: still executed, still reported, unable to block a release while every correctness suite is green. **The fix is known and unwritten**: assert the cached delta against the *uncached control delta from the same run*, so contamination common to both cancels out, instead of against an absolute budget that shared infrastructure can breach on its own. Until then, read that step's result by eye after a deploy — a delta in the hundreds would mean the cache really had stopped working, and that is still worth knowing.
- **No cross-version migration test.** Nothing proves the chain applies cleanly across a version gap. Session 49.
- **Password-reset delivery has no transport bound.** `password-reset.delivery.ts` is a port that refuses to print tokens in production. Session 47.
