# Running PlantOps locally

Everything below was executed on this machine on 2026-08-18 and works as
written. It covers: starting the dependencies, inspecting the database, and
getting from a blank login screen to a signed-in platform admin and tenant
admin.

This is a **development** guide. The production path is Doc 08 §6 and the ops
runbook (roadmap Session 39).

---

## 1. Start the dependencies

### Postgres

Postgres is installed from EDB's *binaries zip* — there is no Windows service,
so it does **not** start on boot. Start it before anything else:

```sh
D:/tools/pgsql/bin/pg_ctl.exe -D D:/tools/pgdata -l D:/tools/pgdata/server.log start
```

Check it:

```sh
D:/tools/pgsql/bin/pg_isready.exe -h localhost -p 5432
# localhost:5432 - accepting connections
```

Stop it when you are done (optional — it is harmless to leave running):

```sh
D:/tools/pgsql/bin/pg_ctl.exe -D D:/tools/pgdata stop
```

If it refuses to start, the reason is in `D:\tools\pgdata\server.log`.

### Redis

Redis is a bare `redis-server.exe`, also not a service:

```sh
"C:/Users/dilee/Downloads/redis-server.exe" &
```

**The API runs without Redis** — the grants cache misses through to Postgres and
the revocation cache falls back to the `session` table — so `Revocation cache
unavailable` in the log is expected, not a fault. Run it when you want to
exercise the real cache path.

> One caveat while testing: several `iam-api` integration suites currently fail
> when Redis is **up**, because their fixtures insert `role_binding` rows with
> raw SQL and skip the invalidation hook. That is a test-fixture defect, not a
> product one. If `nx test @plantops/iam-api` goes red, check whether Redis is
> running before assuming a regression.

### Schema and seed

First time only, or after a schema rebuild:

```sh
npm run migration:run
```

---

## 2. Looking at the database

The command-line client ships with Postgres:

```sh
PGPASSWORD=plantops D:/tools/pgsql/bin/psql.exe -h localhost -U plantops -d plantops_iam
```

Connection details, for a GUI client (pgAdmin, DBeaver, DataGrip, TablePlus):

| | |
|---|---|
| Host | `localhost` |
| Port | `5432` |
| Database | `plantops_iam` |
| User | `plantops` |
| Password | `plantops` |
| Schema | `iam` (not `public`) |

Everything lives in the **`iam` schema**, so remember to qualify names:

```sql
\dt iam.*                                  -- the 16 tables
select email, status from iam."user";      -- "user" is a reserved word: keep the quotes
select slug, name, status from iam.client;
select name, is_system from iam.role;
select action, actor_email, occurred_at from iam.audit_trail order by occurred_at desc limit 20;
```

> **What you see is filtered by RLS.** The `plantops` role owns the tables and is
> deliberately *not* superuser and *not* BYPASSRLS (Doc 07 §5). Some queries will
> return fewer rows than you expect until you set the request context —
> that is the isolation working, not a broken query.

---

## 3. Start the API and the console

Two terminals:

```sh
npx nx run @plantops/iam-api:serve     # → http://localhost:3000
npx nx dev @plantops/admin-web         # → http://localhost:4200
```

Before the first run of the console:

```sh
cp apps/admin-web/.env.example apps/admin-web/.env.local
```

And make sure the API's `.env` lets the browser talk to it — without this every
request from the console is blocked by CORS before it is sent:

```
CORS_ALLOWED_ORIGINS=http://localhost:4200
```

Sanity checks:

```sh
curl localhost:3000/health   # {"status":"ok"}
curl localhost:3000/ready    # {"status":"ready","checks":{"postgres":"up","redis":"up"}}
```

---

## 4. Getting a login that works

The login screen asks for **client**, **email** and **password**. On a fresh
database none of those exist yet: the only identity the seed creates is the
platform **service account**, which authenticates with a key and secret and
cannot use a login form (Doc 03 §5).

So the first human is created through the API. Below, `$SECRET` is
`PLATFORM_BOOTSTRAP_SECRET` from `.env`.

### 4.0 Register the IAM's own menu (once)

Without this the sidebar is empty — the console renders `/iam/navigation`, and
the nav catalog is data:

```sh
npm run manifest:seed-iam
```

### 4.1 A token for the platform service account

```sh
SECRET=$(grep '^PLATFORM_BOOTSTRAP_SECRET=' .env | cut -d= -f2-)
PT=$(curl -s -X POST http://localhost:3000/auth/token \
  -H 'content-type: application/json' \
  -d "{\"account_key\":\"platform-bootstrap\",\"account_secret\":\"$SECRET\"}" \
  | node -pe "JSON.parse(require('fs').readFileSync(0,'utf8')).access_token")
```

### 4.2 A human platform admin

The seed already created a `platform` client, a `Platform` root scope node and a
`Platform Admin` role carrying every `iam.platform.*` permission — but bound only
to the service account. Two calls give it a human.

```sh
# The id of the platform client
PLAT=$(curl -s "http://localhost:3000/iam/clients?limit=50" -H "authorization: Bearer $PT" \
  | node -pe "JSON.parse(require('fs').readFileSync(0,'utf8')).data.find(c=>c.slug==='platform').id")

# A user in it. This gives them Client Admin, not Platform Admin — yet.
curl -s -X POST "http://localhost:3000/iam/clients/$PLAT/admins" \
  -H "authorization: Bearer $PT" -H 'content-type: application/json' \
  -d '{"email":"root@plantops.test","full_name":"Platform Root","password":"Platform-Root-Pass-1"}'
```

Now sign in **as that user** and bind them to the `Platform Admin` role. They can
do this themselves: the role, the scope node and the user are all in the platform
client, and a client admin may create bindings within their own client.

```sh
T=$(curl -s -X POST http://localhost:3000/auth/login -H 'content-type: application/json' \
  -d '{"email":"root@plantops.test","password":"Platform-Root-Pass-1","client_slug":"platform"}' \
  | node -pe "JSON.parse(require('fs').readFileSync(0,'utf8')).access_token")

ROLE=$(curl -s "http://localhost:3000/iam/roles?limit=50" -H "authorization: Bearer $T" \
  | node -pe "JSON.parse(require('fs').readFileSync(0,'utf8')).data.find(r=>r.name==='Platform Admin').id")
NODE=$(curl -s "http://localhost:3000/iam/scopes" -H "authorization: Bearer $T" \
  | node -pe "JSON.parse(require('fs').readFileSync(0,'utf8')).tree[0].id")
USER=$(curl -s "http://localhost:3000/iam/users?limit=50" -H "authorization: Bearer $T" \
  | node -pe "JSON.parse(require('fs').readFileSync(0,'utf8')).data.find(u=>u.email==='root@plantops.test').id")

curl -s -X POST http://localhost:3000/iam/role-bindings \
  -H "authorization: Bearer $T" -H 'content-type: application/json' \
  -d "{\"user_id\":\"$USER\",\"role_id\":\"$ROLE\",\"scope_node_id\":\"$NODE\"}"
```

Sign out and back in (or just reload) and the Platform section appears.

> This two-step exists because no endpoint creates a *human* platform admin
> directly — `POST /iam/clients/:id/admins` always grants the client-admin role.
> Worth an endpoint or a seed flag eventually; until then, this is the path.

### 4.3 A tenant, and its admin

This is the ordinary onboarding flow, and it is what the Session 30 screens will
do from the UI.

```sh
# 1. The client
CID=$(curl -s -X POST http://localhost:3000/iam/clients \
  -H "authorization: Bearer $PT" -H 'content-type: application/json' \
  -d '{"name":"Acme Industries","slug":"acme"}' \
  | node -pe "JSON.parse(require('fs').readFileSync(0,'utf8')).id")

# 2. Let it use the IAM application — without this its admin has no menu
APP=$(curl -s "http://localhost:3000/iam/applications?limit=50" -H "authorization: Bearer $PT" \
  | node -pe "JSON.parse(require('fs').readFileSync(0,'utf8')).data.find(a=>a.key==='iam').id")
curl -s -X POST "http://localhost:3000/iam/clients/$CID/applications" \
  -H "authorization: Bearer $PT" -H 'content-type: application/json' \
  -d "{\"applications\":[{\"application_id\":\"$APP\",\"enabled\":true}]}"

# 3. Its first administrator — creates user + root scope node + role + binding
curl -s -X POST "http://localhost:3000/iam/clients/$CID/admins" \
  -H "authorization: Bearer $PT" -H 'content-type: application/json' \
  -d '{"email":"admin@acme.test","full_name":"Acme Admin","password":"Acme-Admin-Pass-1"}'
```

### 4.4 What to type on the login screen

| Field | Platform admin | Tenant admin |
|---|---|---|
| **Client** | `platform` | `acme` |
| **Email** | `root@plantops.test` | `admin@acme.test` |
| **Password** | `Platform-Root-Pass-1` | `Acme-Admin-Pass-1` |

Sign in as each in turn — same build, two different sidebars. That is the point
of the whole design: the menu is a projection of the subject's grants, computed
by the server (Doc 05).

---

## 4.5 Running the hardening battery

The Session 38 suite in `apps/iam-api-e2e` is the cross-cutting proof of the
system's security properties: RLS isolation, the whole auth lifecycle, the
resolution matrix, the authorization matrix, cache invalidation, the resolve
load smoke, and the module boundaries. One command:

```sh
npx nx run-many -t e2e
```

It needs Postgres and Redis up (section 1) and nothing else. The target migrates
the database, builds `iam-api`, **starts the built bundle itself** on a free port
with a configuration of its own, runs the battery, and stops it again — so it
does not care whether you have `nx serve` running, and it will not fight your dev
server for port 3000.

Three things worth knowing before the first run:

- **It creates and destroys its own tenants.** Every client it makes is slugged
  `e2e-<file>-…` and is purged and rebuilt at the start of each file. Nothing
  else in the database is touched, but point it at a scratch database anyway.
- **It runs with rate limiting off.** The lockout case alone spends five of
  `/auth/login`'s ten-per-minute budget. The 429 path keeps its own coverage in
  `apps/iam-api`.
- **The API's output is kept**, at
  `apps/iam-api-e2e/test-output/e2e/api.log`. That is the first place to look
  when a case fails, and it is also where the suite reads password-reset tokens
  from — the same line a developer reads, because v1 binds no mail transport.

A single file, when you are working on one:

```sh
npx nx e2e @plantops/iam-api-e2e --testPathPatterns=rls-isolation
```

And the load smoke on its own, against any deployment:

```sh
npm run load:smoke -- --base-url http://localhost:3000   --client-slug acme --email admin@acme.test --password 'Acme-Admin-Pass-1'
```

---

## 5. Things you will run into

**"This account is locked."** Five failed sign-ins lock an account
(`LOGIN_MAX_FAILED_ATTEMPTS` in `.env`), and it does not lift on its own. Another
admin *in the same client* unlocks it:

```sh
curl -X PATCH "http://localhost:3000/iam/users/<user-id>" \
  -H "authorization: Bearer <another admin's token>" \
  -H 'content-type: application/json' -d '{"status":"active"}'
```

Which is why it is worth having two admins per tenant while testing — if you
lock the only one, you are locked out of that client.

**Empty sidebar, "No screens granted".** Either `npm run manifest:seed-iam` has
not been run, or the client does not have the `iam` application enabled (step
4.3.2). It is not a bug in the console: an unmapped menu is hidden by design
(Doc 05 §3).

**A screen shows "You do not have access to this".** That is correct behaviour —
you deep-linked into something your grants do not cover, and the server refused.
The console hides menu items but never enforces; the API does (Doc 09 §4).

**The API refuses to start** with *"the database role plantops_app cannot enforce
row-level security"*. The `libs/db` integration suites leave `force row level
security` off. Rebuild the schema by running the suite that restores it:

```sh
npx nx run @plantops/db:test -- --testPathPatterns "rls-isolation"
```

**Starting over.** The schema is rebuilt from nothing by the db integration
suites, so re-running them and then `npm run manifest:seed-iam` gives you a clean
database. Everything in section 4 then has to be redone — those users live only
in that schema.
