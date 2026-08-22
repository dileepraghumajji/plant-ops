/**
 * The restricted on-prem platform role, and break-glass recovery
 * (roadmap Session 45, Doc 11 §6.4, §12 decisions 4 and 10).
 *
 * Two properties, and neither is provable by reading the seed.
 *
 * ## 1. The role reads everything and writes nothing
 *
 * Migration 0019 maps six `iam.platform.*.read` keys onto a role and maps no
 * write key at all. That is a claim about a `role_permission` table; what
 * matters to a client is what the *API* does when somebody bound to it calls it.
 * So the suite binds a real subject, mints a real token, and drives both halves:
 * every granted read answers 2xx, and every withheld write answers 403 with
 * `PERMISSION_DENIED`.
 *
 * The withheld list is asserted **exhaustively against the platform tier**, not
 * against a sample. A role that quietly gained `iam.platform.app.update` in some
 * later session would still pass a suite that only checked the five writes
 * somebody thought of on the day; it cannot pass one that enumerates the tier
 * and demands a 403 for everything that is not in the granted six.
 *
 * ## 2. Break-glass gets a locked-out administrator back in
 *
 * `tools/break-glass-admin.ts` is a host command, and this is the one place in
 * the battery that shells out to a tool rather than driving an endpoint. Session
 * 43 took the opposite side of that trade deliberately — there, testing the
 * endpoint proved the behaviour the tool depended on. Here there *is* no
 * endpoint: unlocking a user is `iam.client.user.update` inside the tenant, and
 * a platform token's `cid` is the platform client, so the capability exists only
 * as the command. Testing anything else would be testing something else.
 *
 * The proof is end-to-end and not a row count: an administrator is locked
 * through the ordinary API, their login is refused, the command runs, and the
 * password it prints logs in. The audit record is then read back through
 * `GET /iam/audit?action=platform.break_glass`, which also proves the action is
 * a value the read API's filter accepts (Doc 06 §12).
 *
 * ## Why the binding is made with SQL
 *
 * The one thing here that does not go through the API, and it is not an
 * oversight. `POST /iam/role-bindings` needs `iam.client.binding.create` *in the
 * platform tenant*, and the platform tier deliberately holds no client-tier user
 * permissions (migration 0017) — so no credential that exists can make this
 * binding over HTTP. That is precisely why migration 0019 makes the real one,
 * and why this suite makes its own the same way.
 */

import { IamErrorCode } from '@plantops/contracts';
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { as, expectOk, type ApiResponse, type Caller } from './support/api';
import { connectOwner, elevateOwner, rows, S } from './support/database';
import {
  PERM,
  callerFor,
  platform,
  purgeTenants,
  seedTwoTenants,
  type FixtureTenant,
} from './support/two-tenant-fixture';

const execFileAsync = promisify(execFile);

const PREFIX = 'e2e-onprem-';
/**
 * The break-glass block seeds its own tenant, because its administrators get
 * locked and their passwords replaced, and the role block's assertions should
 * not be reading a tenant somebody is being locked out of.
 *
 * One segment after `e2e-`, not two: `assertPrefix` allows `e2e-<word>-` and
 * nothing else, precisely because the purge deletes every client whose slug
 * starts with what it is given.
 */
const BREAK_GLASS_PREFIX = 'e2e-breakglass-';
const PLATFORM_CLIENT_SLUG = 'platform';

/** Must match `ONPREM_ROLE_NAME` in migration 0019. */
const ONPREM_ROLE_NAME = 'On-Prem Operator';

/**
 * The six keys the role grants (Doc 11 §6.4). Restated here rather than imported
 * from `@plantops/db`, which the `app:iam-api-e2e` boundary keeps out of this
 * project on purpose — a suite that imported the seed's own constant would
 * assert that the seed equals itself.
 */
const GRANTED = [
  'iam.platform.app.read',
  'iam.platform.permission.read',
  'iam.platform.nav.read',
  'iam.platform.client.read',
  'iam.platform.client.app.read',
  'iam.platform.audit.read',
] as const;

/** Name of the service account this suite creates in the platform tenant. */
const OPERATOR_ACCOUNT_NAME = 'E2E On-Prem Operator';

const REPO_ROOT = join(__dirname, '..', '..', '..');
const BREAK_GLASS = join('tools', 'break-glass-admin.ts');
const DB_TSCONFIG = join('libs', 'db', 'tsconfig.lib.json');

/**
 * The transpiler's own entry point, run by this process's `node`.
 *
 * Not `npx tsx`, which on Windows is a `.cmd` shim that `execFile` can only
 * reach through a shell — and a shell re-splits the argument array on spaces,
 * so `--name "Break Glass Created"` arrives as three arguments. Naming the
 * script directly keeps `execFile`'s array semantics, which is the whole reason
 * to use `execFile` rather than `exec`.
 */
const TSX_CLI = join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');

/** Runs the command with `overrides` layered over this process's environment. */
function runBreakGlass(
  args: readonly string[],
  overrides: NodeJS.ProcessEnv = {},
): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(
    process.execPath,
    [TSX_CLI, '--tsconfig', DB_TSCONFIG, BREAK_GLASS, ...args],
    { cwd: REPO_ROOT, env: { ...process.env, ...overrides } },
  );
}

interface Page<T> {
  data: T[];
  total: number;
}

interface ApplicationRow {
  id: string;
  key: string;
}

interface AuditRow {
  action: string;
  actor_type: string;
  target_type: string;
  payload: Record<string, unknown>;
}

interface BreakGlassResult {
  stdout: string;
  password: string;
}

/**
 * Runs the host command exactly as an operator would, and returns what it
 * printed.
 *
 * The child inherits this process's environment, which already carries
 * `DATABASE_DIRECT_URL`, `DATABASE_SSL` and `PLATFORM_BOOTSTRAP_SECRET` — the
 * three things the tool needs and the same three a real install hands it out of
 * `.env`. Run from the workspace root so its relative imports resolve the way
 * they do in the `plantops/migrate` image.
 */
async function breakGlass(args: readonly string[]): Promise<BreakGlassResult> {
  const { stdout } = await runBreakGlass(args);

  const password = /^\s*password\s+(\S+)\s*$/m.exec(stdout)?.[1];
  if (password === undefined) {
    throw new Error(`break-glass printed no password:\n${stdout}`);
  }
  return { stdout, password };
}

/** Removes any operator account this suite left behind, and its bindings. */
async function purgeOperatorAccount(): Promise<void> {
  const owner = await connectOwner();
  try {
    await elevateOwner(owner);
    const [platformClient] = await rows<{ id: string }>(
      owner,
      `select id from ${S}."client" where slug = $1`,
      [PLATFORM_CLIENT_SLUG],
    );
    if (platformClient === undefined) return;

    await elevateOwner(owner, platformClient.id);
    const accounts = await rows<{ id: string }>(
      owner,
      `select id from ${S}."service_account" where name = $1`,
      [OPERATOR_ACCOUNT_NAME],
    );
    for (const { id } of accounts) {
      await owner.query(
        `delete from ${S}."role_binding" where service_account_id = $1`,
        [id],
      );
      await owner.query(`delete from ${S}."service_account" where id = $1`, [id]);
    }
  } finally {
    await owner.end();
  }
}

/**
 * A caller holding the on-prem role and nothing else.
 *
 * The account is created through the ordinary endpoint — the platform tier does
 * hold `iam.client.svc.create` (migration 0017) — and only the binding is made
 * with SQL, for the reason the file header gives.
 */
async function seedOperator(): Promise<Caller> {
  const admin = await platform();

  const account = expectOk(
    await admin.post<{ id: string; account_key: string; account_secret: string }>(
      '/iam/service-accounts',
      { name: OPERATOR_ACCOUNT_NAME },
    ),
    'create the operator service account',
  );

  const owner = await connectOwner();
  try {
    await elevateOwner(owner);
    const [platformClient] = await rows<{ id: string }>(
      owner,
      `select id from ${S}."client" where slug = $1`,
      [PLATFORM_CLIENT_SLUG],
    );
    await elevateOwner(owner, platformClient.id);

    const [role] = await rows<{ id: string }>(
      owner,
      `select id from ${S}."role" where client_id = $1 and name = $2`,
      [platformClient.id, ONPREM_ROLE_NAME],
    );
    if (role === undefined) {
      throw new Error(
        `Migration 0019 has not been applied: no "${ONPREM_ROLE_NAME}" role in the platform tenant.`,
      );
    }

    const [rootScope] = await rows<{ id: string }>(
      owner,
      `select id from ${S}."scope_node"
        where client_id = $1 and parent_id is null
        order by created_at asc, id asc limit 1`,
      [platformClient.id],
    );

    await owner.query(
      `insert into ${S}."role_binding" (client_id, service_account_id, role_id, scope_node_id)
       values ($1, $2, $3, $4)
       on conflict do nothing`,
      [platformClient.id, account.id, role.id, rootScope.id],
    );
  } finally {
    await owner.end();
  }

  const token = expectOk(
    await as(undefined).post<{ access_token: string }>('/auth/token', {
      account_key: account.account_key,
      account_secret: account.account_secret,
    }),
    'operator token exchange',
  );

  return as(token.access_token);
}

describe('the restricted on-prem platform role', () => {
  let operator: Caller;
  let tenant: FixtureTenant;
  let iamApplicationId: string;
  let opsApplicationId: string;

  beforeAll(async () => {
    await purgeOperatorAccount();
    const seeded = await seedTwoTenants(PREFIX);
    tenant = seeded.alpha;
    iamApplicationId = seeded.iamApplicationId;
    opsApplicationId = seeded.opsApplicationId;
    operator = await seedOperator();
  });

  afterAll(async () => {
    await purgeOperatorAccount();
    await purgeTenants(PREFIX);
  });

  describe('grants exactly the keys Doc 11 §6.4 lists', () => {
    it('resolves those six and nothing else at all', async () => {
      const resolved = expectOk(
        await operator.get<{ permissions: string[] }>('/iam/permissions/resolve'),
        'resolve the operator’s own grants',
      );

      // The whole set, not the `iam.platform.` slice of it. Equality, and over
      // everything: a `toContain` per key would pass a role that had quietly
      // gained every write in the tier, and filtering by prefix first would miss
      // a client-tier key — `iam.client.svc.create` above all, which is the one
      // grant that would let this identity mint another one.
      expect([...resolved.permissions].sort()).toEqual([...GRANTED].sort());
    });
  });

  describe('reads everything the platform tier exposes', () => {
    it('lists applications', async () => {
      const page = expectOk(
        await operator.get<Page<ApplicationRow>>('/iam/applications'),
        'list applications',
      );
      expect(page.data.some((application) => application.key === 'iam')).toBe(true);
    });

    it('lists an application’s permissions and navigation', async () => {
      expectOk(
        await operator.get<Page<unknown>>(`/iam/applications/${iamApplicationId}/permissions`),
        'list permissions',
      );
      expectOk(
        await operator.get<unknown>(`/iam/applications/${iamApplicationId}/nav`),
        'list navigation',
      );
    });

    it('lists tenants and their enabled applications', async () => {
      // An explicit limit, not the default page: the battery leaves a tenant per
      // suite behind between runs, so "is it on page one" is a question about
      // how many other files have run, not about what this role can read.
      const page = expectOk(
        await operator.get<Page<{ id: string; slug: string }>>('/iam/clients?limit=100'),
        'list clients',
      );
      expect(page.data.some((client) => client.slug === tenant.slug)).toBe(true);

      expectOk(
        await operator.get<Page<unknown>>(`/iam/clients/${tenant.clientId}/applications`),
        'list enabled applications',
      );
    });

    it('reads the audit trail across tenants — which on one tenant is theirs', async () => {
      const page = expectOk(
        await operator.get<Page<AuditRow>>('/iam/audit?limit=5'),
        'read audit',
      );
      expect(page.total).toBeGreaterThan(0);
    });
  });

  describe('writes nothing', () => {
    /**
     * Every write on the platform tier, with the permission it needs.
     *
     * Bodies are deliberately *valid* — a 400 from a malformed payload would
     * look like a pass and prove nothing about authorization. The guard runs
     * before the handler, so a correctly refused call never reaches the code
     * that would have acted on these.
     */
    const writes = (): { name: string; call: () => Promise<ApiResponse<unknown>> }[] => [
      {
        name: 'POST /iam/applications (app.create)',
        call: () =>
          operator.post('/iam/applications', {
            key: 'e2e-onprem-forbidden',
            name: 'Should not exist',
          }),
      },
      {
        name: 'PATCH /iam/applications/:id (app.update)',
        call: () => operator.patch(`/iam/applications/${opsApplicationId}`, { name: 'Renamed' }),
      },
      {
        name: 'POST /iam/applications/:id/manifest (app.manifest)',
        call: () =>
          operator.post(`/iam/applications/${opsApplicationId}/manifest`, {
            key: 'e2e-ops',
            name: 'E2E Ops',
            permissions: [],
            nav: [],
          }),
      },
      {
        name: 'POST /iam/applications/:id/permissions (permission.create)',
        call: () =>
          operator.post(`/iam/applications/${opsApplicationId}/permissions`, {
            permissions: [{ key: 'e2e-ops.forbidden.write', name: 'Should not exist' }],
          }),
      },
      {
        name: 'POST /iam/applications/:id/nav (nav.create)',
        call: () =>
          operator.post(`/iam/applications/${opsApplicationId}/nav`, {
            nodes: [{ kind: 'module', key: 'forbidden', label: 'Should not exist' }],
          }),
      },
      {
        name: 'POST /iam/applications/:id/nav-permissions (nav.map)',
        call: () =>
          operator.post(`/iam/applications/${opsApplicationId}/nav-permissions`, {
            mappings: [{ nav_key: 'forbidden', permission_keys: [PERM.CREATE] }],
          }),
      },
      {
        name: 'DELETE /iam/applications/:id/nav-permissions (nav.map)',
        call: () =>
          operator.del(`/iam/applications/${opsApplicationId}/nav-permissions`, {
            mappings: [{ nav_key: 'forbidden', permission_keys: [PERM.CREATE] }],
          }),
      },
      {
        name: 'POST /iam/clients (client.create)',
        call: () =>
          operator.post('/iam/clients', {
            name: 'Should not exist',
            slug: 'e2e-onprem-forbidden',
          }),
      },
      {
        name: 'PATCH /iam/clients/:id (client.update)',
        call: () => operator.patch(`/iam/clients/${tenant.clientId}`, { name: 'Renamed' }),
      },
      {
        name: 'POST /iam/clients/:id/applications (client.app.enable)',
        call: () =>
          operator.post(`/iam/clients/${tenant.clientId}/applications`, {
            applications: [{ application_id: opsApplicationId }],
          }),
      },
      {
        name: 'PATCH /iam/clients/:id/applications/:appId (client.app.update)',
        call: () =>
          operator.patch(
            `/iam/clients/${tenant.clientId}/applications/${opsApplicationId}`,
            { enabled: false },
          ),
      },
      {
        name: 'POST /iam/service-accounts (client.svc.create)',
        // Not a platform-tier key, and included anyway: this is the one call
        // that would turn read-only visibility into a second machine identity.
        // The platform role does hold it (migration 0017); this one must not.
        call: () => operator.post('/iam/service-accounts', { name: 'Should not exist' }),
      },
      {
        name: 'POST /iam/clients/:id/admins (client.admin.create)',
        call: () =>
          operator.post(`/iam/clients/${tenant.clientId}/admins`, {
            email: 'forbidden@example.com',
            full_name: 'Should not exist',
            password: 'Forbidden-Password-1',
          }),
      },
    ];

    it.each(writes().map((write) => [write.name, write.call] as const))(
      'refuses %s with PERMISSION_DENIED',
      async (_name, call) => {
        const response = await call();
        expect(response.status).toBe(403);
        expect((response.data as { error: { code: string } }).error.code).toBe(
          IamErrorCode.PERMISSION_DENIED,
        );
      },
    );

    it('left the catalog and the tenant exactly as they were', async () => {
      // The control for the block above. Every refusal could be a 403 produced
      // *after* a write, and nothing in a status code would say so.
      const admin = await platform();

      const applications = expectOk(
        await admin.get<Page<ApplicationRow>>('/iam/applications?limit=100'),
        'list applications as platform',
      );
      expect(
        applications.data.some((application) => application.key === 'e2e-onprem-forbidden'),
      ).toBe(false);

      const clients = expectOk(
        await admin.get<Page<{ slug: string }>>('/iam/clients?limit=100'),
        'list clients as platform',
      );
      expect(clients.data.some((client) => client.slug === 'e2e-onprem-forbidden')).toBe(
        false,
      );
    });
  });
});

describe('break-glass recovery', () => {
  let tenant: FixtureTenant;

  beforeAll(async () => {
    tenant = (await seedTwoTenants(BREAK_GLASS_PREFIX)).alpha;
  });

  afterAll(async () => {
    await purgeTenants(BREAK_GLASS_PREFIX);
  });

  it('creates an administrator who can log in, and audits it distinctly', async () => {
    const email = 'break-glass-created@example.com';
    const { password } = await breakGlass([
      '--client',
      tenant.slug,
      '--email',
      email,
      '--name',
      'Break Glass Created',
      '--reason',
      'e2e: no administrator reachable',
    ]);

    const session = expectOk(
      await as(undefined).post<{ access_token: string }>('/auth/login', {
        email,
        password,
        client_slug: tenant.slug,
      }),
      'log in as the created administrator',
    );

    // Not just "a token came back": the recovered account must actually be an
    // administrator, which is the binding the tool created.
    expectOk(
      await as(session.access_token).get<Page<unknown>>('/iam/users'),
      'the recovered administrator can administer',
    );
  });

  it('recovers a locked-out administrator whose password nobody knows', async () => {
    const email = 'break-glass-locked@example.com';
    const first = await breakGlass(['--client', tenant.slug, '--email', email]);

    // Locked through the ordinary API by a *different* administrator, because a
    // caller cannot change their own status — which is exactly the situation
    // that leaves an install with nobody able to get in.
    const admin = await callerFor(tenant, tenant.admin);
    const users = expectOk(
      await admin.get<Page<{ id: string; email: string }>>('/iam/users?limit=100'),
      'find the account to lock',
    );
    const target = users.data.find((user) => user.email === email);
    expect(target).toBeDefined();

    expectOk(
      await admin.patch(`/iam/users/${target?.id}`, { status: 'locked' }),
      'lock the account',
    );

    const refused = await as(undefined).post('/auth/login', {
      email,
      password: first.password,
      client_slug: tenant.slug,
    });
    expect(refused.status).toBe(423);

    const recovered = await breakGlass([
      '--client',
      tenant.slug,
      '--email',
      email,
      '--reason',
      'e2e: locked out',
    ]);
    expect(recovered.stdout).toContain('Recovered');
    // A new password every time — the old one is not restored, it is replaced.
    expect(recovered.password).not.toBe(first.password);

    expectOk(
      await as(undefined).post<{ access_token: string }>('/auth/login', {
        email,
        password: recovered.password,
        client_slug: tenant.slug,
      }),
      'log in after recovery',
    );
  });

  it('recovers an administrator whose grant expired rather than vanished', async () => {
    const email = 'break-glass-expired@example.com';
    await breakGlass(['--client', tenant.slug, '--email', email]);

    // Aged with SQL, which this battery otherwise avoids — see the fixture's
    // header. The reason it is right here: `role_binding_subject_role_scope_key`
    // is unique on (subject, role, scope) and ignores `expires_at`, so an
    // *expired* grant still occupies the row. A recovery that inserted a fresh
    // binding would hit that index and abort, and there is no way to reach the
    // state through the API — `expires_at` in the past cannot be created.
    const owner = await connectOwner();
    try {
      await elevateOwner(owner, tenant.clientId);
      const aged = await rows<{ id: string }>(
        owner,
        `update ${S}."role_binding" rb
            set expires_at = now() - interval '1 day'
           from ${S}."user" u
          where u.id = rb.user_id and u.client_id = $1 and u.email = $2
        returning rb.id`,
        [tenant.clientId, email],
      );
      expect(aged.length).toBeGreaterThan(0);
    } finally {
      await owner.end();
    }

    const recovered = await breakGlass(['--client', tenant.slug, '--email', email]);
    expect(recovered.stdout).toContain('expiry was removed');

    const session = expectOk(
      await as(undefined).post<{ access_token: string }>('/auth/login', {
        email,
        password: recovered.password,
        client_slug: tenant.slug,
      }),
      'log in after the expired grant was restored',
    );

    // The grant is what was broken, so the assertion has to be an authorized
    // call and not merely a token.
    expectOk(
      await as(session.access_token).get<Page<unknown>>('/iam/users'),
      'administer after the expiry was cleared',
    );
  });

  it('leaves a record the audit API can be filtered on', async () => {
    const admin = await platform();
    const page = expectOk(
      await admin.get<Page<AuditRow>>('/iam/audit?action=platform.break_glass&limit=50'),
      'read the break-glass records',
    );

    expect(page.data.length).toBeGreaterThan(0);
    for (const record of page.data) {
      expect(record.action).toBe('platform.break_glass');
      expect(record.target_type).toBe('user');
      // Doc 10 §8: the payload names what happened and never the credential.
      expect(JSON.stringify(record.payload)).not.toContain('password":"');
      expect(record.payload['performed_via']).toBe('tools/break-glass-admin.ts');
    }

    expect(
      page.data.some((record) => record.payload['outcome'] === 'recovered'),
    ).toBe(true);
    // The three binding outcomes are distinguishable in the record, which is
    // what lets somebody reading the trail tell "had no grant" from "the grant
    // had expired" from "the grant was fine, the password was not".
    expect(
      page.data.some((record) => record.payload['role_binding'] === 'expiry_cleared'),
    ).toBe(true);
  });

  it('refuses a credential that is not the stored one', async () => {
    // A *wrong* secret rather than an absent one, and the difference is worth
    // stating: the tool calls `dotenv` and a real install keeps the value in
    // `.env`, so "unset it in the child's environment" would prove nothing —
    // the file would supply it again. What the check actually defends is an
    // operator holding a stale value after the runbook's rotation, and this is
    // that case. An environment variable wins over `.env`, which dotenv never
    // overrides.
    await expect(
      runBreakGlass(
        ['--client', tenant.slug, '--email', 'never-created@example.com'],
        { PLATFORM_BOOTSTRAP_SECRET: 'not-the-secret-this-database-was-seeded-with' },
      ),
    ).rejects.toThrow(/does not match the stored platform credential/);

    // And it created nothing on the way to refusing.
    const admin = await callerFor(tenant, tenant.admin);
    const users = expectOk(
      await admin.get<Page<{ email: string }>>('/iam/users?limit=100'),
      'list users after the refusal',
    );
    expect(users.data.some((user) => user.email === 'never-created@example.com')).toBe(
      false,
    );
  });
});
