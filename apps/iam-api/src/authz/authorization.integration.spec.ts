/**
 * The Session 23 Definition of Done: **the authorization matrix — platform
 * admin / client admin / plain user / service account × endpoint classes —
 * over HTTP, against a real Postgres** (Doc 04 §8–10, Doc 06 §2, Doc 10 §3).
 *
 * Every other suite in this application seeds an authorized caller and then
 * asks whether the *feature* works. This one seeds callers who are and are not
 * authorized, and asks only whether they get through — which is the one question
 * the others deliberately stop asking, and the one whose wrong answer is
 * invisible: a route that admits somebody it should not is a route that works.
 *
 *   pg_ctl start                # a local Postgres 17 (see .env)
 *   npm run migration:run
 *   npx nx test @plantops/iam-api
 *
 * **Destructive within its own fixtures only.** Every client it creates is
 * slugged `s23-…`; all of them are removed afterwards with everything hanging
 * off them. The platform tenant and the `iam` catalog are migration 0011's and
 * 0017's and are read, never written.
 *
 * ## The four subjects
 *
 * | | who | holds |
 * |---|---|---|
 * | platform | the bootstrap service account of migration 0011 | `iam.platform.*` at the platform root |
 * | admin | a tenant's administrator | `iam.client.*` at their tenant root |
 * | plant admin | a tenant administrator bound at **Plant A only** | `iam.client.*` beneath one plant |
 * | member | an ordinary user | nothing |
 * | machine | a service account | nothing |
 *
 * The plant admin is what makes the WHERE dimension testable at the routing
 * layer: they hold every client permission there is, and still cannot touch a
 * node outside their subtree. `SCOPE_DENIED` and `PERMISSION_DENIED` are
 * different answers to different questions, and a suite that only had "all" and
 * "nothing" subjects could not tell them apart.
 *
 * ## Deliberate deviations from the shipped configuration
 *
 * - **Rate limiting is off.** These cases make dozens of calls.
 * - **Nothing else.** The guard, the resolver, the RLS context, the error
 *   envelope and the denial auditor are the shipped ones — the point of the
 *   suite is that they are.
 */

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { loadEnv } from '@plantops/config';
import {
  IamErrorCode,
  type AccessTokenResponse,
  type IamErrorResponse,
  type TokenPairResponse,
} from '@plantops/contracts';
import {
  IAM_SCHEMA,
  IAM_SCHEMA_TEST_LOCK_ID,
  PLATFORM_CLIENT_SLUG,
  PLATFORM_SERVICE_ACCOUNT_KEY,
  createMigrationDataSource,
  hashSecret,
  scopePathLabel,
} from '@plantops/db';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { DataSource } from 'typeorm';
import { AUDIT_ACTIONS } from '../audit/audit-actions';
import { AppModule } from '../app/app.module';
import { ENV } from '../config/config.module';
import { createTestApplication } from '../testing/app-harness';
import { grantIamClientAdmin } from '../testing/authorization.fixture';

const S = `"${IAM_SCHEMA}"`;

const PLACEHOLDER = /REPLACE_ME|[[\]<>]/;
const usable = (url: string | undefined) =>
  url !== undefined &&
  /^postgres(ql)?:\/\/\S+@\S+/.test(url.trim()) &&
  !PLACEHOLDER.test(url);

const configured =
  usable(process.env['DATABASE_URL']) && usable(process.env['DATABASE_DIRECT_URL']);

const describeWithDb = configured ? describe : describe.skip;

const PASSWORD = 'correct-horse-battery-staple';

/** Everything this suite creates carries this prefix. */
const PREFIX = 's23-';

interface Node {
  id: string;
  path: string;
}

interface Tenant {
  clientId: string;
  slug: string;
  /** Bound at the root: every client permission, everywhere in the tenant. */
  adminEmail: string;
  adminUserId: string;
  /** Bound at Plant A: every client permission, only beneath that plant. */
  plantAdminEmail: string;
  plantAdminUserId: string;
  /** No bindings at all — Doc 04 §9's deny-by-default subject. */
  memberEmail: string;
  memberUserId: string;
  /** A machine identity with no bindings either. */
  serviceAccountId: string;
  serviceAccountKey: string;
  serviceAccountSecret: string;
  root: Node;
  plantA: Node;
  plantB: Node;
}

describeWithDb(
  `authorization matrix (${configured ? 'live' : 'skipped: no DATABASE_URL'})`,
  () => {
    let app: INestApplication;
    let baseUrl: string;
    let admin: DataSource;
    let acme: Tenant;
    let platformSecret: string;

    jest.setTimeout(180_000);

    beforeAll(async () => {
      const env = loadEnv();
      platformSecret = env.PLATFORM_BOOTSTRAP_SECRET;

      admin = createMigrationDataSource(env);
      await admin.initialize();
      await admin.query('select pg_advisory_lock($1)', [IAM_SCHEMA_TEST_LOCK_ID]);
      await purge(admin);

      acme = await seedTenant(admin, await hashSecret(PASSWORD));

      const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(ENV)
        .useValue({ ...env, RATE_LIMIT_ENABLED: false })
        .compile();

      app = createTestApplication(moduleRef);
      await app.init();
      await app.listen(0);
      baseUrl = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
    });

    afterAll(async () => {
      await app?.close();
      if (admin?.isInitialized) {
        await purge(admin);
        await admin.query('select pg_advisory_unlock($1)', [IAM_SCHEMA_TEST_LOCK_ID]);
        await admin.destroy();
      }
    });

    beforeEach(async () => {
      await elevate(admin, acme.clientId);
      await admin.query(`delete from ${S}."audit_trail" where client_id = $1`, [
        acme.clientId,
      ]);
    });

    // ── the wire ──────────────────────────────────────────────────────────

    const call = (
      token: string,
      method: string,
      path: string,
      body?: unknown,
    ): Promise<Response> =>
      fetch(`${baseUrl}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });

    const codeOf = async (response: Response): Promise<string> =>
      ((await response.json()) as IamErrorResponse).error.code;

    const login = async (email: string): Promise<string> => {
      const response = await fetch(`${baseUrl}/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, password: PASSWORD, client_slug: acme.slug }),
      });
      expect(response.status).toBe(200);
      return ((await response.json()) as TokenPairResponse).access_token;
    };

    const exchange = async (key: string, secret: string): Promise<string> => {
      const response = await fetch(`${baseUrl}/auth/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ account_key: key, account_secret: secret }),
      });
      expect(response.status).toBe(200);
      return ((await response.json()) as AccessTokenResponse).access_token;
    };

    const asPlatform = () => exchange(PLATFORM_SERVICE_ACCOUNT_KEY, platformSecret);
    const asAdmin = () => login(acme.adminEmail);
    const asPlantAdmin = () => login(acme.plantAdminEmail);
    const asMember = () => login(acme.memberEmail);
    const asMachine = () => exchange(acme.serviceAccountKey, acme.serviceAccountSecret);

    const denialsFor = async (action: string): Promise<Record<string, unknown>[]> => {
      await elevate(admin, acme.clientId);
      const rows = (await admin.query(
        `select payload from ${S}."audit_trail"
          where client_id = $1 and action = $2 order by created_at asc, id asc`,
        [acme.clientId, action],
      )) as { payload: Record<string, unknown> }[];
      return rows.map((row) => row.payload);
    };

    // ── the two tiers refuse each other (Doc 02 §1, Doc 04 §10) ───────────

    describe('the tier boundary', () => {
      it('lets the platform account drive the catalog and tenant surfaces', async () => {
        const token = await asPlatform();

        for (const path of ['/iam/applications', '/iam/clients']) {
          expect((await call(token, 'GET', path)).status).toBe(200);
        }
      });

      it('refuses a client admin on a platform endpoint, with PERMISSION_DENIED', async () => {
        const token = await asAdmin();

        for (const path of ['/iam/applications', '/iam/clients']) {
          const response = await call(token, 'GET', path);
          expect(response.status).toBe(403);
          expect(await codeOf(response)).toBe(IamErrorCode.PERMISSION_DENIED);
        }
      });

      // The other direction, and the one that is easy to get wrong by accident:
      // a platform admin is not a tenant admin. Their `cid` is the platform
      // client, so `iam.client.*` at somebody else's root is not theirs to hold.
      it('refuses the platform account on a tenant-administration endpoint', async () => {
        const token = await asPlatform();

        const response = await call(token, 'GET', '/iam/roles');
        expect(response.status).toBe(403);
        expect(await codeOf(response)).toBe(IamErrorCode.PERMISSION_DENIED);
      });
    });

    // ── deny-by-default (Doc 04 §9) ───────────────────────────────────────

    describe('no binding, no access', () => {
      const CLIENT_READS = [
        '/iam/scopes',
        '/iam/roles',
        '/iam/users',
        '/iam/role-bindings',
        '/iam/service-accounts',
      ] as const;

      it.each(CLIENT_READS)('refuses an ordinary user on %s', async (path) => {
        const response = await call(await asMember(), 'GET', path);
        expect(response.status).toBe(403);
        expect(await codeOf(response)).toBe(IamErrorCode.PERMISSION_DENIED);
      });

      it.each(CLIENT_READS)('refuses an unbound service account on %s', async (path) => {
        const response = await call(await asMachine(), 'GET', path);
        expect(response.status).toBe(403);
        expect(await codeOf(response)).toBe(IamErrorCode.PERMISSION_DENIED);
      });

      it('admits the same user the moment a binding gives them the permission', async () => {
        // The whole of Doc 04 §9 in one case: nothing about the *route* changed
        // between these two calls, only a row.
        const before = await call(await asMember(), 'GET', '/iam/roles');
        expect(before.status).toBe(403);

        await grantIamClientAdmin(admin, acme.clientId, acme.root.id, {
          userId: acme.memberUserId,
        });
        try {
          const after = await call(await asMember(), 'GET', '/iam/roles');
          expect(after.status).toBe(200);
        } finally {
          await elevate(admin, acme.clientId);
          await admin.query(
            `delete from ${S}."role_binding" where client_id = $1 and user_id = $2`,
            [acme.clientId, acme.memberUserId],
          );
        }
      });
    });

    // ── the WHERE dimension, at the routing layer (Doc 04 §3, §8) ─────────

    describe('scope coverage', () => {
      it('lets a plant-bound admin act inside their own subtree', async () => {
        const token = await asPlantAdmin();

        const response = await call(token, 'POST', '/iam/scopes', {
          parent_id: acme.plantA.id,
          kind: 'gate',
          name: `Gate ${randomUUID().slice(0, 4)}`,
        });

        expect(response.status).toBe(201);
      });

      it('refuses the same admin at a sibling plant, with SCOPE_DENIED', async () => {
        const token = await asPlantAdmin();

        const response = await call(token, 'POST', '/iam/scopes', {
          parent_id: acme.plantB.id,
          kind: 'gate',
          name: 'Smuggled',
        });

        // Not PERMISSION_DENIED: they hold `iam.client.scope.create`. The answer
        // is "not here", which is the only thing an operator can act on.
        expect(response.status).toBe(403);
        expect(await codeOf(response)).toBe(IamErrorCode.SCOPE_DENIED);
      });

      it('refuses them at the root above their own binding', async () => {
        // Coverage inherits downwards only (Doc 04 §3): an ancestor is not
        // within its descendant, so a plant grant does not reach the group.
        const response = await call(
          await asPlantAdmin(),
          'DELETE',
          `/iam/scopes/${acme.plantB.id}`,
        );

        expect(response.status).toBe(403);
        expect(await codeOf(response)).toBe(IamErrorCode.SCOPE_DENIED);
      });

      // The most consequential scoped route: an admin may only *grant* where
      // they themselves hold. Otherwise a plant coordinator could bind anybody
      // anywhere, which would make the WHERE dimension advisory.
      it('refuses a binding at a node the granter does not cover', async () => {
        const token = await asPlantAdmin();
        const roles = await call(token, 'GET', '/iam/roles');
        expect(roles.status).toBe(200);
        const [role] = ((await roles.json()) as { data: { id: string }[] }).data;

        const response = await call(token, 'POST', '/iam/role-bindings', {
          user_id: acme.memberUserId,
          role_id: role?.id,
          scope_node_id: acme.plantB.id,
        });

        expect(response.status).toBe(403);
        expect(await codeOf(response)).toBe(IamErrorCode.SCOPE_DENIED);
      });

      it('lets the root-bound admin do both, because the root covers both', async () => {
        const token = await asAdmin();

        for (const parentId of [acme.plantA.id, acme.plantB.id]) {
          const response = await call(token, 'POST', '/iam/scopes', {
            parent_id: parentId,
            kind: 'gate',
            name: `Gate ${randomUUID().slice(0, 4)}`,
          });
          expect(response.status).toBe(201);
        }
      });
    });

    // ── 403s reveal nothing across tenants (Doc 06 §2) ────────────────────

    describe('a denial is not an existence oracle', () => {
      it('answers a node from another tenant exactly as it answers a nonexistent one', async () => {
        const token = await asAdmin();
        const outsider = await seedTenant(admin, await hashSecret(PASSWORD));

        const foreign = await call(token, 'DELETE', `/iam/scopes/${outsider.plantA.id}`);
        const missing = await call(token, 'DELETE', `/iam/scopes/${randomUUID()}`);

        const bodyOf = async (response: Response) => {
          const { code, message } = ((await response.json()) as IamErrorResponse).error;
          return { status: response.status, code, message };
        };

        // Invisible under RLS, so the guard has no path to compare and the
        // handler finds nothing: the same 404 either way, and no way to tell
        // from the outside that the first id names a real node somewhere.
        expect(foreign.status).toBe(404);
        expect(await bodyOf(foreign)).toEqual(await bodyOf(missing));
      });

      it('says nothing about the permission it wanted', async () => {
        const response = await call(await asMember(), 'GET', '/iam/roles');
        const { message } = ((await response.json()) as IamErrorResponse).error;

        // The wanted key is in the audit row, never in the response — knowing
        // which permission a route needs is a map of the system for anybody
        // probing it.
        expect(message).not.toContain('iam.client');
      });
    });

    // ── every denial is audited (Doc 04 §8 step 5, Doc 10 §3) ─────────────

    describe('denial auditing', () => {
      it('records a permission denial with the key that was attempted', async () => {
        await call(await asMember(), 'GET', '/iam/roles');

        const [record] = await denialsFor(AUDIT_ACTIONS.PERMISSION_DENIED);
        expect(record).toMatchObject({ permission: 'iam.client.role.read' });
      });

      it('records a scope denial with the node that was named', async () => {
        await call(await asPlantAdmin(), 'DELETE', `/iam/scopes/${acme.plantB.id}`);

        const [record] = await denialsFor(AUDIT_ACTIONS.SCOPE_DENIED);
        expect(record).toMatchObject({
          permission: 'iam.client.scope.delete',
          scope_node_id: acme.plantB.id,
        });
      });

      // The row commits on its own connection, because the request that caused
      // it is rolled back by its own 403 (Doc 10 §3). If it shared the request's
      // transaction there would be nothing here at all.
      it('survives the rollback the refusal itself causes', async () => {
        await call(await asMember(), 'POST', '/iam/roles', { name: 'Nope' });

        expect(await denialsFor(AUDIT_ACTIONS.PERMISSION_DENIED)).toHaveLength(1);
        // And the request it refused wrote nothing.
        await elevate(admin, acme.clientId);
        const [row] = (await admin.query(
          `select count(*)::int as total from ${S}."role"
            where client_id = $1 and name = 'Nope'`,
          [acme.clientId],
        )) as { total: number }[];
        expect(row?.total).toBe(0);
      });

      it('audits nothing when the request is allowed', async () => {
        expect((await call(await asAdmin(), 'GET', '/iam/roles')).status).toBe(200);

        expect(await denialsFor(AUDIT_ACTIONS.PERMISSION_DENIED)).toEqual([]);
        expect(await denialsFor(AUDIT_ACTIONS.SCOPE_DENIED)).toEqual([]);
      });
    });

    // ── what is deliberately not gated ────────────────────────────────────

    describe('the routes that answer questions about the bearer', () => {
      it.each([
        ['/iam/whoami'],
        ['/iam/permissions/resolve'],
        ['/auth/sessions'],
      ])('admits a subject with no grants at all on %s', async (path) => {
        const response = await call(await asMember(), 'GET', path);
        expect(response.status).toBe(200);
      });

      it('lets that subject discover that they hold nothing', async () => {
        const response = await call(await asMember(), 'GET', '/iam/permissions/resolve');

        // The recursion `authz.controller.ts` refuses to build: a permission
        // gate on "what may I do" would need a permission to find out.
        expect(await response.json()).toEqual({ permissions: [], scopes: {} });
      });
    });
  },
);

// ── fixtures ────────────────────────────────────────────────────────────────

async function elevate(admin: DataSource, clientId: string): Promise<void> {
  await admin.query(`select set_config('app.is_platform_admin', 'true', false)`);
  await admin.query(`select set_config('app.current_client_id', $1, false)`, [clientId]);
}

/**
 * One tenant, four subjects and a three-level tree.
 *
 * The two administrators differ only in **where** they are bound, which is what
 * makes the difference between `PERMISSION_DENIED` and `SCOPE_DENIED` a property
 * of one row rather than of two fixtures.
 */
async function seedTenant(admin: DataSource, secretHash: string): Promise<Tenant> {
  const suffix = randomUUID().slice(0, 8);
  const node = (): Node => ({ id: randomUUID(), path: '' });

  const root = node();
  const plantA = node();
  const plantB = node();
  root.path = scopePathLabel(root.id);
  plantA.path = `${root.path}.${scopePathLabel(plantA.id)}`;
  plantB.path = `${root.path}.${scopePathLabel(plantB.id)}`;

  const tenant: Tenant = {
    clientId: randomUUID(),
    slug: `${PREFIX}${suffix}`,
    adminEmail: `admin-${suffix}@example.test`,
    adminUserId: randomUUID(),
    plantAdminEmail: `plant-${suffix}@example.test`,
    plantAdminUserId: randomUUID(),
    memberEmail: `member-${suffix}@example.test`,
    memberUserId: randomUUID(),
    serviceAccountId: randomUUID(),
    serviceAccountKey: `${PREFIX}machine-${suffix}`,
    serviceAccountSecret: `secret-${randomUUID()}`,
    root,
    plantA,
    plantB,
  };

  await elevate(admin, tenant.clientId);
  await admin.query(
    `insert into ${S}."client" (id, name, slug, status) values ($1, $2, $3, 'active')`,
    [tenant.clientId, `Session 23 ${suffix}`, tenant.slug],
  );

  for (const [id, email, isAdmin] of [
    [tenant.adminUserId, tenant.adminEmail, true],
    [tenant.plantAdminUserId, tenant.plantAdminEmail, true],
    [tenant.memberUserId, tenant.memberEmail, false],
  ] as const) {
    await admin.query(
      `insert into ${S}."user" (id, client_id, email, full_name, status, is_client_admin)
       values ($1, $2, $3, 'Session 23 Fixture', 'active', $4)`,
      [id, tenant.clientId, email, isAdmin],
    );
    await admin.query(
      `insert into ${S}."user_identity" (client_id, user_id, provider, secret_hash)
       values ($1, $2, 'password', $3)`,
      [tenant.clientId, id, secretHash],
    );
  }

  await admin.query(
    `insert into ${S}."service_account" (id, client_id, name, key, key_hash, status)
     values ($1, $2, 'Session 23 Machine', $3, $4, 'active')`,
    [
      tenant.serviceAccountId,
      tenant.clientId,
      tenant.serviceAccountKey,
      await hashSecret(tenant.serviceAccountSecret),
    ],
  );

  for (const [current, parentId, kind, name] of [
    [root, null, 'group', `Session 23 ${suffix}`],
    [plantA, root.id, 'plant', 'Plant A'],
    [plantB, root.id, 'plant', 'Plant B'],
  ] as const) {
    await admin.query(
      `insert into ${S}."scope_node" (id, client_id, parent_id, kind, name, path)
       values ($1, $2, $3, $4, $5, $6::ltree)`,
      [current.id, tenant.clientId, parentId, kind, name, current.path],
    );
  }

  // Same permissions, two different places. The member and the machine get
  // nothing, which is the deny-by-default arm of the matrix.
  await grantIamClientAdmin(admin, tenant.clientId, root.id, {
    userId: tenant.adminUserId,
  });
  await grantIamClientAdmin(admin, tenant.clientId, plantA.id, {
    userId: tenant.plantAdminUserId,
  });

  return tenant;
}

/** Every `s23-` tenant and everything hanging off it. */
async function purge(admin: DataSource): Promise<void> {
  await admin.query(`select set_config('app.is_platform_admin', 'true', false)`);
  const clients = (await admin.query(
    `select id from ${S}."client" where slug like $1 and slug <> $2`,
    [`${PREFIX}%`, PLATFORM_CLIENT_SLUG],
  )) as { id: string }[];

  for (const { id } of clients) {
    await elevate(admin, id);
    for (const statement of [
      `delete from ${S}."role_binding" where client_id = $1`,
      `delete from ${S}."session" where client_id = $1`,
      `delete from ${S}."user_identity" where client_id = $1`,
      `delete from ${S}."user" where client_id = $1`,
      `delete from ${S}."service_account" where client_id = $1`,
      `delete from ${S}."role" where client_id = $1`,
      `delete from ${S}."client_application" where client_id = $1`,
      `delete from ${S}."audit_trail" where client_id = $1`,
    ]) {
      await admin.query(statement, [id]);
    }
    // Leaves first: `scope_node.parent_id` is `on delete restrict`.
    for (let depth = 8; depth >= 1; depth -= 1) {
      await admin.query(
        `delete from ${S}."scope_node" where client_id = $1 and nlevel(path) = $2`,
        [id, depth],
      );
    }
    await admin.query(`delete from ${S}."client" where id = $1`, [id]);
  }
}
