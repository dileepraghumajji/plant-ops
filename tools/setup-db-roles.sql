-- Database role provisioning — run ONCE per database, by an administrator,
-- BEFORE the first migration (Doc 07 §5.1).
--
--   local:     psql -U postgres -d plantops_iam \
--                -v owner_role=plantops -v app_login_role=plantops_app \
--                -f tools/setup-db-roles.sql
--   Supabase:  same, connected as `postgres` — the one and only time that
--              role is used. It must never appear in a connection string.
--
-- Why this is not a migration: creating roles needs CREATEROLE, and the
-- migration role deliberately does not have it. Roles are a deployment
-- precondition, not schema.
--
-- ── The shape, and why ────────────────────────────────────────────────────
--
--   owner_role      owns schema `iam`, every table, and iam.write_audit.
--                   Runs migrations only.            → DATABASE_DIRECT_URL
--   iam_app         a NOLOGIN *group* holding the runtime privilege bundle.
--                   Migrations grant to this name, so they never need to know
--                   what the environment called its login role.
--   app_login_role  the runtime connection. Owns nothing, inherits iam_app.
--                                                    → DATABASE_URL
--
-- A table's OWNER is exempt from its own RLS policies — independent of
-- SUPERUSER and BYPASSRLS. Connecting as the owner therefore disables every
-- policy silently, while the non-superuser/non-BYPASSRLS startup assertion
-- still passes (Doc 07 §5.1). The split is the fix; `force row level
-- security` in the migrations is the second lock.
--
-- Idempotent: safe to re-run.

\set ON_ERROR_STOP on

-- The privilege bundle. NOLOGIN: nothing ever connects as it, so it cannot be
-- a credential. Migration 0007 grants it usage/DML; nothing is granted here.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'iam_app') then
    create role iam_app nologin;
  end if;
end
$$;

-- Membership. INHERIT is required: without it the login role would hold the
-- privileges only after an explicit SET ROLE, and every query would fail with
-- "permission denied for schema iam".
--
-- Two separate switches control this, and both must be on:
--   * the role attribute      — ALTER ROLE … INHERIT
--   * the membership grant    — GRANT … WITH INHERIT TRUE   (PostgreSQL 16+)
-- A grant made while the role was NOINHERIT keeps `inherit_option = false`
-- forever; a later ALTER ROLE does *not* reach back and change it. Set the
-- attribute first, then state the grant's option explicitly, so neither the
-- order of this script nor the role's prior state can matter.
alter role :"app_login_role" inherit;
grant iam_app to :"app_login_role" with inherit true;

-- The owner role must be able to create schema `iam` (migration 0001).
--
-- Locally this is a no-op — the owner already owns the database. On a managed
-- host it is not: measured on Supabase (PostgreSQL 17.6), the database ACL is
-- `{=Tc/postgres,postgres=CTc/postgres,...}`, so PUBLIC holds CONNECT and TEMP
-- but *not* CREATE. Without this grant the very first migration fails at
-- `create schema iam` with "permission denied for database", after the roles
-- have been set up and everything looks correct.
--
-- `format` with `%I` rather than psql interpolation: GRANT will not take
-- `current_database()` as an expression, and the database name is not one of
-- this script's parameters — it is wherever you connected.
select set_config('plantops.owner_role', :'owner_role', false);

do $$
declare
  _owner text := current_setting('plantops.owner_role', true);
begin
  execute format('grant create on database %I to %I', current_database(), _owner);
end
$$;

-- Guard rails. These are the properties the startup check re-asserts at boot
-- (Doc 07 §5.1); failing here is far cheaper than failing in production.
--
-- The name is handed to the server as a setting first: psql does not
-- interpolate `:variables` inside a dollar-quoted body, so the DO block below
-- cannot read one directly.
select set_config('plantops.app_login_role', :'app_login_role', false);

do $$
declare
  _app   text := current_setting('plantops.app_login_role', true);
  _super boolean;
  _bypass boolean;
begin
  select rolsuper, rolbypassrls into _super, _bypass
    from pg_roles where rolname = _app;

  if _super then
    raise exception 'app role % is a SUPERUSER — RLS would be skipped entirely', _app;
  end if;
  if _bypass then
    raise exception 'app role % has BYPASSRLS — RLS would be skipped entirely', _app;
  end if;
end
$$;

-- Report the result rather than exiting silently.
select r.rolname,
       r.rolcanlogin  as can_login,
       r.rolinherit   as inherits,
       r.rolsuper     as superuser,
       r.rolbypassrls as bypassrls
  from pg_roles r
 where r.rolname in (:'owner_role', :'app_login_role', 'iam_app')
 order by r.rolname;
