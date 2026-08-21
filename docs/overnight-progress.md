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

### Open questions for review — Session 41

1. **Versioning scheme.** The repository has no git tags, so CI computes `0.0.0-<12-char sha>` and that is what `/health` reports. That is honest but it is not a release number. Before a pilot, decide whether releases get annotated tags (`v0.1.0`) — `git describe --tags --dirty` already prefers them the moment one exists, so this is a `git tag` away and no code change.
2. **`X-Forwarded-Proto` behind a client's own TLS terminator.** The proxy sends `$scheme`, which is `http` inside the stack even when the browser arrived over HTTPS. Nothing in the API branches on it today, so it is inert — but if something ever does (an absolute redirect, a secure-cookie decision), an operator with an outer terminator will need it pinned to `https`. Left as a documented comment rather than a config knob nobody needed yet.
3. **Shared rate-limit bucket behind an outer proxy.** If the client fronts our proxy with their own load balancer and does not set `TRUSTED_PROXY_CIDRS`, every unauthenticated caller shares one bucket — safe, but it means the whole plant's *logins* share ten attempts a minute. Authenticated traffic is keyed by subject and unaffected. Worth a line in Session 49's install runbook; the mechanism to fix it already ships (`40-real-ip.sh`).

---

## Session 42 — Offline production bundle & first-boot bootstrap

**Branch:** `session-42-offline-bundle`
**Status:** complete; every acceptance criterion exercised by installing from a real tarball on this machine.

### What shipped

| Thing | Where |
|---|---|
| The installed stack, air-gapped (`pull_policy: never` throughout) | `deploy/docker-compose.prod.yml` |
| Every variable `libs/config` validates, explained for an operator | `deploy/.env.template` |
| Host-side installer — Docker and a POSIX shell, nothing else | `deploy/bootstrap.sh` |
| API-side provisioning, verification and credential rotation | `tools/bootstrap-install.mjs` |
| The tarball builder | `tools/build-bundle.mjs` |
| Install guide | `deploy/README.md` |
| Drift test: template + compose must assemble into a valid environment | `libs/config/src/env-template.spec.ts` |
| `PLATFORM_BOOTSTRAP_SECRET` is now optional, and blank reads as absent | `libs/config/src/env.schema.ts` |
| CI installs from the archive with the images deleted first | `.github/workflows/ci.yml` |

### Verified locally, not assumed

Bundle built (365 MB), the four PlantOps images deleted from the daemon, tarball extracted to a fresh directory, `.env` filled from the shipped template, `./bootstrap.sh` run:

- images loaded from the archive; roles created; 17 migrations applied; stack reported ready;
- client "Northgate Foods" and administrator created, then the bundled verification passed all four checks (API, dependencies, console, real login);
- **re-run changed nothing** and re-reported the same state ("already exists — left as it is", password included);
- `./bootstrap.sh --rotate-platform-secret` printed a new credential once; with `PLATFORM_BOOTSTRAP_SECRET` then deleted from `.env`, `--verify` still passed and a fresh install attempt refused with a precise message;
- `printenv PLATFORM_BOOTSTRAP_SECRET` inside the API container is **empty** — the stack blanks it deliberately, so the process serving requests never holds it.

`nx run-many -t lint test build` green; `openapi:check` green.

### Decisions worth knowing about

- **The installer is a shell script, not `bootstrap-install.mjs` as the roadmap named it.** The roadmap's own constraint (Doc 11 §5.1) is that a plant server may have no internet; it frequently also has no Node, no curl and no package manager. So the host-side driver is POSIX `sh`, and the part that genuinely needs a runtime — the API calls — runs *inside the API container* via `docker compose exec`, with `.env` piped in on stdin so no secret reaches an argument list. `tools/bootstrap-install.mjs` still exists and does exactly that job.
- **`PLATFORM_BOOTSTRAP_SECRET` became optional in `libs/config`.** Nothing in the API ever read it; only migration 0011 does, off `process.env`. Requiring it meant every deployment kept a live platform credential in the application's environment forever, which contradicts "consumed once, rotated immediately". Blank now reads as absent too, so the production compose can hand the API an empty string while the migration container beside it still gets the real value from the same `.env`.
- **Base images travel by tag, not by digest, inside the bundle** — `docker load` cannot restore a digest reference, so a digest in the compose file would send an offline install looking for a registry. The pin is enforced at *bundle build* time (pull by digest, then retag), and `MANIFEST.json` records which digest each image came from.
- **`PLANTOPS_COMPOSE_PROJECT`** was added to `bootstrap.sh` so a host can hold two installations (and so CI can install beside a development stack of the same name).

### Open questions for review — Session 42

1. **The administrator's password lives in `.env`.** Bootstrap needs it to create the account and `--verify` needs it to prove login works. The install output tells the operator to change it after first login, but nothing enforces that, and `.env` is `chmod 600` at best. A "must change on first login" flag would be the real fix and belongs with Session 45's account work — worth deciding whether it is in scope there.
2. **The bundle has no signature.** A tarball a client is told to trust should be verifiable — a detached signature and a published fingerprint. `MANIFEST.json` records image IDs but nothing signs the manifest. Session 48 introduces an offline-verifiable licence and will need a signing key anyway; the two probably want the same key and the same command.
3. **Nothing yet applies the application manifests**, so a freshly installed console has the permission catalog migration 0017 seeds and nothing more — the navigation is sparse until Session 43 bundles the manifests and applies them at install and upgrade. Worth knowing before showing an install to anyone.
4. **The install is single-client by convention, not by enforcement.** Bootstrap creates one client and the login screen still asks for the slug. Session 44 is what makes the slug invisible and refuses a second client; until then a demo will show `northgate` in the login form.

---

## Session 43 — Application manifests as release artifacts

**Branch:** `session-43-manifest-release-artifacts`
**Status:** complete; convergence proven by e2e, and the applier exercised inside the real container against a real stack.

### What shipped

| Thing | Where |
|---|---|
| The release's bundled manifest set | `deploy/manifests/` (`iam.manifest.json` moved here from `tools/`) |
| The general applier — replaces `seed-iam-manifest.ts` | `tools/apply-manifests.ts`, `npm run manifest:apply` |
| Manifests + applier baked into the operations image | `deploy/migrate/Dockerfile` |
| A `manifests` one-shot service, in both stacks | `deploy/docker-compose{,.prod}.yml` |
| Applied at install; `--apply-manifests` on upgrade | `deploy/bootstrap.sh` |
| The convergence properties, asserted | `apps/iam-api-e2e/src/manifest-convergence.e2e.ts` |

### Verified

Five e2e assertions, all green: a second application changes nothing **and writes no audit record**; a hand-added permission is deactivated rather than deleted on the next upgrade; a hand-edited application name is restored; a manifest addressed to the wrong application is refused and changes neither catalog; the active permission set is exactly what the shipped manifest declares.

Then the real path: the rebuilt `plantops/migrate` image applied the catalog through the proxy against a live stack (`nav +15, menu permissions +12`), and a second run reported "catalog already matches the release".

`nx run-many -t lint test build` green; `openapi:check` green.

### Decisions worth knowing about

- **The applier speaks HTTP, never SQL.** Every manifest goes through `POST /iam/applications/:id/manifest`, so Session 23's dogfooding property survives: the console's own menu is still built by the code path every other application uses.
- **It lives in the migration image, not the API image** — that is the container an install and an upgrade already run explicitly, and the only one with `tsx`.
- **The `manifests` service is behind a compose profile.** Unlike the migration it needs the API *serving*, so `docker compose up` cannot run it; something explicit does.
- **`tools/iam-manifest.json` moved to `deploy/manifests/iam.manifest.json`.** Four test files and several docs referenced the old path and were repointed.
- **`.gitattributes` now pins `openapi.json` to LF**, because `openapi:check` compares bytes and a Windows checkout made it report "stale" on every run.

### Open questions for review — Session 43

1. **Applying manifests needs platform authority, and a finished install deliberately has none.** So an upgrade puts `PLATFORM_BOOTSTRAP_SECRET` back into `.env` for the length of the upgrade (documented in `deploy/README.md` §5). It works, and it is the weakest part of this session. The better answer is a dedicated release identity holding only `iam.platform.application.*` — created at bootstrap, secret stored in `.env`, useless for anything else. That belongs with Session 45's restricted platform role; worth deciding whether to fold it in there.
2. **Nothing forces the upgrade to re-apply.** `bootstrap.sh --apply-manifests` is a documented step, not an automatic one, so an operator who skips it keeps the previous release's catalog. Making it automatic requires solving (1) first.
3. **The set has exactly one manifest today.** `apply-manifests.ts` creates applications it does not find (except `iam`, which migration 0017 owns), so adding Gatepass or Visitor to the release is a matter of dropping a file in `deploy/manifests/` — but that path has never been exercised with a second manifest.
