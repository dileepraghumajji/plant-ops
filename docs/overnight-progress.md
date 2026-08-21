# Overnight session log

A running record of the roadmap sessions worked through unattended, so the
morning review has one place to start. Newest session last.

For each session: what shipped, what was verified and how, and anything left
open that wants a decision rather than a guess.

---

## Session 41 — Container images for both apps, proxy, and migration runner

**Branch:** `session-41-images-proxy-migrator` → merged to `main`
**Status:** complete; every acceptance criterion verified by running the stack locally, not by inspection.

### What shipped

| Thing | Where |
|---|---|
| Console image (Next standalone) | `apps/admin-web/Dockerfile`, `next.config.js` (`output: 'standalone'`) |
| Reverse proxy — console at `/`, API at `/api` prefix-stripped | `deploy/proxy/{Dockerfile,nginx.conf,proxy-headers.conf,40-real-ip.sh}` |
| One-shot migration runner | `deploy/migrate/Dockerfile` |
| The stack, assembled | `deploy/docker-compose.yml`, `deploy/postgres-init/10-roles.sh` |
| Stack smoke (the definition of done, executable) | `deploy/stack-smoke.sh` |
| Build version stamped and reported | `libs/config/src/env.schema.ts` (`APP_VERSION`), `health.controller.ts`, `health/version.spec.ts` |
| CI builds all four, asserts labels, runs the stack | `.github/workflows/ci.yml` (`images` job) |

### Verified locally, not assumed

All four images built; the stack came up from an empty volume; `deploy/stack-smoke.sh` passed end to end:

- console at `/login`, API at `/api/health` with the prefix stripped;
- `/health` reported `0.0.0-local`, the tag the images were built with;
- the platform bootstrap login succeeded through **two different `Host` headers** against the same digests;
- twenty-five login attempts with twenty-five forged `X-Forwarded-For` values were throttled together — the proxy replaces the header rather than forwarding it, which is what makes `TRUST_PROXY=true` correct behind it;
- the migration runner re-run on an up-to-date database exits 0 (`up to date — nothing to apply`), `--check` exits 0, and a wrong password exits 1.

`nx run-many -t lint test build` green; `openapi:check` green.

### Decisions worth knowing about

- **The migration runner is built `FROM` the API image.** It therefore carries the identical `@plantops/db` the API imports — same entities, same migration list — rather than a separately resolved copy that could drift by a rebuild. It costs an image-build ordering in CI (API first, then migrate) and buys a property that cannot be violated by accident.
- **The proxy resolves upstreams per request** (`resolver 127.0.0.11` + a variable in `proxy_pass`). Without it nginx caches the container IP it resolved at startup and 502s every request after an `iam-api` restart until the proxy is restarted too. The resolver address is Docker's embedded DNS — the one line to change if this ever runs somewhere that is not compose.
- **`deploy/docker-compose.yml` is not the production bundle.** It is the stack CI asserts against: tags rather than digests for our own images, a bundled Postgres, and a bind mount of `tools/setup-db-roles.sql` to provision the two database roles on first boot. Session 42's `docker-compose.prod.yml` + `bootstrap-install.mjs` is the deliverable version, and it is what should own role provisioning against a client's existing Postgres.
- **CI does not push images.** Roadmap said "build and tag"; Railway builds what it deploys, and a second registry copy would mean two artifacts with one version number. The artifact a client receives is Session 42's offline tarball, produced from these builds.

### Open questions for review

1. **Versioning scheme.** The repository has no git tags, so CI computes `0.0.0-<12-char sha>` and that is what `/health` reports. That is honest but it is not a release number. Before a pilot, decide whether releases get annotated tags (`v0.1.0`) — `git describe --tags --dirty` already prefers them the moment one exists, so this is a `git tag` away and no code change.
2. **`X-Forwarded-Proto` behind a client's own TLS terminator.** The proxy sends `$scheme`, which is `http` inside the stack even when the browser arrived over HTTPS. Nothing in the API branches on it today, so it is inert — but if something ever does (an absolute redirect, a secure-cookie decision), an operator with an outer terminator will need it pinned to `https`. Left as a documented comment rather than a config knob nobody needed yet.
3. **Shared rate-limit bucket behind an outer proxy.** If the client fronts our proxy with their own load balancer and does not set `TRUSTED_PROXY_CIDRS`, every unauthenticated caller shares one bucket — safe, but it means the whole plant's *logins* share ten attempts a minute. Authenticated traffic is keyed by subject and unaffected. Worth a line in Session 49's install runbook; the mechanism to fix it already ships (`40-real-ip.sh`).
