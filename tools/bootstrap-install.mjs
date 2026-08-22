/**
 * First-boot tenant provisioning and post-install verification
 * (roadmap Session 42, Doc 11 §5.3, §6.3).
 *
 * The half of the install that talks to the API: exchange the one-time platform
 * credential for a token, create the client, create its first administrator,
 * then prove the result by logging in as that administrator. `deploy/bootstrap.sh`
 * is the other half — Docker, database roles, migrations, readiness — and it is
 * what runs this.
 *
 *   node bootstrap-install.mjs provision          < .env
 *   node bootstrap-install.mjs verify             < .env
 *   node bootstrap-install.mjs rotate             < .env
 *   node bootstrap-install.mjs onprem-credential  < .env
 *
 * ## Why it runs *inside* a container
 *
 * A plant server has Docker on it, because the product is containers. It does
 * not necessarily have Node, curl or jq, and Doc 11 §5.1's hard constraint —
 * no internet access — means it cannot go and get them. So the installer uses
 * what the bundle already contains: `bootstrap.sh` copies this file into the
 * running `iam-api` container and runs it with the Node that is already there.
 * Nothing is asked of the host but Docker and a POSIX shell.
 *
 * That is also why this file imports nothing at all. It is plain ESM over
 * `fetch`, built into Node since 18 — no dependency to add to an image whose
 * dependency set is deliberately pruned.
 *
 * ## Configuration is the `.env` file, on stdin
 *
 * Not argv, and not `docker exec -e`: both would put the platform secret and
 * the administrator's password into a process list, into the exec's own command
 * line, and into whatever shell history recorded the call. Piping the file in
 * keeps them in one process's memory.
 *
 * Parsing `.env` here rather than in the shell is the same argument from the
 * other side: building a JSON document out of shell variables means escaping
 * passwords in `sh`, which is a class of bug nobody should be writing at
 * installation time.
 *
 * ## Idempotence
 *
 * Re-running must change nothing and report the same state, because the
 * realistic reason to run an installer twice is that the first attempt failed
 * somewhere *after* this point. Every step is "ensure", not "create":
 *
 *   - the client is created, or found by slug when the slug is already taken;
 *   - the administrator is created, or reported as already present when the
 *     email is. The endpoint itself adopts the tenant's existing root scope node
 *     and admin role rather than duplicating them, so adding a second
 *     administrator is an ordinary operation rather than a repair.
 *
 * And one case that is not an error at all: a re-run *after* the operator has
 * rotated the bootstrap secret, exactly as they were told to. The platform
 * credential is then correctly dead. Rather than fail, this proves the install
 * the other way — by logging in as the administrator — and reports success.
 */

/** The account key migration 0011 seeds the platform identity under. */
const PLATFORM_ACCOUNT_KEY = 'platform-bootstrap';

/**
 * The account key migration 0019 seeds the restricted on-prem operator under
 * (roadmap Session 45, Doc 11 §6.4).
 *
 * It exists only in `single_tenant` mode, and it is created with a secret the
 * migration generates and discards — so it authenticates as nobody until
 * `onprem-credential` below rotates it and prints one. That is deliberate: the
 * alternative was a second live credential sitting in `.env` for the life of the
 * deployment beside the administrator's password.
 */
const ONPREM_ACCOUNT_KEY = 'onprem-operator';

/**
 * Reached by service name on the stack's own network, through the proxy.
 *
 * Through the proxy rather than at `iam-api:3000` directly, on purpose: it
 * exercises the same path a browser takes — prefix stripping included — so an
 * install cannot report success while the one component between the user and
 * the API is misrouting. Overridable for the same reason anything is: a stack
 * whose services are named differently.
 */
const API_BASE = process.env.PLANTOPS_API_BASE ?? 'http://proxy/api';
const CONSOLE_BASE = process.env.PLANTOPS_CONSOLE_BASE ?? 'http://proxy';

// ── .env parsing ────────────────────────────────────────────────────────────

/**
 * `KEY=value` lines, comments and blanks skipped, one level of quoting removed.
 *
 * Deliberately not a general dotenv implementation: no `export`, no variable
 * interpolation, no multi-line values. `deploy/.env.template` is the file this
 * reads and it uses none of those — its PEM values are written with escaped
 * newlines precisely so that every consumer of the file, this one included, can
 * treat a value as one line.
 */
function parseDotenv(contents) {
  const values = {};
  for (const line of contents.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(trimmed);
    if (!match) continue;
    values[match[1]] = match[2].trim().replace(/^["'](.*)["']$/, '$1');
  }
  return values;
}

/**
 * Everything the installer needs, and nothing it does not.
 *
 * `requireSecret` is false for `verify`, and that is the whole point of the
 * distinction: a correctly finished installation has had its bootstrap secret
 * rotated and the line deleted from `.env`. Demanding it back would mean the
 * bundled smoke test only worked on installations that had not followed the
 * instructions.
 */
function configFrom(values, { requireSecret }) {
  const missing = [];
  const need = (key, required = true) => {
    const value = values[key];
    if (required && (typeof value !== 'string' || value.trim() === '')) {
      missing.push(key);
    }
    return value;
  };

  const config = {
    bootstrapSecret: need('PLATFORM_BOOTSTRAP_SECRET', requireSecret),
    // Not validated here: `libs/config` owns what a legal value is, and this
    // reads it only to decide whether the on-prem operator should exist at all.
    deploymentMode: values['DEPLOYMENT_MODE'] ?? 'saas',
    client: { name: need('PLANTOPS_CLIENT_NAME'), slug: need('PLANTOPS_CLIENT_SLUG') },
    admin: {
      email: need('PLANTOPS_ADMIN_EMAIL'),
      fullName: need('PLANTOPS_ADMIN_NAME'),
      password: need('PLANTOPS_ADMIN_PASSWORD'),
    },
  };

  if (missing.length > 0) {
    throw new Error(
      `.env is missing a value for: ${missing.join(', ')}\n` +
        'Every one of them is described in .env.template.',
    );
  }
  return config;
}

// ── HTTP ────────────────────────────────────────────────────────────────────

/**
 * One request, with the body already read.
 *
 * Returns rather than throws on a 4xx: every caller has a specific 409 or 401
 * it treats as information rather than as failure, and an exception would make
 * those the awkward path.
 */
async function request(base, path, { method = 'GET', token, body } = {}) {
  const headers = { accept: 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers['content-type'] = 'application/json';

  let response;
  try {
    response = await fetch(`${base}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (error) {
    // Nearly always the stack still coming up, and `fetch`'s own message
    // ("fetch failed") names neither the address nor the reason.
    throw new Error(`${method} ${base}${path} could not be reached: ${describe(error)}`);
  }

  const text = await response.text();
  let payload;
  try {
    payload = text === '' ? undefined : JSON.parse(text);
  } catch {
    payload = undefined;
  }
  return { status: response.status, payload, text };
}

/** `AggregateError` and friends keep the useful part in `.errors` / `.cause`. */
function describe(error) {
  if (!(error instanceof Error)) return String(error);
  const parts = [error.message === '' ? error.name : error.message];
  if (error instanceof AggregateError) {
    for (const nested of error.errors) parts.push(describe(nested));
  } else if (error.cause !== undefined) {
    parts.push(describe(error.cause));
  }
  return parts.filter(Boolean).join(' — ');
}

/** The API's error envelope, reduced to something worth printing. */
function reason(result) {
  const error = result.payload?.error;
  if (error?.code) return `${error.code}: ${error.message ?? ''}`.trim();
  return result.text.slice(0, 300) || `HTTP ${result.status}`;
}

// ── Steps ───────────────────────────────────────────────────────────────────

/**
 * The platform token, or `null` when the credential is no longer accepted.
 *
 * `null` rather than an exception, because "this secret does not work" is the
 * *expected* state of a correctly finished installation — see the header.
 */
async function platformToken(secret) {
  const result = await request(API_BASE, '/auth/token', {
    method: 'POST',
    body: { account_key: PLATFORM_ACCOUNT_KEY, account_secret: secret },
  });

  if (result.status === 200 && result.payload?.access_token) {
    return result.payload.access_token;
  }
  if (result.status === 401) return null;

  throw new Error(
    `the platform credential exchange failed with HTTP ${result.status} — ${reason(result)}`,
  );
}

/**
 * Every page of a list endpoint, as one array.
 *
 * The envelope is `{ data, page, limit, total }` (Doc 06 §3) — `data`, not
 * `items`, and reading the wrong key is a silent empty list rather than an
 * error, which on the idempotence path reads as "the slug is taken but the
 * client does not exist". Worth a helper so both callers get it right once.
 */
async function listAll(token, path) {
  const rows = [];
  const limit = 100;
  for (let page = 1; page <= 50; page += 1) {
    const separator = path.includes('?') ? '&' : '?';
    const result = await request(API_BASE, `${path}${separator}page=${page}&limit=${limit}`, {
      token,
    });
    if (result.status !== 200) {
      throw new Error(`could not list ${path}: ${reason(result)}`);
    }
    const data = result.payload?.data;
    if (!Array.isArray(data)) {
      throw new Error(
        `${path} did not answer with a { data, page, limit, total } envelope — ` +
          'this installer and the API disagree about the response shape.',
      );
    }
    rows.push(...data);
    if (rows.length >= (result.payload.total ?? rows.length) || data.length === 0) {
      return rows;
    }
  }
  return rows;
}

/** Small by construction here: a single-tenant install has one client. */
async function findClientBySlug(token, slug) {
  const clients = await listAll(token, '/iam/clients');
  return clients.find((client) => client.slug === slug);
}

async function ensureClient(token, { name, slug }) {
  const created = await request(API_BASE, '/iam/clients', {
    method: 'POST',
    token,
    body: { name, slug },
  });

  if (created.status === 201) return { client: created.payload, created: true };

  // 409 is the per-slug unique index doing its job on a re-run. The slug is the
  // identity the operator chose, so finding it and carrying on is right;
  // picking a different one would silently install a second tenant.
  if (created.status === 409) {
    const existing = await findClientBySlug(token, slug);
    if (!existing) {
      throw new Error(
        `the slug "${slug}" is already taken, but no client with that slug is ` +
          'visible to this credential. Choose a different PLANTOPS_CLIENT_SLUG.',
      );
    }
    return { client: existing, created: false };
  }

  throw new Error(`could not create the client: ${reason(created)}`);
}

async function ensureAdmin(token, clientId, { email, fullName, password }) {
  const created = await request(API_BASE, `/iam/clients/${clientId}/admins`, {
    method: 'POST',
    token,
    body: { email, full_name: fullName, password },
  });

  if (created.status === 201) return { admin: created.payload, created: true };

  // The email is unique per client. On a re-run this is the expected answer,
  // and it is *not* an invitation to reset the password: silently overwriting a
  // credential the administrator may already have changed would be worse than
  // doing nothing.
  if (created.status === 409) return { admin: undefined, created: false };

  throw new Error(`could not create the first administrator: ${reason(created)}`);
}

async function adminCanLogIn({ slug, email, password }) {
  const result = await request(API_BASE, '/auth/login', {
    method: 'POST',
    body: { client_slug: slug, email, password },
  });
  return result.status === 200 && Boolean(result.payload?.access_token);
}

/**
 * The bundled smoke test (Session 42's definition of done).
 *
 * Four checks, in the order a failure is most likely and most informative.
 * They are the same four an engineer would perform by hand, and they run
 * through the front door — proxy included — because a stack that only works
 * when you reach around the proxy does not work.
 */
async function verify(config) {
  const failures = [];
  const note = (line) => console.log(`  ${line}`);

  const health = await request(API_BASE, '/health');
  if (health.status === 200 && health.payload?.status === 'ok') {
    note(`ok    API reachable at /api — version ${health.payload.version}`);
  } else {
    failures.push(`/api/health answered ${health.status}: ${reason(health)}`);
  }

  const ready = await request(API_BASE, '/ready');
  if (ready.status === 200) {
    note('ok    dependencies ready — Postgres and Redis both answered');
  } else {
    failures.push(
      `/api/ready answered ${ready.status} — ${JSON.stringify(ready.payload?.checks ?? {})}`,
    );
  }

  // The console is a separate image behind the same origin; a stack can have a
  // working API and a console that never started.
  const console_ = await request(CONSOLE_BASE, '/login');
  if (console_.status === 200) {
    note('ok    console serving at /');
  } else {
    failures.push(`the console answered ${console_.status} at /login`);
  }

  const canLogIn = await adminCanLogIn({
    slug: config.client.slug,
    email: config.admin.email,
    password: config.admin.password,
  });
  if (canLogIn) {
    note(`ok    ${config.admin.email} can log in to "${config.client.slug}"`);
  } else {
    failures.push(
      `${config.admin.email} could not log in to "${config.client.slug}" — ` +
        'the credentials in .env do not match what is stored',
    );
  }

  if (failures.length > 0) {
    throw new Error(`verification failed:\n  - ${failures.join('\n  - ')}`);
  }
}

/**
 * Replaces the platform credential with a fresh one and prints it once.
 *
 * Doc 07 §8 says the bootstrap secret is "rotated immediately after first use",
 * and Session 42 requires the step to be part of this installer's own output.
 * Printing an instruction an operator cannot carry out would satisfy the letter
 * of that and none of the point — on an air-gapped box there is no console to
 * open and no support engineer to ask — so the instruction is a command, and
 * this is what it runs.
 *
 * The rotation authorizes itself with the very credential it is retiring, which
 * is the only credential that exists at this moment and is exactly why it must
 * not be left lying in a file afterwards. The old secret stops working the
 * instant this returns.
 */
async function rotatePlatformSecret(config) {
  const token = await platformToken(config.bootstrapSecret);
  if (token === null) {
    throw new Error(
      'The platform credential was rejected, so there is nothing to rotate with. ' +
        'If it has already been rotated, this is the desired end state — delete ' +
        'PLATFORM_BOOTSTRAP_SECRET from .env and store the current value somewhere ' +
        'a person can find it in a year.',
    );
  }

  const accounts = await listAll(token, '/iam/service-accounts');
  const platform = accounts.find(
    (account) => account.account_key === PLATFORM_ACCOUNT_KEY,
  );
  if (!platform) {
    throw new Error(
      `no service account with key "${PLATFORM_ACCOUNT_KEY}" is visible to this ` +
        'credential, which should be impossible while it still works. Do not ' +
        'delete anything; capture this output and the API logs.',
    );
  }

  const rotated = await request(API_BASE, `/iam/service-accounts/${platform.id}/rotate`, {
    method: 'POST',
    token,
  });
  if (rotated.status !== 200 || !rotated.payload?.account_secret) {
    throw new Error(`rotation failed: ${reason(rotated)}`);
  }

  console.log(
    '\nThe platform credential has been rotated. The value that was in .env no ' +
      'longer works.\n\n' +
      '  account_key     ' +
      PLATFORM_ACCOUNT_KEY +
      '\n  account_secret  ' +
      rotated.payload.account_secret +
      '\n\n' +
      'This is the only time it will be shown. Store it where your organisation ' +
      'keeps credentials — not in .env, which the stack reads on every start and ' +
      'which no longer needs it. Delete the PLATFORM_BOOTSTRAP_SECRET line now.',
  );
}

/**
 * Issues the on-prem operator's credential and prints it once
 * (roadmap Session 45, Doc 11 §6.4).
 *
 * A separate command rather than a step of the install, and that is the whole
 * design. Minting it during `provision` would mean a second `./bootstrap.sh`
 * printed a *different* secret and quietly invalidated the one in use — which
 * would break the property Session 42 spent the most effort on, that re-running
 * the installer changes nothing.
 *
 * So the identity is provisioned by the migration and the credential is issued
 * when somebody asks for it. Until then it exists and authenticates as nobody,
 * which is the right default for a capability most installations never use.
 *
 * The rotation goes through the ordinary `POST /iam/service-accounts/:id/rotate`
 * — the same endpoint `--rotate-platform-secret` uses — so re-issuing later is
 * the same command, and the previous value stops working the instant it returns.
 */
async function issueOnPremCredential(config) {
  if (config.deploymentMode !== 'single_tenant') {
    throw new Error(
      `DEPLOYMENT_MODE is "${config.deploymentMode}", and the on-prem operator ` +
        'exists only in a single-tenant installation (Doc 11 §6.4). There is ' +
        'nothing to issue here.',
    );
  }

  const token = await platformToken(config.bootstrapSecret);
  if (token === null) {
    throw new Error(
      'The platform credential was rejected. Put the *current* value into .env ' +
        'for the length of this command — the one printed by ' +
        '`./bootstrap.sh --rotate-platform-secret`, not the one the install started with.',
    );
  }

  const accounts = await listAll(token, '/iam/service-accounts');
  const operator = accounts.find((account) => account.account_key === ONPREM_ACCOUNT_KEY);
  if (!operator) {
    throw new Error(
      `No service account with key "${ONPREM_ACCOUNT_KEY}" exists.\n\n` +
        'It is created by migration 0019, and only when DEPLOYMENT_MODE is ' +
        'single_tenant at the moment the migration runs. A database first ' +
        'migrated in saas mode does not have it, and migrations do not re-run — ' +
        'see deploy/README.md §4.',
    );
  }

  const rotated = await request(API_BASE, `/iam/service-accounts/${operator.id}/rotate`, {
    method: 'POST',
    token,
  });
  if (rotated.status !== 200 || !rotated.payload?.account_secret) {
    throw new Error(`could not issue the credential: ${reason(rotated)}`);
  }

  console.log(
    '\nThe on-prem operator credential has been issued. Any previous value no ' +
      'longer works.\n\n' +
      '  account_key     ' +
      ONPREM_ACCOUNT_KEY +
      '\n  account_secret  ' +
      rotated.payload.account_secret +
      '\n\n' +
      'This is the only time it will be shown.\n\n' +
      'What it can do: read the application catalog, this organisation and its\n' +
      'enabled applications, and the audit trail — through the API, with\n' +
      'POST /api/auth/token. What it cannot do: change any of them. It is a\n' +
      'machine identity, so it does not sign in to the console.\n\n' +
      'Store it where your organisation keeps credentials, and remove\n' +
      'PLATFORM_BOOTSTRAP_SECRET from .env again.',
  );
}

// ── Entry ───────────────────────────────────────────────────────────────────

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf-8');
}

async function provision(config) {
  const token = await platformToken(config.bootstrapSecret);

  if (token === null) {
    // Either the secret was rotated after a successful install — the state the
    // runbook asks for — or it is wrong. The difference is decidable: ask
    // whether the administrator this installer would have created can log in.
    const installed = await adminCanLogIn({
      slug: config.client.slug,
      email: config.admin.email,
      password: config.admin.password,
    });

    if (installed) {
      console.log(
        'The platform credential is no longer accepted and the administrator can ' +
          'log in: this installation is already provisioned and its bootstrap ' +
          'secret has been rotated. Nothing to do.',
      );
      return;
    }

    throw new Error(
      'The platform credential was rejected, and the configured administrator ' +
        'cannot log in either.\n\n' +
        'On a first install this means PLATFORM_BOOTSTRAP_SECRET in .env is not ' +
        'the value the database was seeded with. It is read exactly once, by the ' +
        'migration that creates the platform identity, so changing it afterwards ' +
        'has no effect on what was stored — see the recovery note in README.md.\n' +
        'On a re-install it means the secret has been rotated (correct) and the ' +
        'administrator credentials in .env no longer match (not).',
    );
  }

  const { client, created: clientCreated } = await ensureClient(token, config.client);
  console.log(
    clientCreated
      ? `Created client "${client.name}" (slug ${client.slug}, id ${client.id}).`
      : `Client "${client.name}" (slug ${client.slug}) already exists — left as it is.`,
  );

  const { admin, created: adminCreated } = await ensureAdmin(
    token,
    client.id,
    config.admin,
  );
  console.log(
    adminCreated
      ? `Created administrator ${admin.email} — role "${admin.role_name}", ` +
          `bound at scope "${admin.scope_node_name}" (${admin.scope_node_path}).`
      : `Administrator ${config.admin.email} already exists for this client — ` +
          'left as it is, password included.',
  );

  // Reported, never issued here — see `issueOnPremCredential` for why the
  // credential is a separate, explicit command.
  if (config.deploymentMode === 'single_tenant') {
    const accounts = await listAll(token, '/iam/service-accounts');
    const operator = accounts.find(
      (account) => account.account_key === ONPREM_ACCOUNT_KEY,
    );
    console.log(
      operator
        ? 'The restricted on-prem operator identity is provisioned and holds no ' +
            'usable credential yet. Run `./bootstrap.sh --onprem-credential` if ' +
            'your IT need read-only visibility of the catalog and audit.'
        : 'Note: no on-prem operator identity exists. It is seeded by migration ' +
            '0019 when DEPLOYMENT_MODE is single_tenant — see deploy/README.md §4.',
    );
  }
}

async function main() {
  const mode = process.argv[2] ?? 'provision';
  const modes = ['provision', 'verify', 'rotate', 'onprem-credential'];
  if (!modes.includes(mode)) {
    throw new Error(`unknown mode "${mode}" — expected one of: ${modes.join(', ')}`);
  }

  const config = configFrom(parseDotenv(await readStdin()), {
    requireSecret: mode !== 'verify',
  });

  if (mode === 'rotate') {
    await rotatePlatformSecret(config);
    return;
  }

  if (mode === 'onprem-credential') {
    await issueOnPremCredential(config);
    return;
  }

  if (mode === 'provision') {
    // Deliberately *not* followed by `verify` here. In a single-tenant
    // installation the API resolved its organisation at boot, which on a first
    // install was before this step created it — so it is still refusing logins
    // until `bootstrap.sh` restarts it. The installer runs `verify` after that
    // restart, which is the first moment the answer means anything.
    await provision(config);
    return;
  }

  await verify(config);
}

main().catch((error) => {
  console.error(`\nbootstrap-install (${process.argv[2] ?? 'provision'}) failed.\n\n${describe(error)}`);
  process.exitCode = 1;
});
