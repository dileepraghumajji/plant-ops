# 07 — Database & RLS

> How the IAM uses Supabase (as plain Postgres) with TypeORM, how migrations and Row-Level Security are managed by hand, and how tenant + scope isolation is enforced at the database layer.

---

## 1. Supabase's role here

Supabase is used **only as a managed Postgres host**. We do **not** use:
- Supabase Auth (we issue our own JWTs — Doc 03),
- Supabase auto-generated REST/GraphQL,
- the Supabase client SDK in the backend.

We **do** use: the Postgres connection string, connection pooling (Supabase's pooler / PgBouncer), the `ltree` and `pgcrypto` extensions, and Postgres RLS.

Consequence: TypeORM owns the schema and migrations; RLS is written by hand in SQL migrations. This is a deliberate trade — we give up Supabase conveniences to keep full control of our own IAM.

## 2. Connection & pooling

- Connect via the Supabase connection string (use the **pooler** endpoint for the app; the direct endpoint for running migrations).
- With PgBouncer in transaction mode, disable prepared statements in TypeORM (or use the session-mode port for migrations). Document which port is used where in the env config.
- Enable extensions once (migration): `create extension if not exists ltree;` and `pgcrypto` (for `gen_random_uuid()`).

## 3. TypeORM setup

- **Entities** map the tables in Doc 01. Use explicit column types matching the data model (`uuid`, `text`, `jsonb`, `timestamptz`, enums as Postgres enums or text+check).
- **Migrations** are authored (or generated then reviewed) and version-controlled; **never** use `synchronize: true` in any shared/prod environment.
- `scope_node.path` uses the `ltree` type; add a TypeORM column with `type: 'ltree'` (or raw) and maintain it via triggers/service logic.
- Naming: snake_case columns, singular table names as in Doc 01.

## 4. Migration strategy

1. Extensions + enums first.
2. Registry tables (application, permission, nav_node).
3. Tenant tables (client, scope_node, user, service_account, role, …).
4. Mapping tables (client_application, role_permission, menu_permission, role_binding, user_identity, session).
5. audit_trail.
6. **RLS policies** (separate, clearly-named migrations — §6).
7. Seed: platform-admin bootstrap (see §8).

Each migration is reversible where practical; destructive changes are explicit and reviewed.

## 5. Request context for RLS

RLS depends on knowing the current tenant and subject. The app sets these as **transaction-local** settings at the start of each request's DB work:

```sql
select set_config('app.current_client_id', $1, true);   -- true = local to txn
select set_config('app.current_user_id',   $2, true);
select set_config('app.is_platform_admin', $3, true);    -- 'true' | 'false'
```

Implement via a TypeORM transaction wrapper / interceptor that runs these before the request's queries. Because they are transaction-local, they cannot leak between pooled connections.

> **PROVENANCE — the load-bearing rule (Invariant I0/I5).** The values bound to `app.current_client_id`, `app.current_user_id`, and `app.is_platform_admin` MUST be sourced **only** from the verified JWT claims (`cid`, `sub`, and the platform-admin determination), taken from the `AuthGuard`'s validated token context. They MUST NEVER be read from a request body, header, query param, path segment, or any client-supplied field. RLS is the last line of defense, but it *trusts these session vars completely* — a single interceptor that sets `client_id` from `req.body.clientId` or a `X-Client-Id` header collapses tenant isolation across the entire system, and the database will faithfully enforce the wrong tenant. Enforce this structurally: the context-setter accepts *only* the AuthGuard's token object as input, and `is_platform_admin` is derived from the token's platform-scope binding, not passed in. Add a lint/review gate so no code path can set these from `req`.

> The database connection role used by the app must be a **non-superuser, non-BYPASSRLS** role, or RLS is silently skipped. This is the single most common RLS misconfiguration — assert it in a startup check.

## 6. RLS policies (hand-written)

Enable RLS on every tenant-owned table and add policies. Pattern for a tenant table (e.g. `role`):

```sql
alter table iam.role enable row level security;

create policy role_tenant_isolation on iam.role
  using (
    current_setting('app.is_platform_admin', true) = 'true'
    or client_id = current_setting('app.current_client_id', true)::uuid
  )
  with check (
    client_id = current_setting('app.current_client_id', true)::uuid
  );
```

**Write-path note (Item: platform `with check`).** The pattern above intentionally has an asymmetric `with check`: platform admins may *read* across tenants (via the `using` clause's `is_platform_admin` branch) but the `with check` restricts *writes* to the current `client_id` — so a platform admin cannot accidentally write a tenant row under the wrong `client_id`. Platform admins do not write tenant tables through this path at all; they operate on registry/catalog tables (below) and on client provisioning via dedicated flows that set `app.current_client_id` to the target client explicitly. If any tenant-table write genuinely must be platform-initiated, it runs inside a context where `app.current_client_id` is set to the intended client — never via a platform bypass on the `with check`.

**Direct-`client_id` tables** — apply the exact `role`-shaped policy to every table that carries `client_id`: `client` (self row: `id = current_setting('app.current_client_id')::uuid`), `scope_node`, `user`, `service_account`, `role`, `role_binding`, `user_identity`, `session`.

**Join tables without their own `client_id`** (`role_permission`, `menu_permission`) need policies that reach the parent's tenant — the "apply the same shape" shorthand does **not** work here and, if skipped, leaks role/menu composition across tenants (violates I5). Explicit policies:

```sql
-- role_permission: tenant-owned via its role's client_id
alter table iam.role_permission enable row level security;

create policy rp_tenant_isolation on iam.role_permission
  using (
    current_setting('app.is_platform_admin', true) = 'true'
    or exists (
      select 1 from iam.role r
      where r.id = role_permission.role_id
        and r.client_id = current_setting('app.current_client_id', true)::uuid
    )
  )
  with check (
    exists (
      select 1 from iam.role r
      where r.id = role_permission.role_id
        and r.client_id = current_setting('app.current_client_id', true)::uuid
    )
  );
```

The `exists` subquery is indexed (`role.id` is PK), so cost is a single index lookup per row touched. `menu_permission` is **catalog, not tenant data** — it gates `nav_node`s that belong to applications, not clients — so it follows the catalog pattern below (globally readable, platform-only write), *not* the join-table tenant pattern. This is a deliberate split: role composition is tenant-sensitive; menu-permission mapping is part of the shared app catalog.

Registry/catalog tables (`application`, `permission`, `nav_node`, `menu_permission`) are **globally readable** (any authenticated subject may read the catalog of apps enabled for them) but **writable only by platform admins**. Apply the shape below to all four (`menu_permission` included — see the split rationale above):

```sql
create policy app_catalog_read  on iam.application for select using (true);
create policy app_catalog_write on iam.application for all
  using (current_setting('app.is_platform_admin', true) = 'true')
  with check (current_setting('app.is_platform_admin', true) = 'true');
```

**audit_trail** — append-only *and* **non-forgeable**. A naive `insert with check (true)` is wrong: it lets any authenticated context insert audit rows with an arbitrary `actor_id`/`client_id`/`action`, so an attacker (or a buggy service) could fabricate or misattribute audit history. Audit is written **only through a `SECURITY DEFINER` function** that stamps the actor and tenant from session context; the app role has **no direct INSERT** on the table.

```sql
alter table iam.audit_trail enable row level security;

-- Read: platform sees all; a client sees its own rows.
create policy audit_read on iam.audit_trail for select using (
   current_setting('app.is_platform_admin', true) = 'true'
   or client_id = current_setting('app.current_client_id', true)::uuid
);

-- No insert/update/delete POLICIES for the app role ⇒ direct writes are denied.
-- Writes go only through this function, which runs as its owner (a role that CAN insert).
create or replace function iam.write_audit(
  _action      text,
  _target_type text,
  _target_id   uuid,
  _payload     jsonb default '{}'::jsonb
) returns uuid
language plpgsql
security definer
set search_path = iam, pg_temp
as $$
declare
  _id          uuid := gen_random_uuid();
  _client_id   uuid := nullif(current_setting('app.current_client_id', true), '')::uuid;
  _actor_id    uuid := nullif(current_setting('app.current_user_id',   true), '')::uuid;
  _actor_type  text := case
                         when current_setting('app.is_platform_admin', true) = 'true' then 'platform'
                         when _actor_id is not null then 'user'
                         else 'service_account'
                       end;
begin
  insert into iam.audit_trail
    (id, client_id, actor_type, actor_id, action, target_type, target_id, payload, created_at)
  values
    (_id, _client_id, _actor_type, _actor_id, _action, _target_type, _target_id, _payload, now());
  return _id;
end;
$$;

-- Lock it down: app role may EXECUTE the function but not touch the table directly.
revoke all on iam.audit_trail from app_role;
grant  select on iam.audit_trail to app_role;              -- reads still pass through RLS
grant  execute on function iam.write_audit(text,text,uuid,jsonb) to app_role;

-- Belt and braces against tampering:
revoke insert, update, delete, truncate on iam.audit_trail from app_role;
-- The function's OWNER must be a role distinct from app_role and must NOT be a superuser
-- beyond what it needs; it exists solely to own this insert path.
```

Consequences: the app can only append, never mutate or delete, and cannot spoof `actor_id`/`client_id`/`actor_type` because the function derives them from the verified session context (which itself is JWT-sourced, §5). `TRUNCATE` is explicitly revoked (it is a separate privilege from DELETE and would otherwise bypass the append-only intent). Migrations that must touch audit (e.g. retention archival, Doc 10) run as a dedicated maintenance role, out of band, and are themselves audited.

> **Never** log secrets, password/token hashes, or raw credentials into `payload` (Section 5.8). The service layer is responsible for redacting sensitive fields before calling `write_audit`.

## 7. Scope-path integrity

- **Labels are `id`-derived**, not name-derived (Doc 01 §3.5): `label = 'n_' || replace(id::text, '-', '')`. This keeps labels ltree-legal and rename-stable, so renaming a node's display `name` never rewrites any `path`. Only a **move** (reparenting) changes paths.
- Maintain `scope_node.path` on insert and on move. On **insert**: `path = parent.path || new_label` (root nodes: `path = label`). On **move**: recompute the subtree paths in a **single statement**: `update … set path = new_prefix || subpath(path, nlevel(old_prefix)) where path <@ old_prefix`.
- Index `path` with a GiST index for `<@` / `@>` subtree queries.
- **Concurrency (mandatory ordering — the highest-risk case in the system).** A move MUST follow: capture affected subject ids (bindings whose `scope_node_id` is in the subtree) → `BEGIN` at **`REPEATABLE READ`** (or `SERIALIZABLE` under contended moves; retry on serialization failure) → single-statement subtree path rewrite → `COMMIT` → **only then** publish `perms.invalidated` for the captured subjects. Never invalidate before commit (a reader would repopulate the cache from the pre-move tree and re-poison it). Concurrent binding inserts into the same subtree serialize behind the move. Full rationale and the safe-failure argument (uncertainty must fall to *deny*) are in Doc 04 §7.1.

## 8. Bootstrap seed

The very first platform admin cannot be created through the authorized API (chicken-and-egg). Seed it via migration/CLI:
- Create a platform `service_account` (or user) with `iam.platform.*`.
- Its secret is provided out-of-band (env) and rotated immediately after first use.
- Audit the bootstrap as `platform.bootstrap`.

## 9. Data-integrity constraints (DB-level)

- `role_binding`: `check ((user_id is not null) <> (service_account_id is not null))` — exactly one subject.
- `unique(application_id, key)` on permission; `unique(application_id, key)` on nav_node.
- `unique(client_id, email)` on user; `unique(client_id, name)` on role.
- FKs with sensible `on delete` (restrict for scope_node with bindings; cascade for role_permission when role deleted, with audit written by the service before deletion).

## 10. Performance notes

- Index `role_binding` by `(client_id, user_id)` and `(role_id)`.
- GiST index on `scope_node.path`.
- The hot path (`/permissions/resolve`) is cache-served (Doc 04); the DB query behind it joins `role_binding → role_permission → permission` and `scope_node` — index accordingly.
