/**
 * The two-tenant seed fixture — Session 38's shared ground truth.
 *
 * Every file in the battery starts from the same shape: two tenants that know
 * nothing about each other, each with a three-level org tree, three roles, five
 * people, a machine identity, and a set of bindings chosen so that *one* subject
 * exercises *one* property of Doc 04's resolution rules. Cross-tenant isolation
 * is not a special case bolted on at the end; it is the default arrangement,
 * which is what makes a leak show up in an ordinary assertion.
 *
 * ## It is built over HTTP, on purpose
 *
 * The in-process suites in `apps/iam-api` assemble their fixtures with raw SQL
 * on the owner connection, and their headers explain why: a suite about the
 * scope tree should not go red because Session 15's provisioning endpoint
 * changed. This one takes the opposite side of exactly that trade, because it
 * is the *battery* — if `POST /iam/clients/:id/admins` stops creating a root
 * scope node, a suite that seeds one itself will never notice, and Doc 08 §7's
 * "prove the security properties" is not served by a fixture that routes around
 * the product. So `purgeTenants` is the only function here that touches the
 * database, and it does so only because no endpoint deletes a tenant.
 *
 * ## Prefixes, not cleanup between files
 *
 * `seedTwoTenants('e2e-rls-')` purges and recreates only slugs starting with
 * that prefix. Files therefore cannot corrupt each other's tenants even though
 * they share one database and one API process, and a file can be run alone with
 * `-t` without depending on what ran before it.
 *
 * The `e2e-ops` **application** is the one shared thing — it is platform
 * catalogue, not tenant data, and the manifest upsert is idempotent by
 * construction (Doc 02 §2), so every file re-uploading the same document is a
 * no-op after the first.
 */

import { as, expectOk, type Caller } from './api';
import { connectOwner, elevateOwner, rows, S } from './database';
import { logSize, waitForResetToken } from './server-log';

/** The bootstrap identity migration 0011 seeds; the only way in on a fresh DB. */
const PLATFORM_ACCOUNT_KEY = 'platform-bootstrap';
const PLATFORM_CLIENT_SLUG = 'platform';

/** The application the battery registers for itself, so its assertions do not
 * depend on the IAM's own catalogue changing shape. */
export const OPS_APPLICATION_KEY = 'e2e-ops';

export const PERM = {
  CREATE: 'e2e-ops.dc.create',
  APPROVE: 'e2e-ops.dc.approve',
  VISITOR: 'e2e-ops.visitor.read',
} as const;

/** Long enough for the Doc 03 §7 minimum, and obviously a fixture. */
const PASSWORD = 'E2E-Fixture-Pass-1';

export interface FixtureScope {
  id: string;
  name: string;
  path: string;
}

export interface FixtureUser {
  id: string;
  email: string;
  password: string;
}

export interface FixtureServiceAccount {
  id: string;
  accountKey: string;
  accountSecret: string;
}

export interface FixtureTenant {
  slug: string;
  clientId: string;

  /** Root → Plant A → Dept A1 → Gate A11, and a sibling Plant B → Gate B1. */
  root: FixtureScope;
  plantA: FixtureScope;
  deptA1: FixtureScope;
  gateA11: FixtureScope;
  plantB: FixtureScope;
  gateB1: FixtureScope;

  /** The `is_system` role `POST /clients/:id/admins` creates and binds. */
  clientAdminRoleId: string;
  operatorRoleId: string;
  approverRoleId: string;
  /** Carries `e2e-ops.visitor.read`, and is bound to nobody — a spare. */
  visitorRoleId: string;

  /** Permission key → id, for the enabled applications of this tenant. */
  permissionIds: Readonly<Record<string, string>>;

  /** Client Admin at the root: everything, everywhere in this tenant. */
  admin: FixtureUser;
  /** Client Admin at **Plant A only** — the subject that makes SCOPE_DENIED
   * distinguishable from PERMISSION_DENIED. */
  plantAdmin: FixtureUser;
  /** `dc.create` at Plant A *and* at Gate A11 — the minimisation case. */
  operator: FixtureUser;
  /** `dc.approve` at the root and `dc.create` at Plant A — two permissions with
   * different covering sets, which is the per-permission minimisation case. */
  approver: FixtureUser;
  /** No bindings at all — Doc 04 §9's deny-by-default subject. */
  outsider: FixtureUser;
  /** A machine identity holding `dc.create` at Gate A11. */
  machine: FixtureServiceAccount;
}

export interface TwoTenants {
  /** A freshly minted platform token. Short-lived — prefer {@link platformToken}. */
  platformToken: string;
  iamApplicationId: string;
  opsApplicationId: string;
  alpha: FixtureTenant;
  beta: FixtureTenant;
}

interface TokenPair {
  access_token: string;
  refresh_token: string;
  expires_in: number;
}

/* ── the platform identity ──────────────────────────────────────────────── */

let cachedPlatformToken: { token: string; mintedAt: number } | undefined;

/**
 * A platform-tier access token, re-minted when the cached one is getting old.
 *
 * Service tokens live ≤5 minutes by design (Doc 03 §5 — an ephemeral `sid`
 * cannot be revoked, so the TTL *is* the revocation window). A file that seeds
 * once and then spends four minutes on assertions would otherwise start getting
 * 401s halfway through, which reads as an authorization regression.
 */
export async function platformToken(): Promise<string> {
  const age = cachedPlatformToken
    ? Date.now() - cachedPlatformToken.mintedAt
    : Infinity;
  if (cachedPlatformToken && age < 120_000) return cachedPlatformToken.token;

  const secret = process.env['PLATFORM_BOOTSTRAP_SECRET'];
  if (secret === undefined || secret.length === 0) {
    throw new Error(
      'PLATFORM_BOOTSTRAP_SECRET is unset. It is the only identity a freshly ' +
        'migrated database has (Doc 07 §8) and the battery cannot seed without it.',
    );
  }

  const response = await as(undefined).post<{ access_token: string }>(
    '/auth/token',
    { account_key: PLATFORM_ACCOUNT_KEY, account_secret: secret },
  );
  const { access_token } = expectOk(response, 'platform token exchange');
  cachedPlatformToken = { token: access_token, mintedAt: Date.now() };
  return access_token;
}

/** A caller bound to a fresh-enough platform token. */
export async function platform(): Promise<Caller> {
  return as(await platformToken());
}

/** Signs a fixture user in and returns the pair, for the flows that need both. */
export async function login(
  tenant: Pick<FixtureTenant, 'slug'>,
  user: FixtureUser,
  deviceLabel?: string,
): Promise<TokenPair> {
  const response = await as(undefined).post<TokenPair>('/auth/login', {
    email: user.email,
    password: user.password,
    client_slug: tenant.slug,
    ...(deviceLabel === undefined ? {} : { device_label: deviceLabel }),
  });
  return expectOk(response, `login ${user.email}`);
}

/** Signs in and returns a caller — the common case. */
export async function callerFor(
  tenant: Pick<FixtureTenant, 'slug'>,
  user: FixtureUser,
): Promise<Caller> {
  return as((await login(tenant, user)).access_token);
}

/** Exchanges a service account's credentials for an access token. */
export async function machineToken(
  machine: FixtureServiceAccount,
): Promise<string> {
  const response = await as(undefined).post<{ access_token: string }>(
    '/auth/token',
    {
      account_key: machine.accountKey,
      account_secret: machine.accountSecret,
    },
  );
  return expectOk(response, 'service token exchange').access_token;
}

/* ── seeding ────────────────────────────────────────────────────────────── */

/**
 * Purges the prefix, registers the shared application, and builds both tenants.
 *
 * @param prefix a slug prefix owned by exactly one spec file, e.g. `e2e-rls-`.
 */
export async function seedTwoTenants(prefix: string): Promise<TwoTenants> {
  assertPrefix(prefix);
  await purgeTenants(prefix);

  const admin = await platform();
  const opsApplicationId = await ensureOpsApplication(admin);
  const iamApplicationId = await applicationIdFor(admin, 'iam');

  const alpha = await seedTenant({
    prefix,
    suffix: 'alpha',
    displayName: 'E2E Alpha Industries',
    iamApplicationId,
    opsApplicationId,
  });
  const beta = await seedTenant({
    prefix,
    suffix: 'beta',
    displayName: 'E2E Beta Logistics',
    iamApplicationId,
    opsApplicationId,
  });

  return {
    platformToken: await platformToken(),
    iamApplicationId,
    opsApplicationId,
    alpha,
    beta,
  };
}

/**
 * A prefix that could match a real tenant is a fixture that could delete one.
 * `purgeTenants` runs `slug like '<prefix>%'` as the owner, so this guard is the
 * only thing between a typo and somebody's data.
 */
function assertPrefix(prefix: string): void {
  if (!/^e2e-[a-z0-9]+-$/.test(prefix)) {
    throw new Error(
      `Fixture prefix ${JSON.stringify(prefix)} must look like "e2e-<file>-" ` +
        `— the purge deletes every client whose slug starts with it.`,
    );
  }
}

interface SeedInput {
  prefix: string;
  suffix: string;
  displayName: string;
  iamApplicationId: string;
  opsApplicationId: string;
}

async function seedTenant(input: SeedInput): Promise<FixtureTenant> {
  const slug = `${input.prefix}${input.suffix}`;
  const admin = await platform();

  const client = expectOk(
    await admin.post<{ id: string }>('/iam/clients', {
      name: `${input.displayName} (${input.suffix})`,
      slug,
    }),
    `create client ${slug}`,
  );

  // Both applications, because a tenant with no enabled application has an
  // empty permission catalogue and its admin cannot be given anything.
  expectOk(
    await admin.post(`/iam/clients/${client.id}/applications`, {
      applications: [
        { application_id: input.iamApplicationId },
        { application_id: input.opsApplicationId },
      ],
    }),
    `enable applications for ${slug}`,
  );

  // One call: user + root scope node + Client Admin role + binding (Doc 02 §3).
  const bootstrap = expectOk(
    await admin.post<{
      user_id: string;
      role_id: string;
      scope_node_id: string;
      scope_node_name: string;
      scope_node_path: string;
    }>(`/iam/clients/${client.id}/admins`, {
      email: `admin@${slug}.test`,
      full_name: 'Fixture Administrator',
      password: PASSWORD,
      scope_name: 'Head Office',
    }),
    `bootstrap admin for ${slug}`,
  );

  const adminUser: FixtureUser = {
    id: bootstrap.user_id,
    email: `admin@${slug}.test`,
    password: PASSWORD,
  };
  const root: FixtureScope = {
    id: bootstrap.scope_node_id,
    name: bootstrap.scope_node_name,
    path: bootstrap.scope_node_path,
  };

  const tenantAdmin = as((await login({ slug }, adminUser)).access_token);

  const plantA = await addScope(tenantAdmin, root.id, 'plant', 'Plant A');
  const deptA1 = await addScope(tenantAdmin, plantA.id, 'department', 'Dispatch');
  const gateA11 = await addScope(tenantAdmin, deptA1.id, 'gate', 'Gate A11');
  const plantB = await addScope(tenantAdmin, root.id, 'plant', 'Plant B');
  const gateB1 = await addScope(tenantAdmin, plantB.id, 'gate', 'Gate B1');

  const catalog = expectOk(
    await tenantAdmin.get<{ permissions: { id: string; key: string }[] }>(
      '/iam/roles/permission-catalog',
    ),
    `permission catalogue for ${slug}`,
  );
  const permissionIds = Object.fromEntries(
    catalog.permissions.map((permission) => [permission.key, permission.id]),
  );

  const operatorRoleId = await addRole(tenantAdmin, 'E2E Operator', [
    permissionIds[PERM.CREATE],
  ]);
  const approverRoleId = await addRole(tenantAdmin, 'E2E Approver', [
    permissionIds[PERM.APPROVE],
  ]);
  const visitorRoleId = await addRole(tenantAdmin, 'E2E Visitor', [
    permissionIds[PERM.VISITOR],
  ]);

  const plantAdmin = await createUserWithPassword(tenantAdmin, slug, 'plant-admin');
  const operator = await createUserWithPassword(tenantAdmin, slug, 'operator');
  const approver = await createUserWithPassword(tenantAdmin, slug, 'approver');
  const outsider = await createUserWithPassword(tenantAdmin, slug, 'outsider');

  const machine = expectOk(
    await tenantAdmin.post<{
      id: string;
      account_key: string;
      account_secret: string;
    }>('/iam/service-accounts', { name: 'Fixture Machine' }),
    `create service account for ${slug}`,
  );

  for (const binding of [
    // Every client permission, but only beneath one plant.
    { user_id: plantAdmin.id, role_id: bootstrap.role_id, scope_node_id: plantA.id },
    // Ancestor *and* descendant for the same permission — Doc 04 §4's
    // minimal-covering-set rule has to drop the second.
    { user_id: operator.id, role_id: operatorRoleId, scope_node_id: plantA.id },
    { user_id: operator.id, role_id: operatorRoleId, scope_node_id: gateA11.id },
    // Two permissions whose covering sets differ, minimised independently.
    { user_id: approver.id, role_id: approverRoleId, scope_node_id: root.id },
    { user_id: approver.id, role_id: operatorRoleId, scope_node_id: plantA.id },
    // A machine identity, bound exactly like a person (Doc 01 §4.5).
    {
      service_account_id: machine.id,
      role_id: operatorRoleId,
      scope_node_id: gateA11.id,
    },
  ]) {
    expectOk(
      await tenantAdmin.post('/iam/role-bindings', binding),
      `bind ${JSON.stringify(binding)}`,
    );
  }

  return {
    slug,
    clientId: client.id,
    root,
    plantA,
    deptA1,
    gateA11,
    plantB,
    gateB1,
    clientAdminRoleId: bootstrap.role_id,
    operatorRoleId,
    approverRoleId,
    visitorRoleId,
    permissionIds,
    admin: adminUser,
    plantAdmin,
    operator,
    approver,
    outsider,
    machine: {
      id: machine.id,
      accountKey: machine.account_key,
      accountSecret: machine.account_secret,
    },
  };
}

async function addScope(
  caller: Caller,
  parentId: string,
  kind: string,
  name: string,
): Promise<FixtureScope> {
  const node = expectOk(
    await caller.post<{ id: string; name: string; path: string }>('/iam/scopes', {
      parent_id: parentId,
      kind,
      name,
    }),
    `create scope ${name}`,
  );
  return { id: node.id, name: node.name, path: node.path };
}

async function addRole(
  caller: Caller,
  name: string,
  permissionIds: string[],
): Promise<string> {
  const role = expectOk(
    await caller.post<{ id: string }>('/iam/roles', { name }),
    `create role ${name}`,
  );
  expectOk(
    await caller.put(`/iam/roles/${role.id}/permissions`, {
      permission_ids: permissionIds,
    }),
    `map permissions onto ${name}`,
  );
  return role.id;
}

/**
 * Creates a user and gives them a password through the reset flow.
 *
 * `POST /iam/users` deliberately takes no password — Doc 03 §7's reset is *how*
 * an invited user gets one, and `auth_complete_password_reset` upserts the
 * `user_identity` for exactly this case. Driving it here means every fixture
 * login is standing on a path the product actually ships, and it costs the
 * suite nothing: the token is read from the API's own log, the same place a
 * developer reads it (see `server-log.ts`).
 *
 * Exported because several spec files need a *disposable* subject — one they
 * may lock, disable or reset without the four fixture users changing under the
 * cases that come after.
 */
export async function createUserWithPassword(
  caller: Caller,
  slug: string,
  local: string,
): Promise<FixtureUser> {
  const email = `${local}@${slug}.test`;
  const user = expectOk(
    await caller.post<{ id: string }>('/iam/users', {
      email,
      full_name: `Fixture ${local}`,
    }),
    `create user ${email}`,
  );

  const before = logSize();
  expectOk(
    await as(undefined).post('/auth/password/reset-request', {
      email,
      client_slug: slug,
    }),
    `request reset for ${email}`,
  );
  const token = await waitForResetToken(before);

  expectOk(
    await as(undefined).post('/auth/password/reset', {
      token,
      new_password: PASSWORD,
    }),
    `complete reset for ${email}`,
  );

  return { id: user.id, email, password: PASSWORD };
}

/* ── the shared application ─────────────────────────────────────────────── */

async function applicationIdFor(caller: Caller, key: string): Promise<string> {
  const catalog = expectOk(
    await caller.get<{ data: { id: string; key: string }[] }>(
      '/iam/applications?limit=100',
    ),
    'list applications',
  );
  const application = catalog.data.find((entry) => entry.key === key);
  if (application === undefined) {
    throw new Error(
      `The ${key} application is not registered. Run \`npm run migration:run\`; ` +
        `migration 0017 seeds the IAM's own catalogue.`,
    );
  }
  return application.id;
}

/**
 * Registers `e2e-ops` and uploads its manifest, idempotently.
 *
 * Three permissions and a small menu, chosen for what they let the resolution
 * matrix say: `dc.create` and `dc.approve` are the asymmetric pair (Doc 04 §5 —
 * holding one must never imply the other), `visitor.read` is a third key that
 * nobody in the fixture holds, and the nav has one node behind each of the
 * first two plus one `isPublic` node, which is Doc 05 §5's opt-in branch.
 */
async function ensureOpsApplication(caller: Caller): Promise<string> {
  const created = await caller.post<{ id: string }>('/iam/applications', {
    key: OPS_APPLICATION_KEY,
    name: 'E2E Operations',
    description: 'Fixture application for the Session 38 hardening battery.',
  });

  const id =
    created.status === 201
      ? created.data.id
      : await applicationIdFor(caller, OPS_APPLICATION_KEY);

  expectOk(
    await caller.post(`/iam/applications/${id}/manifest`, {
      key: OPS_APPLICATION_KEY,
      name: 'E2E Operations',
      permissions: [
        { key: PERM.CREATE, name: 'Create delivery challan' },
        { key: PERM.APPROVE, name: 'Approve delivery challan' },
        { key: PERM.VISITOR, name: 'Read visitors' },
      ],
      nav: [
        {
          kind: 'module',
          key: 'e2e-ops.root',
          label: 'E2E Operations',
          sortOrder: 10,
          children: [
            {
              kind: 'menu',
              key: 'e2e-ops.dc',
              label: 'Delivery challans',
              route: '/dc',
              sortOrder: 10,
              requires: [PERM.CREATE],
            },
            {
              kind: 'menu',
              key: 'e2e-ops.approvals',
              label: 'Approvals',
              route: '/approvals',
              sortOrder: 20,
              requires: [PERM.APPROVE],
            },
            {
              kind: 'menu',
              key: 'e2e-ops.help',
              label: 'Help',
              route: '/help',
              sortOrder: 30,
              isPublic: true,
            },
          ],
        },
      ],
    }),
    'upsert the e2e-ops manifest',
  );

  return id;
}

/* ── teardown ───────────────────────────────────────────────────────────── */

/**
 * Removes every client whose slug starts with `prefix`, and everything under it.
 *
 * Out of band because there is no tenant-delete endpoint, and there should not
 * be one: Doc 02 keeps tenant data and suspends instead. The order matters —
 * `scope_node.parent_id` is `on delete restrict` (Doc 01 §6), so the tree comes
 * off leaves-first.
 */
export async function purgeTenants(prefix: string): Promise<void> {
  assertPrefix(prefix);
  const owner = await connectOwner();

  try {
    await elevateOwner(owner);
    const clients = await rows<{ id: string }>(
      owner,
      `select id from ${S}."client" where slug like $1 and slug <> $2`,
      [`${prefix}%`, PLATFORM_CLIENT_SLUG],
    );

    for (const { id } of clients) {
      await elevateOwner(owner, id);
      for (const statement of [
        `delete from ${S}."role_binding" where client_id = $1`,
        `delete from ${S}."session" where client_id = $1`,
        `delete from ${S}."password_reset_token" where client_id = $1`,
        `delete from ${S}."user_identity" where client_id = $1`,
        `delete from ${S}."user" where client_id = $1`,
        `delete from ${S}."service_account" where client_id = $1`,
        `delete from ${S}."role" where client_id = $1`,
        `delete from ${S}."client_application" where client_id = $1`,
        `delete from ${S}."audit_trail" where client_id = $1`,
      ]) {
        await owner.query(statement, [id]);
      }
      for (let depth = 8; depth >= 1; depth -= 1) {
        await owner.query(
          `delete from ${S}."scope_node" where client_id = $1 and nlevel(path) = $2`,
          [id, depth],
        );
      }
      await owner.query(`delete from ${S}."client" where id = $1`, [id]);
    }
  } finally {
    await owner.end();
  }
}
