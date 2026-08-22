# `@plantops/db`

TypeORM entities, migrations, and the data sources behind the IAM (Doc 07, Doc 08 §2).

Imported by `apps/iam-api` and **nothing else** — no other app touches IAM tables
directly, they call the API. The boundary is enforced by
`@nx/enforce-module-boundaries`, not by etiquette. This lib in turn may depend
only on `@plantops/contracts`.

## Two connections, on purpose

| | URL | Used for |
|---|---|---|
| `createAppDataSource` | `DATABASE_URL` | serving requests |
| `createMigrationDataSource` | `DATABASE_DIRECT_URL` — always **direct**, never pooled | migrations, release step |

Whether a pooler sits in front of `DATABASE_URL` is `DATABASE_POOLED`, and it is
configuration rather than something inferred from the variable's name. On a
managed host it is `true` and the two URLs are two endpoints; in the bundled
stack and against a client's own server it is `false` and both URLs name the
same Postgres, differing only in **role** (Doc 07 §5.1). The schema refuses the
combination that describes a pooler which is not there — `true` with both URLs
on one host and port.

A pooler in transaction mode hands a server connection back after every
transaction, so nothing may pin session state to one. That is why nothing in
this lib ever names a prepared statement — node-postgres prepares only *named*
queries, and TypeORM never supplies a name, so the guarantee is structural and
`usesPreparedStatements()` reports the permission rather than flipping a driver
flag that does not exist. `installExtensions` and `synchronize` are off for
reasons of their own (extensions are migration-owned; schema changes are
reviewed migrations — Doc 07 §3), and the RLS context is transaction-local
because a per-request tenant is.

TLS is `DATABASE_SSL`: `disable`, `verify-ca` (chain against
`DATABASE_CA_CERT`, hostname not — a client's own certificate authority and an
address it does not name), or `verify-full`. `true`/`false` still parse, as
`verify-full`/`disable`. No mode encrypts without verifying.

Both take a plain settings object rather than importing `@plantops/config`;
`apps/iam-api` passes the validated env through.

## Migrations

```bash
npm run migration:run      # apply everything pending
npm run migration:revert   # undo the last applied migration
npm run migration:show     # applied / pending
```

Each delegates to `nx run @plantops/db:migration:<cmd>` → `tools/migrate.ts`,
which always connects over `DATABASE_DIRECT_URL`. The runner lives in `tools/`
because it needs both `@plantops/config` and `@plantops/db`, and `tools/` is
outside the boundary graph.

TypeORM orders migrations by the **13-digit timestamp ending the class name**,
not by the `0001-`/`0002-` filename prefix or by array position in
`src/migrations/index.ts`. `migrations.spec.ts` pins all three together.

The chain follows Doc 07 §4: extensions and enums → registry → tenant →
mapping → audit → indexes. Indexes are split into their own migration on
purpose: the unique indexes living beside their tables in `0002`–`0004` carry
*invariants*, while `0006` is only about access paths and can be re-tuned
without reopening a migration that defines what is legal.

Migrations never import live constants from the entities. An applied migration
is history; if it read a constant, editing that constant would retroactively
change what the migration claims to have done. Tests cross-check instead.

## Tests

`nx test @plantops/db` runs two kinds:

- **Unit** — entity metadata (snake_case singular names, explicit column types,
  `timestamptz`, the unique keys carrying Doc 01 §6), data-source options, and
  migration ordering. No database.
- **Integration** — `*.integration.spec.ts`. These run the real migration chain
  and prove each constraint by watching Postgres reject an insert. They **skip**
  when `DATABASE_DIRECT_URL` is unset, so the suite stays green without a
  database; `jest.config.cts` loads the workspace `.env`.

The integration suites are destructive — they drop and rebuild the `iam` schema.
Point them at a scratch database. `jest.config.cts` sets `maxWorkers: 1` so two
suites cannot rebuild it at once; their shared plumbing lives in
`src/testing/integration-harness.ts`, which is excluded from the published lib.

```bash
docker compose up -d postgres
cp .env.example .env        # then fill in
npx nx test @plantops/db
```

### Local Postgres without Docker (Windows)

Docker is not installed on the current dev machine, so the cluster the suites
run against is a plain extracted PostgreSQL 17.6 — no service, no admin rights,
no installer. Binaries in `D:\tools\pgsql`, data in `D:\tools\pgdata`:

```powershell
D:\tools\pgsql\bin\pg_ctl.exe -D D:\tools\pgdata -l D:\tools\pgdata\server.log start
D:\tools\pgsql\bin\pg_ctl.exe -D D:\tools\pgdata status
D:\tools\pgsql\bin\pg_ctl.exe -D D:\tools\pgdata stop
```

The server does **not** survive a reboot — start it before running the suites.

The app role is deliberately weak:

```sql
create role plantops with login password 'plantops'
  nosuperuser nocreatedb nocreaterole noinherit nobypassrls;
create database plantops_iam owner plantops;
```

`nobypassrls` and `nosuperuser` are not incidental. RLS is **silently skipped**
for a superuser (Doc 07 §5), so developing against `postgres` would let
Session 5's isolation tests pass for entirely the wrong reason. Owning the
database is enough privilege for the rest: `ltree` and `pgcrypto` are *trusted*
extensions in PG 13+, so migration `0001` needs no superuser.

Supabase remains the target for staging (Session 39), not local work. Two things
bite there: the direct endpoint `db.<ref>.supabase.co` is IPv6-only without the
IPv4 add-on — use the session pooler (`aws-N-<region>.pooler.supabase.com:5432`,
user `postgres.<ref>`) — and the pooler presents Supabase's *private* CA
(`Supabase Root 2021`), which `rejectUnauthorized: true` correctly rejects until
that root is supplied as `ca`.

## Schema notes worth knowing before you touch it

- **`scope_node.path` is a real `ltree`.** Coverage is `<@` over the GiST index
  `scope_node_path_gist`; a text path is explicitly not a substitute (Doc 01
  §3.5). Labels are `n_` + the node's UUID hex — use `scopePathLabel()`, never
  the display name. A check constraint enforces it, so a rename touches `name`
  alone and cannot rewrite the paths beneath it.
- **`unique (id, client_id)` on `scope_node`, `user` and `role`** looks
  redundant next to the primary key. It exists so `role_binding` can carry
  `client_id` into its foreign keys, making Doc 02 §6's cross-tenant rules a
  database guarantee. `service_account` is the exception — a platform account
  has a null `client_id`, so its binding FK is a plain one.
- **`role_binding` duplicate prevention** is an *expression* unique index on
  `(coalesce(user_id, service_account_id), role_id, scope_node_id)`, because the
  subject lives in whichever column is populated.
- **`audit_trail` has no `updated_at` and no foreign keys**, both deliberately:
  there is no update path to stamp, and audit must outlive whatever it
  describes. Read through the entity; never write through it — Session 5 revokes
  the grants and leaves `iam.write_audit()` as the only way in.

## What is here so far

Sessions 3–4 of the roadmap — the complete schema, minus RLS:

| Migration | Contents |
|---|---|
| `0001` | extensions, the `iam` schema, and **every** enum in the data model |
| `0002` | registry/catalog: `application`, `permission`, `nav_node` |
| `0003` | tenant: `client`, `scope_node`, `user`, `service_account`, `role` |
| `0004` | mapping: `client_application`, `role_permission`, `menu_permission`, `role_binding`, `user_identity`, `session` |
| `0005` | `audit_trail` |
| `0006` | performance indexes (Doc 07 §10) |

The hand-written RLS policies, the transaction-local request context, the
non-forgeable `iam.write_audit` function and the bootstrap seed arrive in
Session 5.
