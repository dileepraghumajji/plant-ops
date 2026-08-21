#!/bin/sh
#
# Creates the two database roles Doc 07 §5.1 requires, on the bundled Postgres,
# the first time its data directory is initialised.
#
# ## Why a stack cannot skip this
#
# A table's OWNER is exempt from its own RLS policies — independently of
# SUPERUSER and of BYPASSRLS. So a deployment that serves requests as the role
# that ran the migrations has silently switched off every policy in the system,
# while looking completely healthy. `assertRlsEnforceable` in `libs/db` refuses
# to boot rather than allow it, which is why a stack brought up without this
# script does not start: that is the check working, not a broken compose file.
#
# ## Why the real script is mounted rather than copied
#
# `tools/setup-db-roles.sql` is the authority — the same file CI runs and the
# same file an administrator runs against a managed Postgres. Reproducing its
# grants here would create a second, drifting definition of the most
# consequential thing in the deployment. This script only does the part that
# file deliberately does not: creating the login role, which needs CREATEROLE
# and is therefore a precondition rather than schema.
#
# Roadmap Session 42 replaces the whole arrangement with `bootstrap-install.mjs`,
# which does this against *any* Postgres — including a client's existing one,
# which this stack's bundled server is not.
set -eu

: "${PLANTOPS_APP_ROLE:=plantops_app}"

if [ -z "${PLANTOPS_APP_PASSWORD:-}" ]; then
  echo "10-roles.sh: PLANTOPS_APP_PASSWORD is not set — refusing to create a login role without one." >&2
  exit 1
fi

# `format` with %I/%L rather than string interpolation: the role name and the
# password arrive from the environment, and a password with a quote in it should
# be a password, not a syntax error.
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
     -v app_role="$PLANTOPS_APP_ROLE" -v app_password="$PLANTOPS_APP_PASSWORD" <<'SQL'
select set_config('plantops.app_role', :'app_role', false),
       set_config('plantops.app_password', :'app_password', false);

do $$
declare
  _role text := current_setting('plantops.app_role');
  _pw   text := current_setting('plantops.app_password');
begin
  if not exists (select 1 from pg_roles where rolname = _role) then
    execute format('create role %I login password %L', _role, _pw);
  else
    execute format('alter role %I login password %L', _role, _pw);
  end if;
end
$$;
SQL

# The grants, the group membership and the guard rails — from the canonical
# file, mounted read-only outside `docker-entrypoint-initdb.d` so Postgres's own
# entrypoint does not also try to run it without the variables it needs.
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
     -v owner_role="$POSTGRES_USER" -v app_login_role="$PLANTOPS_APP_ROLE" \
     -f /opt/plantops/setup-db-roles.sql
