#!/bin/sh
#
# PlantOps — first-boot installer (roadmap Session 42, Doc 11 §5.3).
#
#   ./bootstrap.sh                          install, or resume an install
#   ./bootstrap.sh --verify                 check a finished installation
#   ./bootstrap.sh --rotate-platform-secret retire the one-time credential
#
# ## What it asks of the host
#
# Docker, a POSIX shell, and nothing else. No Node, no curl, no jq, no package
# manager and no internet — Doc 11 §5.1 is explicit that a plant network
# routinely has no egress, and an installer that needs one fails on site on day
# one. Everything that needs a real runtime runs inside a container from the
# bundle: SQL through the `postgres` image's own psql, HTTP through the API
# image's own Node.
#
# ## The order, and why it is this order
#
#   1. **Roles before migrations.** PostgreSQL exempts a table's owner from its
#      own row-level security policies, so the application must connect as a
#      role that owns nothing. The roles have to exist before the migrations
#      create the tables that grant to them — and the application refuses to
#      start if it detects it is the owner, which is the check that turns a
#      silent, total loss of tenant isolation into a stack that will not boot.
#   2. **Migrations before the application.** The compose file states this as a
#      dependency, so it holds on every upgrade too, not only here.
#   3. **Readiness before provisioning.** No point asking the API to create a
#      tenant before it can reach its own database.
#   4. **Verification before reporting success.** An installer whose last line
#      is "done" without having logged in has proved nothing.
#
# Every step is safe to repeat. If this script fails halfway, fix the cause and
# run it again — nothing below creates something it would duplicate.
set -eu

cd "$(dirname "$0")"

# ── Small helpers ───────────────────────────────────────────────────────────

say() { printf '%s\n' "$*"; }
step() { printf '\n==> %s\n' "$*"; }
die() { printf '\nInstall failed: %s\n' "$*" >&2; exit 1; }

# First of the named paths that exists. The bundle is flat — everything sits
# beside this script — while a repository checkout keeps the same files under
# `tools/`. Supporting both means this script is testable where it is developed
# rather than only where it is shipped.
first_existing() {
  for candidate in "$@"; do
    if [ -f "$candidate" ]; then
      printf '%s' "$candidate"
      return 0
    fi
  done
  return 1
}

# One value out of `.env`, without sourcing it. Sourcing would have the shell
# interpret a password containing `$` or a backtick, which is a way to turn a
# strong credential into a syntax error at best.
env_value() {
  sed -n "s/^$1=//p" .env | head -n 1 | sed -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'\$/\1/"
}

# ── Preflight ───────────────────────────────────────────────────────────────

MODE=install
case "${1:-}" in
  '') ;;
  --verify) MODE=verify ;;
  --rotate-platform-secret) MODE=rotate ;;
  --apply-manifests) MODE=manifests ;;
  *) die "unknown option '$1' — expected --verify, --apply-manifests or --rotate-platform-secret" ;;
esac

command -v docker >/dev/null 2>&1 || die 'docker is not installed or not on PATH.'
docker compose version >/dev/null 2>&1 || \
  die 'docker compose (v2) is not available. `docker-compose` v1 will not work.'
docker info >/dev/null 2>&1 || \
  die 'the Docker daemon is not reachable. Is it running, and is this user in the docker group?'

[ -f .env ] || die 'no .env here. Copy .env.template to .env, fill it in, then run this again.'

COMPOSE_FILE=$(first_existing docker-compose.yml docker-compose.prod.yml) || \
  die 'no docker-compose.yml beside this script.'
ROLES_SQL=$(first_existing setup-db-roles.sql ../tools/setup-db-roles.sql) || \
  die 'setup-db-roles.sql is missing from the bundle.'
INSTALLER=$(first_existing bootstrap-install.mjs ../tools/bootstrap-install.mjs) || \
  die 'bootstrap-install.mjs is missing from the bundle.'

# Compose groups containers, networks and volumes under a *project name*, and
# `docker-compose.yml` fixes it at `plantops` so that an upgrade — which happens
# in a freshly unpacked directory with a different name — still finds the
# database it is upgrading rather than starting an empty one beside it.
#
# `PLANTOPS_COMPOSE_PROJECT` overrides that, and exists for the two cases where
# one host holds more than one: a staging copy of an installation beside the
# real one, and CI, which runs this installer on a machine that already has a
# development stack of the same name. Nothing else should set it — two names for
# one installation is how a stack ends up with two database volumes and no idea
# which one has the data.
PROJECT=${PLANTOPS_COMPOSE_PROJECT:-}

dc() {
  if [ -n "$PROJECT" ]; then
    docker compose --project-name "$PROJECT" --file "$COMPOSE_FILE" --env-file .env "$@"
  else
    docker compose --file "$COMPOSE_FILE" --env-file .env "$@"
  fi
}

VERSION=$(env_value PLANTOPS_VERSION)
POSTGRES_USER=$(env_value POSTGRES_USER)
POSTGRES_DB=$(env_value POSTGRES_DB)
APP_ROLE=$(env_value PLANTOPS_APP_ROLE)
[ -n "$POSTGRES_USER" ] || POSTGRES_USER=plantops
[ -n "$POSTGRES_DB" ] || POSTGRES_DB=plantops_iam
[ -n "$APP_ROLE" ] || APP_ROLE=plantops_app

# Everything that has no default and no way to be guessed. Reported together,
# because filling in one blank at a time and re-running is miserable.
missing=''
for key in PLANTOPS_VERSION POSTGRES_PASSWORD PLANTOPS_APP_PASSWORD \
           JWT_SIGNING_KEY_ID JWT_PRIVATE_KEY JWT_PUBLIC_KEY \
           PLANTOPS_CLIENT_NAME PLANTOPS_CLIENT_SLUG \
           PLANTOPS_ADMIN_EMAIL PLANTOPS_ADMIN_NAME PLANTOPS_ADMIN_PASSWORD; do
  [ -n "$(env_value "$key")" ] || missing="$missing $key"
done
# Needed to install; correctly absent from a finished installation.
if [ "$MODE" != 'verify' ] && [ -z "$(env_value PLATFORM_BOOTSTRAP_SECRET)" ]; then
  missing="$missing PLATFORM_BOOTSTRAP_SECRET"
fi
[ -z "$missing" ] || die "these values are empty in .env:$missing
Each one is described in .env.template."

# A pinned deployment names its organisation twice — once for the installer,
# once for the application — and the two must agree. Caught here, this is one
# line of the file to fix; caught at boot it is an API that will not start, on a
# stack that installed perfectly, with a message about a slug the operator
# believes they set correctly.
DEPLOYMENT_MODE=$(env_value DEPLOYMENT_MODE)
PINNED_SLUG=$(env_value SINGLE_TENANT_CLIENT_SLUG)
CLIENT_SLUG=$(env_value PLANTOPS_CLIENT_SLUG)
if [ "${DEPLOYMENT_MODE:-saas}" = 'single_tenant' ]; then
  [ -n "$PINNED_SLUG" ] || die "DEPLOYMENT_MODE=single_tenant but SINGLE_TENANT_CLIENT_SLUG is empty.
It names the organisation this installation serves, and must be the same value
as PLANTOPS_CLIENT_SLUG (\"$CLIENT_SLUG\")."
  [ "$PINNED_SLUG" = "$CLIENT_SLUG" ] || die "the two organisation slugs in .env disagree:
  PLANTOPS_CLIENT_SLUG        $CLIENT_SLUG   (the organisation the installer creates)
  SINGLE_TENANT_CLIENT_SLUG   $PINNED_SLUG   (the organisation the application serves)
Set both to the same value."
fi

# ── Verify / rotate: no installation steps, just the container call ─────────

run_installer() {
  # Copied in rather than mounted: a bind mount would need an absolute host path
  # that is correct inside the container too, which is exactly the thing that
  # differs between the machines this has to run on.
  dc cp "$INSTALLER" iam-api:/tmp/bootstrap-install.mjs >/dev/null
  # `.env` on stdin, so no secret reaches an argument list — not this script's,
  # not docker's, and not the container's.
  dc exec -T iam-api node /tmp/bootstrap-install.mjs "$1" < .env
}

if [ "$MODE" = 'verify' ]; then
  step 'Verifying the installation'
  run_installer verify || die 'the installation did not verify. The failures above say which check.'
  say ''
  say 'This installation is healthy.'
  exit 0
fi

# Re-applies the release's application manifests through the ordinary API
# endpoint. Idempotent: a catalog that already matches reports "no changes" and
# writes no audit record, which is what makes running it on every upgrade free.
apply_manifests() {
  dc run --rm manifests
}

if [ "$MODE" = 'rotate' ]; then
  step 'Rotating the platform credential'
  run_installer rotate || die 'rotation failed.'
  exit 0
fi

if [ "$MODE" = 'manifests' ]; then
  step 'Applying the application catalog from this release'
  apply_manifests || die "the catalog was not applied.

The usual cause is the platform credential. PLATFORM_BOOTSTRAP_SECRET is
deliberately absent from a finished installation (Doc 07 §8), and applying
manifests needs platform authority — so an upgrade supplies the current value
for the length of the upgrade and removes it again afterwards."
  exit 0
fi

# ── 1. Images ───────────────────────────────────────────────────────────────

step "Checking the images for version $VERSION"

image_present() { docker image inspect "$1" >/dev/null 2>&1; }

need_load=0
for image in "plantops/iam-api:$VERSION" "plantops/admin-web:$VERSION" \
             "plantops/proxy:$VERSION" "plantops/migrate:$VERSION" \
             postgres:17 redis:7; do
  image_present "$image" || need_load=1
done

if [ "$need_load" = '1' ]; then
  archive=$(first_existing "images/plantops-$VERSION.tar" images/images.tar) || \
    die "images for $VERSION are not loaded and no archive was found under images/.
If you are upgrading, load the new archive first:
  docker load -i images/plantops-<version>.tar"
  say "Loading $archive — this takes a minute and produces a lot of output."
  docker load -i "$archive"
fi

for image in "plantops/iam-api:$VERSION" "plantops/admin-web:$VERSION" \
             "plantops/proxy:$VERSION" "plantops/migrate:$VERSION" \
             postgres:17 redis:7; do
  image_present "$image" || die "the image $image is still missing after loading.
PLANTOPS_VERSION in .env must match the version of the bundle you loaded."
done
say 'All six images are present.'

# ── 2. Database, and the two roles ──────────────────────────────────────────

step 'Starting PostgreSQL'
dc up -d postgres

say 'Waiting for it to accept connections...'
# Wall-clock, not an iteration count. Each probe below is itself a `docker`
# call that can take a second or ten on a loaded machine, so counting loops
# times the sleep interval understates the real wait by a factor nobody can
# predict — and a timeout that fires after nine minutes when it promised three
# is a timeout that has stopped being a diagnostic.
deadline=$(( $(date +%s) + 180 ))
until [ "$(docker inspect --format '{{.State.Health.Status}}' "$(dc ps -q postgres)" 2>/dev/null)" = 'healthy' ]; do
  [ "$(date +%s)" -lt "$deadline" ] || die 'PostgreSQL did not become healthy within three minutes.
  docker compose logs postgres'
  sleep 3
done

step 'Creating the database roles'
# The login role first: `setup-db-roles.sql` deliberately does not create it,
# because creating a role needs CREATEROLE and the migration role does not have
# it. The password is read from the container's own environment with `\getenv`
# rather than passed as an argument, so it never appears in a process list.
dc exec -T postgres psql -v ON_ERROR_STOP=1 \
  --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<'SQL' >/dev/null
\getenv app_role PLANTOPS_APP_ROLE
\getenv app_password PLANTOPS_APP_PASSWORD

select set_config('plantops.app_role', :'app_role', false),
       set_config('plantops.app_password', :'app_password', false);

do $$
declare
  _role text := current_setting('plantops.app_role');
  _pw   text := current_setting('plantops.app_password');
begin
  if _role is null or _role = '' then
    raise exception 'PLANTOPS_APP_ROLE is not set in the postgres container';
  end if;
  if _pw is null or length(_pw) = 0 then
    raise exception 'PLANTOPS_APP_PASSWORD is not set in the postgres container';
  end if;

  if exists (select 1 from pg_roles where rolname = _role) then
    execute format('alter role %I login password %L', _role, _pw);
  else
    execute format('create role %I login password %L', _role, _pw);
  end if;
end
$$;
SQL

# Then the grants, the group membership and the guard rails — from the file that
# is the authority for them, the same one CI runs and the same one an
# administrator runs against a managed PostgreSQL.
dc exec -T postgres psql -v ON_ERROR_STOP=1 \
  --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  -v owner_role="$POSTGRES_USER" -v app_login_role="$APP_ROLE" < "$ROLES_SQL" >/dev/null

say "Owner: $POSTGRES_USER (migrations only).  Application: $APP_ROLE (owns nothing)."

# ── 3. Schema, then the application ─────────────────────────────────────────

step 'Applying migrations and starting the stack'
# One command: the compose file makes `iam-api` wait for the migration container
# to exit successfully, so this both migrates and starts, in that order, and
# stops if the migration fails.
dc up -d

step 'Waiting for the stack to report ready'
# Through the proxy, using the proxy's own busybox wget — the check a load
# balancer would make, from inside, with no tooling required of the host.
deadline=$(( $(date +%s) + 240 ))
until dc exec -T proxy wget -q -O /dev/null http://127.0.0.1/api/ready 2>/dev/null; do
  [ "$(date +%s)" -lt "$deadline" ] || die 'the stack did not report ready within four minutes.
The API restarts on failure, so a configuration it rejects looks like a stack
that never comes up. Its log names what it rejected:
  docker compose logs iam-api
  docker compose logs migrate'
  sleep 3
done
say 'Ready.'

# ── 4. The tenant and its first administrator ───────────────────────────────

step 'Applying the application catalog from this release'
# Before the tenant, because this is what gives the console a menu: navigation
# is data, computed from the catalog per subject (Doc 05), so an administrator
# created against an unregistered catalog logs in to an empty sidebar and a
# support call. Idempotent, so an install that resumes here changes nothing.
apply_manifests || die 'the application catalog could not be applied.'

step 'Provisioning your organisation'
run_installer provision || die 'provisioning did not complete. Nothing was left half-created; fix the cause above and run this script again.'

# ── 5. Pin the deployment to the organisation that now exists ───────────────
#
# A single-tenant API resolves its organisation once, at boot — which on a
# *first* install is before the organisation exists, because the organisation is
# created through that very API. It starts anyway in that one case, refuses
# every login while unprovisioned, and says so in its log.
#
# Restarting here closes the loop, and it is the moment the strict check becomes
# real: from now on a slug that names no organisation stops this service from
# starting at all, rather than letting it serve 401s nobody can explain.
if [ "${DEPLOYMENT_MODE:-saas}" = 'single_tenant' ]; then
  step 'Pinning the deployment to your organisation'
  dc restart iam-api >/dev/null

  deadline=$(( $(date +%s) + 120 ))
  until dc exec -T proxy wget -q -O /dev/null http://127.0.0.1/api/ready 2>/dev/null; do
    [ "$(date +%s)" -lt "$deadline" ] || die "the API did not come back after being pinned to \"$PINNED_SLUG\".
Its log says which organisation it looked for and what it found:
  docker compose logs iam-api"
    sleep 3
  done
  say "Pinned to \"$PINNED_SLUG\"."
fi

step 'Verifying'
run_installer verify || die 'the installation did not verify. The failures above say which check.'

# ── Done ────────────────────────────────────────────────────────────────────

PORT=$(env_value PLANTOPS_HTTP_PORT)
[ -n "$PORT" ] || PORT=8080

cat <<DONE

────────────────────────────────────────────────────────────────────────────
Installation complete.

  Console      http://<this host>:$PORT/
  Sign in with the organisation slug, email and password from .env.

DO THIS NOW, before you close this terminal:

  1. Rotate the one-time platform credential. It can mint tokens with
     platform-wide authority, it has served its purpose, and it is currently
     sitting in a file on this disk:

         ./bootstrap.sh --rotate-platform-secret

     The new value is printed once. Store it where your organisation keeps
     credentials, then delete the PLATFORM_BOOTSTRAP_SECRET line from .env —
     the application does not read it and starts perfectly well without it.

  2. Restrict the configuration file, which still holds the signing key and
     both database passwords:

         chmod 600 .env

  3. Sign in and change the administrator's password. It is in .env too.

Afterwards, to check this installation at any time:

    ./bootstrap.sh --verify

────────────────────────────────────────────────────────────────────────────
DONE
