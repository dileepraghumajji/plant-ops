# syntax=docker/dockerfile:1.7
#
# The one-shot migration runner (roadmap Session 41, Doc 11 §5.3).
#
# On the managed platform, migrations run from a CI runner that happens to have
# a Node toolchain, a checkout and the workspace's dev dependencies installed
# (`.github/workflows/ci.yml`, the `release` job). None of that is true on a
# client's server, and requiring it would make "upgrade the IAM" mean "install
# Node, clone a private repository, run npm ci" on a machine with no internet
# access. So the upgrade path is a container that runs and exits:
#
#   docker run --rm --env-file .env plantops/migrate:<version>
#   docker run --rm --env-file .env plantops/migrate:<version> --check
#
# ## It is built *from* the API image, and that is the point
#
# The runner and the app must never disagree about what a migration is. Building
# this from `plantops/iam-api:<same version>` makes that structural rather than
# procedural: `@plantops/db` in here is the identical copy the API imports —
# same entities, same migration list, same `secret-hash.ts` behind the bootstrap
# seed — because it is literally the same layer. Two independently built images
# could drift by a rebuild; these cannot.
#
# It is also most of the reason this image is small. The API image already
# carries a pruned production `node_modules` with `typeorm`, `pg`, `zod` and
# `dotenv` in it, so this adds a transpiler and one file.
#
# Build after the API image, passing the tag you just built:
#
#   docker build -f deploy/migrate/Dockerfile \
#     --build-arg IAM_API_IMAGE=plantops/iam-api:dev \
#     -t plantops/migrate:dev .
ARG IAM_API_IMAGE=plantops/iam-api:dev

FROM ${IAM_API_IMAGE}

ARG APP_VERSION=0.0.0-dev

# Every label is restated rather than inherited. `LABEL` values carry over from
# the base image, so without these lines this image would announce itself as
# `plantops-iam-api` to every tool that reads them — which is a confusing thing
# for the container in a support log that failed an upgrade.
LABEL org.opencontainers.image.title="plantops-migrate" \
      org.opencontainers.image.description="PlantOps schema migration runner — applies pending migrations and exits" \
      org.opencontainers.image.source="https://github.com/dileepraghumajji/plant-ops" \
      org.opencontainers.image.version="${APP_VERSION}"

# Inherited from the API image, and actively wrong here: it polls an HTTP port
# this container never opens, so a one-shot run that succeeded in four seconds
# would be reported `unhealthy` by anything watching container state. There is
# no way to "not inherit" a healthcheck other than to say so.
HEALTHCHECK NONE

USER root

# The transpiler, pinned to the workspace's own version so the tool that runs a
# migration on a client's server is the tool it was tested with.
#
# Installed globally, never into `/app`: an `npm install` there would re-resolve
# the pruned tree the API image was built with, and the whole argument for
# building on top of that image is that its dependency graph is fixed.
RUN npm install --global --no-audit --no-fund tsx@4.23.12

WORKDIR /app/migrate

# `type: module`, and it has to be here rather than assumed.
#
# `tools/release-migrate.ts` imports `@plantops/config` and `@plantops/db`, both
# of which publish ESM (`"type": "module"` in their package.json). The nearest
# package.json to this script is `/app/package.json` — the API's pruned one,
# which declares no type and therefore means CommonJS. Running the script that
# way would make every one of those imports a `require()` of an ES module: legal
# on Node 22, but only until one of those libraries grows a top-level await,
# at which point an upgrade fails on a client's machine with a module error.
#
# One file, three lines away from that whole class of problem. It also keeps
# `/app/node_modules` on the resolution path — Node walks *up* from here — so
# nothing had to be copied or re-installed.
RUN printf '{\n  "type": "module",\n  "private": true\n}\n' > package.json

# The same script `npm run release:migrate` runs, unmodified. It already has the
# properties this image needs and they are argued for in its own header: it
# validates only the migration subset of the environment (no signing key, no
# Redis URL), takes a Postgres advisory lock so two runners cannot race, exits
# non-zero on any failure, and treats "nothing to apply" as success — which is
# what makes re-running an upgrade that already happened safe.
COPY --chown=node:node tools/release-migrate.ts ./release-migrate.ts

# The second step of an upgrade (roadmap Session 43, Doc 11 §6.3): the release's
# application manifests, and the tool that applies them.
#
# They live in this image rather than in the API's because this is the
# operations container — the one an install and an upgrade run explicitly — and
# because the applier needs `tsx`, which only this image has. The compose files
# give it its own service (`manifests`) with an entrypoint of its own; nothing
# about the migration path changes.
#
# Manifests go under `./manifests` because `apply-manifests.ts` looks for a
# sibling directory of that name when there is no repository layout around it.
# `iam-api-client.ts` comes along because the applier imports it; both are
# TypeScript and both are run by the same `tsx` the migration uses, so what runs
# on a client's server is the same source CI ran.
COPY --chown=node:node tools/apply-manifests.ts ./apply-manifests.ts
COPY --chown=node:node tools/iam-api-client.ts ./iam-api-client.ts
COPY --chown=node:node deploy/manifests/ ./manifests/

USER node

# `ENTRYPOINT` rather than `CMD`, so arguments passed to `docker run` land on
# the tool: `docker run … plantops/migrate:x --check` reports pending work and
# exits 1 without applying anything, which is the pre-flight step an upgrade
# runbook wants before it takes a backup.
ENTRYPOINT ["tsx", "release-migrate.ts"]
