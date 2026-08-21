# PlantOps — installing and running the stack

This is the document that ships inside an installation bundle, next to
`docker-compose.yml` and `.env.template`. It covers getting the product running
on a server you operate and we cannot reach.

Backup, restore and version-to-version upgrade runbooks are separate documents
and are not yet written (roadmap Session 49). `runbooks/ops-runbook.md` in this
bundle covers the parts that already exist — key rotation in particular — and
`runbooks/deployment-models.md` explains what we support and what we do not.

---

## 1. What you need

**One Linux server.** Two CPU cores and 4 GB of RAM is comfortable for a plant;
the whole stack idles well under a gigabyte. Disk is dominated by the database,
which grows with your audit trail rather than with your user count — start at
20 GB and watch it.

**Docker Engine 24 or newer, with the Compose v2 plugin.** Check with:

```sh
docker --version
docker compose version     # must print v2.x — the old `docker-compose` will not work
```

**No internet access is required, at any point.** That is a design constraint,
not a nice-to-have: everything is loaded from the bundle, and the compose file
forbids the stack from contacting a registry at all. If you see an image pull
attempt, something is wrong — tell us.

**A TLS terminator in front, with your certificate.** The stack publishes one
plain-HTTP port. Putting your own reverse proxy, load balancer or ingress in
front of it is how the connection becomes HTTPS; we do not ship a certificate
and would not know what name to put on it.

---

## 2. Install

```sh
tar -xzf plantops-<version>.tar.gz
cd plantops-<version>

cp .env.template .env
chmod 600 .env
$EDITOR .env            # fill in every value under REQUIRED

./bootstrap.sh
```

`.env.template` explains each value where it sits. The five you will need to
generate:

```sh
openssl rand -base64 24                                   # POSTGRES_PASSWORD
openssl rand -base64 24                                   # PLANTOPS_APP_PASSWORD
openssl rand -hex 32                                      # PLATFORM_BOOTSTRAP_SECRET
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out jwt.key
openssl rsa -in jwt.key -pubout -out jwt.pub              # JWT_PRIVATE_KEY / JWT_PUBLIC_KEY
```

Paste each key on **one line**, with its newlines written as `\n`. The
application unescapes them; a real multi-line value will not survive the file.

`bootstrap.sh` then, in order: loads the images, starts PostgreSQL, creates the
two database roles, applies the migrations, starts the rest of the stack, waits
for it to report ready, applies the release's application catalog, and creates
your organisation and its first administrator. It prints what it did at each
step, and it is safe to run again if it stops partway — nothing it creates would
be duplicated by a second run.

**Your users sign in with an email and a password, and nothing else.** This
installation is pinned to one organisation (`DEPLOYMENT_MODE=single_tenant`), so
the login screen does not ask which one — and a sign-in that names a different
organisation is refused rather than quietly redirected. That is why
`SINGLE_TENANT_CLIENT_SLUG` and `PLANTOPS_CLIENT_SLUG` must be the same value,
and why the installer stops if they are not.

When it finishes it prints three things to do immediately. Do them before you
close the terminal; the first one in particular.

---

## 3. Why there are two database passwords

This is the one piece of the design worth understanding before you change
anything, because getting it wrong is both easy and silent.

PostgreSQL exempts a table's **owner** from that table's row-level security
policies — independently of `SUPERUSER`, and with no warning. Those policies are
what keep one organisation's data out of another's queries. So the stack uses
two roles:

| Role | Owns | Used by | Variable |
|---|---|---|---|
| `plantops` | every table | migrations only | `POSTGRES_PASSWORD` |
| `plantops_app` | nothing | every request | `PLANTOPS_APP_PASSWORD` |

If the application ever connects as the owner, every policy in the system stops
filtering and nothing looks wrong from the outside. The application therefore
checks at startup that it is *not* the owner and refuses to start if it is. A
stack that will not boot with that message is the safety net working; do not
work around it by pointing both variables at the same role.

---

## 4. Everyday operation

```sh
docker compose ps                      # what is running
docker compose logs -f iam-api         # the API's log
docker compose logs migrate            # what the last migration run did
docker compose restart iam-api         # after changing .env
./bootstrap.sh --verify                # is this installation healthy?
```

`--verify` is the bundled smoke test. It checks the API, its dependencies, the
console, and that your administrator can actually log in — through the same
front door a browser uses. It is the right thing to run after any change, and
the right thing to paste into a support request.

**Health endpoints**, for your monitoring:

| Endpoint | Meaning | Use it for |
|---|---|---|
| `/api/health` | the process is alive; reports the version | liveness |
| `/api/ready` | dependencies answered | load-balancer probe, alerting |

`/api/health` is also how you answer "what version are you on" — no login
required:

```sh
curl -s http://localhost:8080/api/health
```

---

## 5. Upgrading

```sh
# 1. Back up first. The upgrade is unsupported without one.
docker compose exec -T postgres pg_dump -U plantops plantops_iam > backup.sql

# 2. Load the new images.
tar -xzf plantops-<new version>.tar.gz
docker load -i plantops-<new version>/images/plantops-<new version>.tar

# 3. Point this installation at the new version and bring it up.
sed -i 's/^PLANTOPS_VERSION=.*/PLANTOPS_VERSION=<new version>/' .env
docker compose up -d

# 4. Re-apply the release's application catalog. Needs the current platform
#    credential in .env for the length of the upgrade — see below.
./bootstrap.sh --apply-manifests

# 5. Check.
./bootstrap.sh --verify
```

Step 3 is one command because the compose file makes the migration container a
prerequisite of the API: migrations run first, and if one fails the new API
never starts. You are never left with new code against an unmigrated schema.

Migrations are forward-only and additive wherever possible. Skipping versions
works — the runner applies everything outstanding in order — but take the backup
anyway.

**Step 4 needs a platform credential, and that is the one awkward part of an
upgrade.** The permission and navigation catalog ships with the release, and
re-applying it is what keeps this installation on the catalog we tested — an
installation whose catalog has drifted is one where every support answer is a
guess. Applying it needs platform authority, and a finished installation
deliberately has none in `.env`. So put the current `PLATFORM_BOOTSTRAP_SECRET`
back for the length of the upgrade and take it out again afterwards; that is the
value `./bootstrap.sh --rotate-platform-secret` printed and told you to store.

The step is safe to repeat and free when nothing changed: it reports "catalog
already matches the release" and writes no audit record. Skipping it is not
fatal — the new code runs — but the catalog stays where the previous release
left it, so do not make a habit of it.

---

## 6. Troubleshooting

**`bootstrap.sh` says an image is missing.** `PLANTOPS_VERSION` in `.env` has to
match the bundle you loaded exactly. Compare it with the `version` field in
`MANIFEST.json`.

**The stack never reports ready.** Look at the two logs in order:

```sh
docker compose logs migrate     # did the schema apply?
docker compose logs iam-api     # did the application accept its configuration?
```

The application prints every configuration problem it found at once and then
exits. It never starts with a setting it does not understand, so the log names
what to fix.

**`the application is connected as the table owner`.** `PLANTOPS_APP_PASSWORD`
and `POSTGRES_PASSWORD` are pointing at the same role, or `PLANTOPS_APP_ROLE`
has been changed to the owner's name. See §3 — this refusal is deliberate.

**The console loads but every request fails.** Check that you are reaching the
stack through its published port and not bypassing the proxy. The console calls
`/api` on whatever origin served it; served from anywhere else, there is nothing
at that path.

**Provisioning says the platform credential was rejected.**
`PLATFORM_BOOTSTRAP_SECRET` is read exactly once, by the migration that creates
the platform identity on a brand-new database. Changing it afterwards has no
effect on what was stored. If you have lost it and the installation is not yet
provisioned, the recovery is to destroy the database volume and start over:

```sh
docker compose down --volumes     # DESTROYS ALL DATA — only on a fresh install
```

If the installation *is* provisioned and working, you do not need it at all —
that is the intended end state.

---

## 7. What we support

Set out in full in `runbooks/deployment-models.md` §5.5. In short: the artifact,
the runbooks, the upgrade path, and diagnosis of faults in our software. The
server, its operating system, backups, restores, TLS certificates, monitoring
and capacity are yours.

We have no access to this installation. Nothing in it calls home, checks a
licence server, or reports usage — by design, because a plant network has no
egress and an installer that assumed one would fail on site on day one.
