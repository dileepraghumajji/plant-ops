# syntax=docker/dockerfile:1.7
#
# `iam-api` production image (Doc 08 §6).
#
# Three stages, because the thing that builds this app and the thing that runs
# it have almost nothing in common. Building needs the whole workspace — Nx, the
# TypeScript toolchain, every library's source, and the dev dependencies of ten
# packages. Running needs one bundled `main.js`, its runtime dependencies, and a
# Node binary. Shipping the first as if it were the second is how a 40 MB
# service becomes a 1.5 GB image with a compiler in it.
#
# The bridge between them is `nx run @plantops/iam-api:prune`, which is already
# wired up in `apps/iam-api/package.json` and does three things:
#
#   1. `build` — webpack bundles `src/main.ts` into `dist/main.js`, with the
#      workspace libraries left *external* (they are still `require`d by name).
#   2. `prune-lockfile` — writes a `dist/package.json` and `dist/package-lock.json`
#      holding only what the bundle actually imports, with `@plantops/*` rewritten
#      to `file:./workspace_modules/...`.
#   3. `copy-workspace-modules` — copies those built libraries in beside it.
#
# So `dist/` is a self-contained npm project. The runtime stage installs it and
# nothing else, and the workspace never appears in the shipped filesystem.
#
# Build from the **repository root**, not from this directory — the build needs
# the root lockfile and every workspace package:
#
#   docker build -f apps/iam-api/Dockerfile -t plantops/iam-api:dev .
#
# Configuration is entirely environment (Doc 08 §5): this image contains no
# `.env`, no keys, and no customer-specific value, which is what lets one build
# serve staging, production, and — from Session 41 — a client's own server.

# Debian slim rather than Alpine, deliberately. `@node-rs/argon2` (the password
# hasher, Doc 03 §2) ships prebuilt native bindings per platform, and the glibc
# build is the well-trodden one; musl works but is the variant that breaks
# quietly on an upgrade. The size difference does not pay for that risk in the
# one image where a hashing failure means nobody can log in.
#
# **Pinned by digest, not by tag** (roadmap Session 41). A tag is a moving
# pointer: `node:22.16.0-bookworm-slim` is rebuilt whenever Debian patches a
# base package, so two builds of the same commit can ship different bytes. That
# is tolerable on a platform we can redeploy in a minute and is not tolerable
# for an artifact handed to a client's IT team, who will reproduce it months
# later on a machine we cannot reach (Doc 11 §5.3 — "digest-pinned"). The tag
# stays in front of the digest because it is the only human-readable part; the
# digest is what Docker resolves.
#
# To move it: `docker buildx imagetools inspect node:<version>-bookworm-slim`
# and paste the new digest here, in the same commit as the version bump.
ARG NODE_IMAGE=node:22.16.0-bookworm-slim@sha256:048ed02c5fd52e86fda6fbd2f6a76cf0d4492fd6c6fee9e2c463ed5108da0e34

FROM ${NODE_IMAGE} AS build

WORKDIR /workspace

# Nx's background daemon has nothing to serve a single-shot container build, and
# a daemon that outlives the RUN step makes the layer non-deterministic.
ENV NX_DAEMON=false \
    CI=true

# Manifests first, so `npm ci` re-runs only when a dependency actually changes
# and not on every source edit. npm needs *every* workspace package.json to
# resolve the root lockfile, so they are listed explicitly — a new library added
# to `apps/*` or `libs/*` without a line here fails the build loudly at `npm ci`
# rather than producing a subtly wrong install.
COPY package.json package-lock.json ./
COPY apps/admin-web/package.json         apps/admin-web/
COPY apps/iam-api/package.json           apps/iam-api/
COPY apps/iam-api-e2e/package.json       apps/iam-api-e2e/
COPY libs/auth-kit/package.json          libs/auth-kit/
COPY libs/config/package.json            libs/config/
COPY libs/contracts/package.json         libs/contracts/
COPY libs/db/package.json                libs/db/
COPY libs/iam-client/package.json        libs/iam-client/
COPY libs/ui/package.json                libs/ui/
COPY libs/web-kit/package.json           libs/web-kit/

# No BuildKit cache mount here, deliberately, and it is worth saying why so the
# obvious optimisation is not reintroduced.
#
# `--mount=type=cache,target=/root/.npm` is valid BuildKit and builds fine
# locally and in the `image` CI job. Railway's Metal builder rejects it twice
# over: first for having no `id`, then — once named — for an id lacking its
# `cacheKey` prefix. Railway's accepted form is
# `id=s/<service id>-<target path>`, the literal service UUID, and variable
# expansion is not supported, so satisfying it means hardcoding one
# environment's service identifier into the image definition every other
# environment also builds from. Session 41 publishes this image as the artifact
# a self-hosted install pulls; a Railway UUID baked into it would be nonsense
# there, and would break here the moment the service is recreated.
#
# The cost of dropping it is small. Layer caching already skips this whole step
# whenever `package.json` and `package-lock.json` are unchanged, which is most
# builds; the mount only ever helped on the builds where the lockfile moved.
RUN npm ci

COPY . .

# `build` declares `dependsOn: ["^build"]`, so this one target also compiles
# every library the API imports — which is what makes `workspace_modules`
# contain real `dist/` output rather than empty package shells.
RUN npx nx run @plantops/iam-api:prune

# ── Runtime dependencies ───────────────────────────────────────────────────
#
# A separate stage so the production `node_modules` is resolved from the pruned
# lockfile in isolation. Installing here rather than in the final stage keeps
# npm itself — and its cache — out of the shipped image.
FROM ${NODE_IMAGE} AS deps

WORKDIR /app

COPY --from=build /workspace/apps/iam-api/dist ./

# Two commands, and the first one is not optional — verified against this
# workspace, not assumed.
#
# `@nx/js:prune-lockfile` walks the root lockfile and keeps what the bundle
# needs, but it does not reproduce the *deepest* nesting level in every case.
# Here it emits exactly one node short: `express@5.2.1` (nested under
# `@nestjs/platform-express`) wants `content-type@^1.0.5`, and the pruned tree
# offers it only `content-type@2.0.0` at that level. npm's ideal tree therefore
# contains a node the lockfile lacks, and `npm ci` — which refuses to install
# from a lockfile out of sync with its `package.json` — stops the build with
# "Missing: content-type@1.0.5 from lock file".
#
# `--package-lock-only` repairs exactly that: it recomputes the tree without
# touching the filesystem. Measured on this workspace it adds the one missing
# node, drops five entries only a dev dependency wanted, and changes no other
# package's version — so `npm ci` afterwards still installs a fixed, complete
# tree rather than resolving ranges at build time.
#
# `npm install --omit=dev` alone would also work, and would be worse: it would
# resolve every range against the registry on every build, which is precisely
# the reproducibility this two-step keeps.
# No cache mount, for the reason given at the `npm ci` in the deps stage.
RUN npm install --package-lock-only --omit=dev --no-audit --no-fund && \
    npm ci --omit=dev --no-audit --no-fund

# ── Runtime ────────────────────────────────────────────────────────────────
FROM ${NODE_IMAGE} AS runtime

# The build being shipped, stamped in two places from one argument
# (Doc 11 §8, gap 8):
#
#   * the OCI `version` label, which `docker image inspect` reads without
#     starting anything — what you use when the container will not boot;
#   * `APP_VERSION` in the environment, which `libs/config` validates and
#     `/health` reports — what you use when it is running and someone on the
#     phone needs to say which build they are on.
#
# One `ARG`, so the two cannot disagree. CI passes the tag it is about to push
# and then asserts the running container reports the same string, which is what
# makes the label trustworthy rather than decorative.
#
# The default matches the schema's: an unstamped image is honest about being
# unstamped rather than claiming a release number nobody cut.
ARG APP_VERSION=0.0.0-dev

LABEL org.opencontainers.image.title="plantops-iam-api" \
      org.opencontainers.image.description="PlantOps IAM/RBAC service" \
      org.opencontainers.image.source="https://github.com/dileepraghumajji/plant-ops" \
      org.opencontainers.image.version="${APP_VERSION}"

ENV NODE_ENV=production \
    PORT=3000 \
    APP_VERSION=${APP_VERSION}

WORKDIR /app

# The `node` user ships with the official image (uid 1000). Nothing this process
# does needs root: it opens one TCP listener above 1024, reads its configuration
# from the environment, and writes nothing to disk.
COPY --from=deps --chown=node:node /app ./

USER node

EXPOSE 3000

# `/health`, never `/ready` — the distinction is the whole point of having two
# (see `src/health/health.controller.ts`). A container healthcheck *kills and
# restarts* on failure, so pointing it at readiness would turn a thirty-second
# Postgres blip into a restart of every replica at once. The orchestrator's
# load-balancer probe is what reads `/ready`; here `railway.json` sets it.
#
# Written with `fetch` rather than curl because the slim image has no curl, and
# adding one to run a healthcheck is a package in the attack surface for a
# request Node can make on its own.
HEALTHCHECK --interval=30s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# `main.js` directly, with no shell wrapper, so the process is PID 1 and
# receives SIGTERM unmediated — `app.enableShutdownHooks()` in `main.ts` is what
# closes the Postgres pool and the Redis connection on a rolling deploy, and a
# shell in between would swallow the signal and leak a pool per replacement.
CMD ["node", "main.js"]
