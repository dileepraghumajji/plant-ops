/**
 * The Session 15 Definition of Done: **the platform onboards a tenant over HTTP,
 * and that tenant's admin logs in** (Doc 02 §3, Doc 06 §5).
 *
 * Almost every claim this session makes is a claim about the database, which is
 * why it runs against a real Postgres. That a platform admin can write a row
 * into a tenant it does not belong to — through the provisioning context and
 * *only* through it — that four rows appear together or not at all, that an
 * ltree label is id-derived even when the display name is hostile, that
 * disabling an application leaves its role mappings intact, and that a suspended
 * client's users are refused at login: none of those can fail against a fake.
 *
 *   pg_ctl start                # a local Postgres 17 (see .env)
 *   npm run migration:run
 *   npx nx test @plantops/iam-api
 *
 * **Destructive within its own fixtures only.** Every client it creates is
 * slugged `s15-…` and every application keyed `s15-…`; both are removed
 * afterwards, with the rows that hang off them. It deletes only the audit rows
 * belonging to those tenants, plus the catalog-action rows it wrote itself since
 * the suite started — in particular not `platform.bootstrap`, which happened once
 * and is not this suite's to unmake (Doc 10 §1).
 *
 * ## The caller is the bootstrap account
 *
 * Session 15's interim authorization is "a platform subject", and the identity
 * migration 0011 seeds is the one that exists. So the suite authenticates the
 * way an operator would on day one: exchange the bootstrap credentials at
 * `POST /auth/token`, then call `/iam/clients` with the token. Nothing is
 * asserted into the RLS context by the test — the platform flag is derived from
 * the account's binding at the platform scope root, exactly as in production.
 *
 * ## Deliberate deviations from the shipped configuration
 *
 * - **Rate limiting is off.** These cases make dozens of calls and the throttle
 *   would be measuring the suite rather than the code.
 * - **Nothing else.** The interim permission rule, the validation pipe, the
 *   provisioning context and the audit path are the shipped ones; each is
 *   something the suite asserts.
 */

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { loadEnv } from '@plantops/config';
import {
  IamErrorCode,
  SCOPE_PATH_LABEL_PREFIX,
  type AccessTokenResponse,
  type ApplicationDTO,
  type ClientAdminDTO,
  type ClientApplicationDTO,
  type ClientDTO,
  type IamErrorResponse,
  type Paginated,
  type TokenPairResponse,
} from '@plantops/contracts';
import {
  IAM_SCHEMA,
  IAM_SCHEMA_TEST_LOCK_ID,
  PLATFORM_CLIENT_SLUG,
  PLATFORM_SERVICE_ACCOUNT_KEY,
  createMigrationDataSource,
  hashSecret,
} from '@plantops/db';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { DataSource } from 'typeorm';
import { AppModule } from '../app/app.module';
import { AUDIT_ACTIONS } from '../audit/audit-actions';
import { ENV } from '../config/config.module';
import { CLIENT_ADMIN_ROLE_NAME } from './client-admin.service';

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

/** Everything this suite creates carries one of these prefixes. */
const SLUG_PREFIX = 's15-';
const APP_KEY_PREFIX = 's15-';

/** Catalog actions the suite writes into the *platform* tenant, for cleanup. */
const CATALOG_ACTIONS = [
  AUDIT_ACTIONS.APPLICATION_CREATED,
  AUDIT_ACTIONS.APPLICATION_UPDATED,
  AUDIT_ACTIONS.APPLICATION_DEACTIVATED,
  AUDIT_ACTIONS.PERMISSION_CREATED,
] as const;

interface Fixture {
  /** The platform tenant, which owns the bootstrap identity. */
  platformClientId: string;
  /** An ordinary tenant whose client admin must be refused by every route here. */
  outsiderClientId: string;
  outsiderSlug: string;
  outsiderEmail: string;
}

describeWithDb(
  `client provisioning APIs (${configured ? 'live' : 'skipped: no DATABASE_URL'})`,
  () => {
    let app: INestApplication;
    let baseUrl: string;
    let admin: DataSource;
    let fixture: Fixture;
    let bootstrapSecret: string;
    let startedAt: Date;
    /** Unique per test, so a crashed previous run cannot collide with this one. */
    let suffix: string;

    jest.setTimeout(180_000);

    beforeAll(async () => {
      const env = loadEnv();
      bootstrapSecret = env.PLATFORM_BOOTSTRAP_SECRET;
      startedAt = new Date();

      admin = createMigrationDataSource(env);
      await admin.initialize();
      await admin.query('select pg_advisory_lock($1)', [IAM_SCHEMA_TEST_LOCK_ID]);

      fixture = await seed(admin, await hashSecret(PASSWORD));

      const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(ENV)
        .useValue({ ...env, RATE_LIMIT_ENABLED: false })
        .compile();

      app = moduleRef.createNestApplication();
      await app.init();
      await app.listen(0);
      baseUrl = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
    });

    afterAll(async () => {
      await app?.close();
      if (admin?.isInitialized) {
        await teardown(admin, fixture, startedAt);
        await admin.query('select pg_advisory_unlock($1)', [IAM_SCHEMA_TEST_LOCK_ID]);
        await admin.destroy();
      }
    });

    beforeEach(async () => {
      suffix = randomUUID().slice(0, 8);
      // A clean slate before every case — except the outsider tenant, which is
      // seeded once and is what the authorization cases are refused as.
      await purgeFixtureTenants(admin, fixture.platformClientId, [
        fixture.outsiderClientId,
      ]);
    });

    // ── the wire ──────────────────────────────────────────────────────────

    /** A platform token, from the bootstrap credentials. */
    const asPlatform = async (): Promise<string> => {
      const response = await fetch(`${baseUrl}/auth/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          account_key: PLATFORM_SERVICE_ACCOUNT_KEY,
          account_secret: bootstrapSecret,
        }),
      });
      expect(response.status).toBe(200);
      return ((await response.json()) as AccessTokenResponse).access_token;
    };

    const login = (email: string, clientSlug: string): Promise<Response> =>
      fetch(`${baseUrl}/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, password: PASSWORD, client_slug: clientSlug }),
      });

    /** A perfectly ordinary client admin — authenticated, and not a platform subject. */
    const asOutsider = async (): Promise<string> => {
      const response = await login(fixture.outsiderEmail, fixture.outsiderSlug);
      expect(response.status).toBe(200);
      return ((await response.json()) as TokenPairResponse).access_token;
    };

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

    const createdClient = async (
      token: string,
      overrides: Record<string, unknown> = {},
    ): Promise<ClientDTO> => {
      const response = await call(token, 'POST', '/iam/clients', {
        name: `Acme ${suffix}`,
        slug: `${SLUG_PREFIX}${suffix}`,
        ...overrides,
      });
      expect(response.status).toBe(201);
      return (await response.json()) as ClientDTO;
    };

    /** An application with two permissions, so enablement has something to enable. */
    const createdApplication = async (token: string): Promise<ApplicationDTO> => {
      const created = await call(token, 'POST', '/iam/applications', {
        key: `${APP_KEY_PREFIX}${suffix}`,
        name: 'Gate Pass',
      });
      expect(created.status).toBe(201);
      const application = (await created.json()) as ApplicationDTO;

      const permissions = await call(
        token,
        'POST',
        `/iam/applications/${application.id}/permissions`,
        {
          permissions: [
            { key: `${application.key}.dc.create`, name: 'Create DC' },
            { key: `${application.key}.dc.approve`, name: 'Approve DC' },
          ],
        },
      );
      expect(permissions.status).toBe(201);
      return application;
    };

    const createdAdmin = async (
      token: string,
      clientId: string,
      overrides: Record<string, unknown> = {},
    ): Promise<ClientAdminDTO> => {
      const response = await call(token, 'POST', `/iam/clients/${clientId}/admins`, {
        email: `admin-${suffix}@acme.test`,
        full_name: 'Acme Administrator',
        password: PASSWORD,
        ...overrides,
      });
      expect(response.status).toBe(201);
      return (await response.json()) as ClientAdminDTO;
    };

    const errorCodeOf = async (response: Response): Promise<string> =>
      ((await response.json()) as IamErrorResponse).error.code;

    // ── inspection, through the owner connection ──────────────────────────

    const rowsOf = async <T>(clientId: string, sql: string, parameters: unknown[] = []) => {
      await elevate(admin, clientId);
      return (await admin.query(sql, parameters)) as T[];
    };

    const countIn = async (
      clientId: string,
      table: string,
      where = 'client_id = $1',
    ): Promise<number> => {
      const rows = await rowsOf<{ total: number }>(
        clientId,
        `select count(*)::int as total from ${S}."${table}" where ${where}`,
        [clientId],
      );
      return rows[0]?.total ?? 0;
    };

    const auditActionsFor = async (clientId: string): Promise<string[]> => {
      const rows = await rowsOf<{ action: string }>(
        clientId,
        `select action from ${S}."audit_trail"
          where client_id = $1
          order by created_at asc, id asc`,
        [clientId],
      );
      return rows.map((row) => row.action);
    };

    const auditPayloadsFor = async (
      clientId: string,
      action: string,
    ): Promise<Record<string, unknown>[]> => {
      const rows = await rowsOf<{ payload: Record<string, unknown> }>(
        clientId,
        `select payload from ${S}."audit_trail"
          where client_id = $1 and action = $2
          order by created_at asc, id asc`,
        [clientId, action],
      );
      return rows.map((row) => row.payload);
    };

    // ── the Definition of Done ────────────────────────────────────────────

    describe('a tenant onboarded entirely over HTTP', () => {
      it('walks Doc 02 §3 end to end, and the tenant admin then logs in', async () => {
        const token = await asPlatform();

        // 1. The application catalog the tenant will be given.
        const application = await createdApplication(token);

        // 2. The tenant.
        const client = await createdClient(token, { config: { region: 'south' } });
        expect(client.status).toBe('active');
        expect(client.config).toEqual({ region: 'south' });
        expect(client.enabled_application_count).toBe(0);

        // 3. Its applications.
        const enable = await call(token, 'POST', `/iam/clients/${client.id}/applications`, {
          applications: [{ application_key: application.key }],
        });
        expect(enable.status).toBe(201);
        const enabled = (await enable.json()) as ClientApplicationDTO[];
        expect(enabled).toHaveLength(1);
        expect(enabled[0]).toMatchObject({
          client_id: client.id,
          application_id: application.id,
          application_key: application.key,
          enabled: true,
        });

        // 4. Its first administrator — four rows, one call.
        const created = await createdAdmin(token, client.id);
        expect(created.client_id).toBe(client.id);
        expect(created.role_name).toBe(CLIENT_ADMIN_ROLE_NAME);

        // 5. …who logs in. This is the Definition of Done.
        const session = await login(created.email, client.slug);
        expect(session.status).toBe(200);
        const tokens = (await session.json()) as TokenPairResponse;
        expect(tokens.access_token).toEqual(expect.any(String));

        // …and is a real administrator of their own tenant, not merely a user:
        // `is_client_admin` is the interim shortcut the client-tier surfaces
        // read until Session 23's PermissionGuard (Doc 01 §3.6).
        const ownSurface = await call(tokens.access_token, 'GET', '/iam/service-accounts');
        expect(ownSurface.status).toBe(200);

        // …and is emphatically not a platform admin.
        const platformSurface = await call(tokens.access_token, 'GET', '/iam/clients');
        expect(platformSurface.status).toBe(403);
        expect(await errorCodeOf(platformSurface)).toBe(IamErrorCode.PERMISSION_DENIED);
      });

      it('reports the enabled application count the client list shows', async () => {
        const token = await asPlatform();
        const application = await createdApplication(token);
        const client = await createdClient(token);

        await call(token, 'POST', `/iam/clients/${client.id}/applications`, {
          applications: [{ application_id: application.id }],
        });

        const response = await call(token, 'GET', '/iam/clients?limit=100');
        expect(response.status).toBe(200);
        const page = (await response.json()) as Paginated<ClientDTO>;

        const listed = page.data.find((row) => row.id === client.id);
        expect(listed?.enabled_application_count).toBe(1);

        // The platform tenant is a client row and the list says so — this is the
        // only view of what `client` contains, and the caller is entitled to it.
        expect(page.data.some((row) => row.slug === PLATFORM_CLIENT_SLUG)).toBe(true);
      });
    });

    // ── the initial admin is atomic, and its scope path is id-derived ──────

    describe('POST /iam/clients/:id/admins', () => {
      it('creates the user, root scope node, system role and binding together', async () => {
        const token = await asPlatform();
        const client = await createdClient(token);
        const created = await createdAdmin(token, client.id);

        const [user] = await rowsOf<{
          id: string;
          email: string;
          status: string;
          is_client_admin: boolean;
        }>(
          client.id,
          `select id, email, status, is_client_admin from ${S}."user" where client_id = $1`,
          [client.id],
        );
        expect(user).toMatchObject({
          id: created.user_id,
          status: 'active',
          is_client_admin: true,
        });

        const [scope] = await rowsOf<{
          id: string;
          kind: string;
          parent_id: string | null;
          path: string;
        }>(
          client.id,
          `select id, kind, parent_id, path::text as path from ${S}."scope_node" where client_id = $1`,
          [client.id],
        );
        expect(scope).toMatchObject({ id: created.scope_node_id, kind: 'group', parent_id: null });

        const [role] = await rowsOf<{ id: string; name: string; is_system: boolean }>(
          client.id,
          `select id, name, is_system from ${S}."role" where client_id = $1`,
          [client.id],
        );
        expect(role).toEqual({
          id: created.role_id,
          name: CLIENT_ADMIN_ROLE_NAME,
          is_system: true,
        });

        const [binding] = await rowsOf<{
          id: string;
          user_id: string;
          role_id: string;
          scope_node_id: string;
        }>(
          client.id,
          `select id, user_id, role_id, scope_node_id from ${S}."role_binding" where client_id = $1`,
          [client.id],
        );
        expect(binding).toEqual({
          id: created.role_binding_id,
          user_id: created.user_id,
          role_id: created.role_id,
          // The binding is at the root, so the grant covers the whole tenant by
          // subtree coverage (Doc 01 §4.5).
          scope_node_id: created.scope_node_id,
        });

        // Exactly one password identity, and the response carries no credential.
        expect(await countIn(client.id, 'user_identity')).toBe(1);
        expect(JSON.stringify(created)).not.toContain(PASSWORD);
      });

      it('derives the ltree label from the id, whatever the display name says', async () => {
        const token = await asPlatform();
        const client = await createdClient(token);

        // A name chosen to break a name-derived path: a space, a slash, a
        // hyphen and a dot are all illegal or meaningful in an ltree label.
        const hostile = 'Plant B / Gate-3.North';
        const created = await createdAdmin(token, client.id, { scope_name: hostile });

        expect(created.scope_node_name).toBe(hostile);
        expect(created.scope_node_path).toBe(
          `${SCOPE_PATH_LABEL_PREFIX}${created.scope_node_id.replace(/-/g, '')}`,
        );
        expect(created.scope_node_path).not.toContain('Plant');
        expect(created.scope_node_path).not.toContain('Gate');
      });

      it('names the root after the client when no scope name is given', async () => {
        const token = await asPlatform();
        const client = await createdClient(token);
        const created = await createdAdmin(token, client.id);

        expect(created.scope_node_name).toBe(client.name);
      });

      it('adopts the existing root and role for a second administrator', async () => {
        const token = await asPlatform();
        const client = await createdClient(token);

        const first = await createdAdmin(token, client.id);
        const second = await createdAdmin(token, client.id, {
          email: `second-${suffix}@acme.test`,
          full_name: 'Second Administrator',
        });

        // An organisation with two administrators has one org tree and one
        // administration role, not two of each.
        expect(second.scope_node_id).toBe(first.scope_node_id);
        expect(second.role_id).toBe(first.role_id);
        expect(second.user_id).not.toBe(first.user_id);

        expect(await countIn(client.id, 'scope_node')).toBe(1);
        expect(await countIn(client.id, 'role')).toBe(1);
        expect(await countIn(client.id, 'role_binding')).toBe(2);
      });

      it('leaves nothing behind — no rows and no audit — when the email collides', async () => {
        const token = await asPlatform();
        const client = await createdClient(token);
        await createdAdmin(token, client.id);

        const before = await auditActionsFor(client.id);

        const duplicate = await call(token, 'POST', `/iam/clients/${client.id}/admins`, {
          email: `admin-${suffix}@acme.test`,
          full_name: 'Impostor',
          password: PASSWORD,
        });
        expect(duplicate.status).toBe(409);
        expect(await errorCodeOf(duplicate)).toBe(IamErrorCode.CONFLICT);

        // The user insert is the *first* write of the four, so a leak would show
        // as an orphaned identity or binding. Nothing moved…
        expect(await countIn(client.id, 'user')).toBe(1);
        expect(await countIn(client.id, 'user_identity')).toBe(1);
        expect(await countIn(client.id, 'role_binding')).toBe(1);
        // …and the audit trail did not move either, which is Doc 10 §3's
        // same-transaction coupling holding on a brand-new write path.
        expect(await auditActionsFor(client.id)).toEqual(before);
      });

      it('is a 404 for a client that does not exist', async () => {
        const token = await asPlatform();
        const response = await call(token, 'POST', `/iam/clients/${randomUUID()}/admins`, {
          email: `nobody-${suffix}@acme.test`,
          full_name: 'Nobody',
          password: PASSWORD,
        });

        expect(response.status).toBe(404);
        expect(await errorCodeOf(response)).toBe(IamErrorCode.NOT_FOUND);
      });
    });

    // ── enablement preserves, it does not delete ──────────────────────────

    describe('client_application', () => {
      /**
       * A role in `client` mapping one of `application`'s permissions — the
       * thing Doc 02 §7 promises stays intact across a disable. Written through
       * the owner connection because the roles API is Session 17's.
       */
      const mapPermissionToARole = async (
        clientId: string,
        applicationId: string,
      ): Promise<{ roleId: string; permissionId: string }> => {
        const [permission] = await rowsOf<{ id: string }>(
          fixture.platformClientId,
          `select id from ${S}."permission" where application_id = $1 order by key asc limit 1`,
          [applicationId],
        );

        await elevate(admin, clientId);
        const [role] = (await admin.query(
          `insert into ${S}."role" (client_id, name, is_system) values ($1, $2, false) returning id`,
          [clientId, `Gate Supervisor ${suffix}`],
        )) as { id: string }[];
        await admin.query(
          `insert into ${S}."role_permission" (role_id, permission_id) values ($1, $2)`,
          [role.id, permission.id],
        );

        return { roleId: role.id, permissionId: permission.id };
      };

      const mappingCount = async (clientId: string, roleId: string): Promise<number> => {
        const rows = await rowsOf<{ total: number }>(
          clientId,
          `select count(*)::int as total from ${S}."role_permission" where role_id = $1`,
          [roleId],
        );
        return rows[0]?.total ?? 0;
      };

      it('makes disable and re-enable a toggle, leaving mappings inert but present', async () => {
        const token = await asPlatform();
        const application = await createdApplication(token);
        const client = await createdClient(token);

        await call(token, 'POST', `/iam/clients/${client.id}/applications`, {
          applications: [{ application_key: application.key, config: { tier: 'gold' } }],
        });
        const { roleId } = await mapPermissionToARole(client.id, application.id);

        // Off.
        const disabled = await call(
          token,
          'PATCH',
          `/iam/clients/${client.id}/applications/${application.id}`,
          { enabled: false },
        );
        expect(disabled.status).toBe(200);
        expect(((await disabled.json()) as ClientApplicationDTO).enabled).toBe(false);

        // The row survived, and so did the mapping that depends on it. This is
        // the whole of Doc 02 §7: inert, not deleted.
        expect(await countIn(client.id, 'client_application')).toBe(1);
        expect(await mappingCount(client.id, roleId)).toBe(1);

        // On again, through the bulk route this time — which must restore the
        // config rather than reset it, because re-enabling is a restore.
        const reenabled = await call(
          token,
          'POST',
          `/iam/clients/${client.id}/applications`,
          { applications: [{ application_id: application.id }] },
        );
        expect(reenabled.status).toBe(201);
        const [row] = (await reenabled.json()) as ClientApplicationDTO[];
        expect(row.enabled).toBe(true);
        expect(row.config).toEqual({ tier: 'gold' });
        expect(await mappingCount(client.id, roleId)).toBe(1);
      });

      it('is idempotent: enabling what is already enabled audits nothing', async () => {
        const token = await asPlatform();
        const application = await createdApplication(token);
        const client = await createdClient(token);

        const body = { applications: [{ application_key: application.key }] };
        await call(token, 'POST', `/iam/clients/${client.id}/applications`, body);
        await call(token, 'POST', `/iam/clients/${client.id}/applications`, body);

        const enabledRecords = await auditPayloadsFor(
          client.id,
          AUDIT_ACTIONS.CLIENT_APPLICATION_ENABLED,
        );
        expect(enabledRecords).toHaveLength(1);
        expect(enabledRecords[0]).toMatchObject({ application_key: application.key });
      });

      it('refuses to enable a globally deactivated application', async () => {
        const token = await asPlatform();
        const application = await createdApplication(token);
        const client = await createdClient(token);

        const deactivate = await call(token, 'PATCH', `/iam/applications/${application.id}`, {
          is_active: false,
        });
        expect(deactivate.status).toBe(200);

        const response = await call(token, 'POST', `/iam/clients/${client.id}/applications`, {
          applications: [{ application_key: application.key }],
        });
        expect(response.status).toBe(409);
        expect(await countIn(client.id, 'client_application')).toBe(0);
      });

      it('is a 404 for an application nobody has heard of, and writes nothing', async () => {
        const token = await asPlatform();
        const application = await createdApplication(token);
        const client = await createdClient(token);

        // The known application is named first, so a partial write would leave
        // it enabled — the whole call must be one transaction.
        const response = await call(token, 'POST', `/iam/clients/${client.id}/applications`, {
          applications: [
            { application_key: application.key },
            { application_key: `${APP_KEY_PREFIX}nope` },
          ],
        });

        expect(response.status).toBe(404);
        expect(await countIn(client.id, 'client_application')).toBe(0);
      });

      it('404s a PATCH for an application that was never enabled', async () => {
        const token = await asPlatform();
        const application = await createdApplication(token);
        const client = await createdClient(token);

        const response = await call(
          token,
          'PATCH',
          `/iam/clients/${client.id}/applications/${application.id}`,
          { enabled: false },
        );

        expect(response.status).toBe(404);
        // A PATCH that created the row would make a toggle able to grant.
        expect(await countIn(client.id, 'client_application')).toBe(0);
      });

      it('lists both sides of the toggle', async () => {
        const token = await asPlatform();
        const application = await createdApplication(token);
        const client = await createdClient(token);

        await call(token, 'POST', `/iam/clients/${client.id}/applications`, {
          applications: [{ application_key: application.key }],
        });
        await call(
          token,
          'PATCH',
          `/iam/clients/${client.id}/applications/${application.id}`,
          { enabled: false },
        );

        const response = await call(token, 'GET', `/iam/clients/${client.id}/applications`);
        expect(response.status).toBe(200);
        const rows = (await response.json()) as ClientApplicationDTO[];
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
          application_key: application.key,
          application_name: 'Gate Pass',
          enabled: false,
        });
      });
    });

    // ── suspension is the off switch ──────────────────────────────────────

    describe('suspension', () => {
      it("refuses a suspended client's users at login, and lets them back after", async () => {
        const token = await asPlatform();
        const client = await createdClient(token);
        const created = await createdAdmin(token, client.id);

        expect((await login(created.email, client.slug)).status).toBe(200);

        const suspend = await call(token, 'PATCH', `/iam/clients/${client.id}`, {
          status: 'suspended',
        });
        expect(suspend.status).toBe(200);
        expect(((await suspend.json()) as ClientDTO).status).toBe('suspended');

        const refused = await login(created.email, client.slug);
        expect(refused.status).toBe(401);
        // The same generic 401 a wrong password gets — a suspended tenant is not
        // something an unauthenticated caller gets to learn (Doc 03 §3).
        expect(await errorCodeOf(refused)).toBe(IamErrorCode.INVALID_CREDENTIALS);

        const reactivate = await call(token, 'PATCH', `/iam/clients/${client.id}`, {
          status: 'active',
        });
        expect(reactivate.status).toBe(200);
        expect((await login(created.email, client.slug)).status).toBe(200);
      });

      it('records the suspension under its own action, and nothing on a no-op patch', async () => {
        const token = await asPlatform();
        const client = await createdClient(token);

        await call(token, 'PATCH', `/iam/clients/${client.id}`, { status: 'suspended' });
        // A patch that changes nothing: same name, same status.
        await call(token, 'PATCH', `/iam/clients/${client.id}`, {
          name: client.name,
          status: 'suspended',
        });

        expect(await auditActionsFor(client.id)).toEqual([
          AUDIT_ACTIONS.CLIENT_CREATED,
          AUDIT_ACTIONS.CLIENT_SUSPENDED,
        ]);
      });

      it('records a rename as client.updated with a compact before/after', async () => {
        const token = await asPlatform();
        const client = await createdClient(token);

        await call(token, 'PATCH', `/iam/clients/${client.id}`, { name: 'Acme Renamed' });

        const [payload] = await auditPayloadsFor(client.id, AUDIT_ACTIONS.CLIENT_UPDATED);
        expect(payload).toMatchObject({
          slug: client.slug,
          changed: ['name'],
          before: { name: client.name },
          after: { name: 'Acme Renamed' },
        });
      });
    });

    // ── the audit trail of an onboarding ──────────────────────────────────

    describe('audit', () => {
      it('writes the whole onboarding into the tenant it describes', async () => {
        const token = await asPlatform();
        const application = await createdApplication(token);
        const client = await createdClient(token);

        await call(token, 'POST', `/iam/clients/${client.id}/applications`, {
          applications: [{ application_key: application.key }],
        });
        await call(
          token,
          'PATCH',
          `/iam/clients/${client.id}/applications/${application.id}`,
          { enabled: false },
        );
        await createdAdmin(token, client.id);

        const actions = await auditActionsFor(client.id);

        // Across requests the order is the order of the calls: `created_at` is
        // `now()`, which is the *transaction* timestamp, so rows from different
        // requests sort apart…
        expect(actions.slice(0, 3)).toEqual([
          AUDIT_ACTIONS.CLIENT_CREATED,
          AUDIT_ACTIONS.CLIENT_APPLICATION_ENABLED,
          AUDIT_ACTIONS.CLIENT_APPLICATION_DISABLED,
        ]);
        // …and rows from one request share a timestamp exactly, which is what
        // makes them one atomic record of one action rather than a sequence.
        // Asserting an order among them would be asserting a tie-break that the
        // schema does not promise, so this asserts the set.
        expect([...actions.slice(3)].sort()).toEqual(
          [
            AUDIT_ACTIONS.SCOPE_NODE_CREATED,
            AUDIT_ACTIONS.ROLE_CREATED,
            AUDIT_ACTIONS.USER_CREATED,
            AUDIT_ACTIONS.ROLE_BINDING_CREATED,
          ].sort(),
        );
      });

      it('attributes every record to the platform, never to the tenant', async () => {
        const token = await asPlatform();
        const client = await createdClient(token);
        await createdAdmin(token, client.id);

        const rows = await rowsOf<{ actor_type: string; actor_id: string | null }>(
          client.id,
          `select distinct actor_type, actor_id from ${S}."audit_trail" where client_id = $1`,
          [client.id],
        );

        // `iam.write_audit` derives both from the session context, so this is
        // the database's own account of who did it (Doc 07 §6). The bootstrap
        // identity is a service account, hence a null `actor_id`.
        expect(rows).toEqual([{ actor_type: 'platform', actor_id: null }]);
      });

      it('keeps the password out of the trail entirely', async () => {
        const token = await asPlatform();
        const client = await createdClient(token);
        await createdAdmin(token, client.id);

        const rows = await rowsOf<{ payload: unknown }>(
          client.id,
          `select payload from ${S}."audit_trail" where client_id = $1`,
          [client.id],
        );

        expect(JSON.stringify(rows)).not.toContain(PASSWORD);
      });
    });

    // ── authorization and isolation ───────────────────────────────────────

    describe('authorization', () => {
      const routes = (clientId: string, applicationId: string) =>
        [
          ['POST', '/iam/clients', { name: 'Sneaky', slug: `${SLUG_PREFIX}sneaky` }],
          ['GET', '/iam/clients', undefined],
          ['PATCH', `/iam/clients/${clientId}`, { name: 'Renamed' }],
          [
            'POST',
            `/iam/clients/${clientId}/applications`,
            { applications: [{ application_id: applicationId }] },
          ],
          ['GET', `/iam/clients/${clientId}/applications`, undefined],
          [
            'PATCH',
            `/iam/clients/${clientId}/applications/${applicationId}`,
            { enabled: false },
          ],
          [
            'POST',
            `/iam/clients/${clientId}/admins`,
            { email: `x-${suffix}@acme.test`, full_name: 'X', password: PASSWORD },
          ],
        ] as const;

      it('refuses a client admin on every route, with 403 and no write', async () => {
        const platform = await asPlatform();
        const application = await createdApplication(platform);
        const client = await createdClient(platform);
        const outsider = await asOutsider();

        for (const [method, path, body] of routes(client.id, application.id)) {
          const response = await call(outsider, method, path, body);
          expect([method, path, response.status]).toEqual([method, path, 403]);
          expect(await errorCodeOf(response)).toBe(IamErrorCode.PERMISSION_DENIED);
        }

        // Nothing leaked into the outsider's own tenant either — the refusal
        // happens before any provisioning context is entered.
        expect(await countIn(fixture.outsiderClientId, 'client_application')).toBe(0);
        expect(await countIn(client.id, 'client_application')).toBe(0);
      });

      it('refuses an unauthenticated caller before authorization is considered', async () => {
        const response = await fetch(`${baseUrl}/iam/clients`);
        expect(response.status).toBe(401);
        expect(await errorCodeOf(response)).toBe(IamErrorCode.AUTH_REQUIRED);
      });

      it('409s a duplicate slug rather than creating a second tenant', async () => {
        const token = await asPlatform();
        const client = await createdClient(token);

        const again = await call(token, 'POST', '/iam/clients', {
          name: 'Another Acme',
          slug: client.slug,
        });
        expect(again.status).toBe(409);
        expect(await errorCodeOf(again)).toBe(IamErrorCode.CONFLICT);
      });

      it('404s a client that does not exist rather than reporting a broken write', async () => {
        const token = await asPlatform();
        const response = await call(token, 'PATCH', `/iam/clients/${randomUUID()}`, {
          name: 'Ghost',
        });

        expect(response.status).toBe(404);
        expect(await errorCodeOf(response)).toBe(IamErrorCode.NOT_FOUND);
      });

      it('restores the platform context after a provisioning write', async () => {
        // Two provisioned tenants in one process, then a read that only a
        // platform context can answer. If `withProvisioningTenant` failed to put
        // the context back, the second call's audit rows would land under the
        // first tenant — so this asserts each tenant owns exactly its own.
        const token = await asPlatform();
        const first = await createdClient(token);
        const second = await createdClient(token, {
          name: `Beta ${suffix}`,
          slug: `${SLUG_PREFIX}b-${suffix}`,
        });

        expect(await auditActionsFor(first.id)).toEqual([AUDIT_ACTIONS.CLIENT_CREATED]);
        expect(await auditActionsFor(second.id)).toEqual([AUDIT_ACTIONS.CLIENT_CREATED]);

        const list = await call(token, 'GET', '/iam/clients?limit=100');
        expect(list.status).toBe(200);
        const page = (await list.json()) as Paginated<ClientDTO>;
        expect(page.data.map((row) => row.id)).toEqual(
          expect.arrayContaining([first.id, second.id]),
        );
      });
    });
  },
);

/**
 * Platform context on the owner connection.
 *
 * Session-scoped (`false`) rather than transaction-local, because these queries
 * run outside a transaction and the connection is this suite's alone.
 */
async function elevate(admin: DataSource, clientId: string): Promise<void> {
  await admin.query(`select set_config('app.is_platform_admin', 'true', false)`);
  await admin.query(`select set_config('app.current_client_id', $1, false)`, [clientId]);
}

/**
 * One ordinary tenant with one client admin.
 *
 * It exists to prove a negative: `user.is_client_admin` is the strongest thing a
 * tenant can be, and it is still not a platform subject. Seeded directly rather
 * than through `POST /iam/clients/:id/admins`, so that the negative does not
 * depend on the endpoint it is testing.
 */
async function seed(admin: DataSource, secretHash: string): Promise<Fixture> {
  const suffix = randomUUID().slice(0, 8);

  await admin.query(`select set_config('app.is_platform_admin', 'true', false)`);

  const [platform] = (await admin.query(`select id from ${S}."client" where slug = $1`, [
    PLATFORM_CLIENT_SLUG,
  ])) as { id: string }[];

  if (platform === undefined) {
    throw new Error(
      `No "${PLATFORM_CLIENT_SLUG}" client — run the migrations (0011 seeds the platform identity).`,
    );
  }

  const fixture: Fixture = {
    platformClientId: platform.id,
    outsiderClientId: randomUUID(),
    outsiderSlug: `${SLUG_PREFIX}out-${suffix}`,
    outsiderEmail: `outsider-${suffix}@example.test`,
  };

  await elevate(admin, fixture.outsiderClientId);
  await admin.query(
    `insert into ${S}."client" (id, name, slug, status) values ($1, $2, $3, 'active')`,
    [fixture.outsiderClientId, `Session 15 Outsider ${suffix}`, fixture.outsiderSlug],
  );

  const outsiderId = randomUUID();
  await admin.query(
    `insert into ${S}."user" (id, client_id, email, full_name, status, is_client_admin)
     values ($1, $2, $3, 'Session 15 Fixture', 'active', true)`,
    [outsiderId, fixture.outsiderClientId, fixture.outsiderEmail],
  );
  await admin.query(
    `insert into ${S}."user_identity" (client_id, user_id, provider, secret_hash)
     values ($1, $2, 'password', $3)`,
    [fixture.outsiderClientId, outsiderId, secretHash],
  );

  return fixture;
}

/** Every `s15-` tenant except the outsider, and every `s15-` application. */
async function purgeFixtureTenants(
  admin: DataSource,
  platformClientId: string,
  keep: readonly string[] = [],
): Promise<void> {
  await elevate(admin, platformClientId);
  const clients = (await admin.query(
    `select id from ${S}."client" where slug like $1 and id <> all($2::uuid[])`,
    [`${SLUG_PREFIX}%`, keep],
  )) as { id: string }[];

  for (const { id } of clients) {
    await dropTenant(admin, id);
  }

  await elevate(admin, platformClientId);
  await admin.query(`delete from ${S}."application" where key like $1`, [
    `${APP_KEY_PREFIX}%`,
  ]);
}

/**
 * Removes one tenant and everything hanging off it, in foreign-key order.
 *
 * `on delete restrict` towards `client` (migration 0003) is deliberate — it is
 * what stops a tenant from being deleted in production — so the suite has to
 * unwind by hand, which is a fair reminder of why the API has no DELETE.
 */
async function dropTenant(admin: DataSource, clientId: string): Promise<void> {
  await elevate(admin, clientId);
  for (const statement of [
    `delete from ${S}."role_permission" where role_id in (select id from ${S}."role" where client_id = $1)`,
    `delete from ${S}."role_binding" where client_id = $1`,
    `delete from ${S}."session" where client_id = $1`,
    `delete from ${S}."password_reset_token" where client_id = $1`,
    `delete from ${S}."user_identity" where client_id = $1`,
    `delete from ${S}."user" where client_id = $1`,
    `delete from ${S}."role" where client_id = $1`,
    `delete from ${S}."client_application" where client_id = $1`,
    `delete from ${S}."scope_node" where client_id = $1`,
    `delete from ${S}."audit_trail" where client_id = $1`,
    `delete from ${S}."client" where id = $1`,
  ]) {
    await admin.query(statement, [clientId]);
  }
}

async function teardown(
  admin: DataSource,
  fixture: Fixture,
  startedAt: Date,
): Promise<void> {
  if (fixture === undefined) return;

  await purgeFixtureTenants(admin, fixture.platformClientId);
  await dropTenant(admin, fixture.outsiderClientId);

  // The catalog rows this suite wrote land in the *platform* tenant, and the
  // audit table has no foreign key to what it describes (Doc 01 §4.8), so they
  // need their own delete. Bounded by the suite's own start time rather than by
  // action alone, so a concurrently-running suite's rows survive.
  await elevate(admin, fixture.platformClientId);
  await admin.query(
    `delete from ${S}."audit_trail"
      where client_id = $1 and action = any($2::text[]) and created_at >= $3`,
    [fixture.platformClientId, [...CATALOG_ACTIONS], startedAt],
  );
}
