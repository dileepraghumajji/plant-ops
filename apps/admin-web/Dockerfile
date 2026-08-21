# syntax=docker/dockerfile:1.7
#
# `admin-web` production image (roadmap Session 41, Doc 11 §5.3).
#
# The console's half of a single-tenant stack. On the managed platform Vercel
# builds and hosts this app, which is why Session 39 never needed an image for
# it; a client's server has no Vercel, so the console has to be a container like
# everything else.
#
# ## The property this image has to have
#
# **It contains no customer-specific value.** That is not a nice-to-have here,
# it is the whole reason the image exists rather than a per-customer build:
# Doc 11 §3 allows exactly one image set, and a hostname baked into a bundle
# would make the second customer a fork. Session 40 made it achievable —
# `src/lib/api-config.ts` defaults the API base to the same-origin path `/api`
# — and two things in this file keep it true:
#
#   1. `NEXT_PUBLIC_IAM_API_URL` is never set during the build below. Unset, the
#      bundle carries `/api`, which is correct on every hostname.
#   2. `.dockerignore` excludes every `.env*` but the examples, so a developer's
#      `apps/admin-web/.env.local` naming `http://localhost:3000` cannot be
#      swept into the build context and inlined. Next reads those files during
#      `next build` — that failure would be silent and would ship.
#
# CI proves it rather than trusting it: the stack smoke serves the *same digest*
# under two different `Host` headers and logs in through both.
#
# ## Two stages
#
# Building needs the whole workspace — Nx, the TypeScript toolchain, antd, and
# every shared library's source. Running needs a traced server bundle and a Node
# binary. `output: 'standalone'` in `next.config.js` is the bridge: it writes
# `.next/standalone` containing `server.js` and only the `node_modules` the
# server actually requires, so the runtime stage installs nothing at all.
#
# Build from the **repository root**, not from this directory:
#
#   docker build -f apps/admin-web/Dockerfile -t plantops/admin-web:dev .

# Digest-pinned for the reason `apps/iam-api/Dockerfile` gives at the same line:
# an artifact a client reproduces months from now must not depend on what a tag
# pointed at that week. Keep the two files on the same digest — they are the
# same base, and a split would double the surface to patch for nothing.
ARG NODE_IMAGE=node:22.16.0-bookworm-slim@sha256:048ed02c5fd52e86fda6fbd2f6a76cf0d4492fd6c6fee9e2c463ed5108da0e34

FROM ${NODE_IMAGE} AS build

WORKDIR /workspace

ENV NX_DAEMON=false \
    CI=true \
    NEXT_TELEMETRY_DISABLED=1

# Manifests first, so `npm ci` re-runs only when a dependency changes. npm needs
# every workspace package.json to resolve the root lockfile, so they are listed
# explicitly — a library added without a line here fails loudly at `npm ci`
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

# No BuildKit cache mount — see the long note in `apps/iam-api/Dockerfile`.
# Railway's Metal builder rejects the unnamed form and demands a service-scoped
# id, which would bake one environment's UUID into an image every environment
# builds from.
RUN npm ci

COPY . .

# `build` declares `dependsOn: ["^build"]`, so this also compiles
# `@plantops/contracts` and `@plantops/iam-client`, which the console consumes
# as built ESM rather than as source.
#
# Deliberately no `NEXT_PUBLIC_*` here. See the header.
RUN npx nx build @plantops/admin-web

# ── Runtime ────────────────────────────────────────────────────────────────
FROM ${NODE_IMAGE} AS runtime

ARG APP_VERSION=0.0.0-dev

LABEL org.opencontainers.image.title="plantops-admin-web" \
      org.opencontainers.image.description="PlantOps admin console" \
      org.opencontainers.image.source="https://github.com/dileepraghumajji/plant-ops" \
      org.opencontainers.image.version="${APP_VERSION}"

# 4200 to match the workspace's own convention (`nx dev admin-web`), and to stay
# clear of the API's 3000 so a compose file reads unambiguously. `HOSTNAME` is
# not decoration: the standalone server binds `0.0.0.0` only when told to, and
# a container listening on loopback answers nothing from outside itself.
ENV NODE_ENV=production \
    PORT=4200 \
    HOSTNAME=0.0.0.0 \
    NEXT_TELEMETRY_DISABLED=1

WORKDIR /app

# Three copies, because Next traces *imports* and these are the parts that are
# served rather than imported.
#
# The trace root is the workspace (a lockfile lives there), so the standalone
# tree mirrors the monorepo: `node_modules` at the top, `server.js` down at
# `apps/admin-web/`. Copying the tree whole preserves that, and Node's upward
# module resolution from `/app/apps/admin-web` finds `/app/node_modules`.
COPY --from=build --chown=node:node /workspace/apps/admin-web/.next/standalone ./
# Client chunks and CSS. Omitting these produces the worst failure mode of the
# three: the server boots, `/health`-equivalent checks pass, every page renders
# unstyled and inert, and nothing logs an error.
COPY --from=build --chown=node:node /workspace/apps/admin-web/.next/static ./apps/admin-web/.next/static
COPY --from=build --chown=node:node /workspace/apps/admin-web/public ./apps/admin-web/public

USER node

WORKDIR /app/apps/admin-web

EXPOSE 4200

# `/login` rather than `/`: the root is a client-side redirect into whichever
# screen the caller's menu starts with, so it depends on a session. `/login` is
# statically rendered and answers 200 for an anonymous request, which is exactly
# what a liveness probe should be asking.
#
# `fetch` rather than curl, because the slim image has no curl and adding one to
# make a request Node can make itself is a package of attack surface for nothing.
HEALTHCHECK --interval=30s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4200)+'/login').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# No shell wrapper, so the Next server is PID 1 and receives SIGTERM directly.
CMD ["node", "server.js"]
