/**
 * The Session 13 Definition of Done: a small application catalog built end to
 * end **over HTTP only** (Doc 02 §2, Doc 06 §4).
 *
 * The point of running it against a real Postgres is that almost every claim
 * this session makes is a claim about the database. That a duplicate
 * `(application_id, key)` is refused, that a nav parent cannot come from another
 * application, that deactivating an application leaves its permissions and nav
 * intact, that catalog RLS admits only a platform subject, and that every
 * mutation lands in `audit_trail` in the same transaction as the change — none
 * of those can fail against a fake.
 *
 *   docker compose up -d postgres
 *   npm run migration:run
 *   npx nx test @plantops/iam-api
 *
 * **Destructive within its own fixtures only.** Every application it creates is
 * keyed `s13-…` and removed afterwards; the tenant it seeds is removed with it.
 * It deletes the registry-action audit rows it wrote and nothing else — in
 * particular not `platform.bootstrap`, which happened once and is not this
 * suite's to unmake (Doc 10 §1).
 *
 * ## The caller is the bootstrap account, and that is the session's design
 *
 * Session 13's interim authorization is "a platform subject", and the only one
 * that exists before Session 15 is the identity migration 0011 seeds. So the
 * suite authenticates the way an operator would on day one: exchange the
 * bootstrap credentials at `POST /auth/token`, then call the registry with the
 * token. Nothing is asserted into the RLS context by the test — the platform
 * flag is derived from the account's binding at the platform scope root, exactly
 * as it is in production (`rls-context.ts`).
 *
 * ## Deliberate deviations from the shipped configuration
 *
 * - **Rate limiting is off.** These cases make dozens of calls per test and the
 *   throttle would be measuring the suite rather than the code.
 * - **Nothing else.** The interim permission rule, the validation pipe and the
 *   audit path are the shipped ones; each is something the suite asserts.
 */

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { loadEnv } from '@plantops/config';
import {
  IamErrorCode,
  type AccessTokenResponse,
  type ApplicationDTO,
  type IamErrorResponse,
  type NavCatalogResponse,
  type NavNodeCatalogDTO,
  type NavPermissionsResult,
  type Paginated,
  type PermissionDTO,
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

/** Every action this suite can write — the set it is allowed to clean up. */
const REGISTRY_ACTIONS = [
  AUDIT_ACTIONS.APPLICATION_CREATED,
  AUDIT_ACTIONS.APPLICATION_UPDATED,
  AUDIT_ACTIONS.APPLICATION_DEACTIVATED,
  AUDIT_ACTIONS.PERMISSION_CREATED,
  AUDIT_ACTIONS.NAV_NODE_CREATED,
  AUDIT_ACTIONS.MENU_PERMISSION_MAPPED,
  AUDIT_ACTIONS.MENU_PERMISSION_UNMAPPED,
] as const;

/** Applications this suite creates all share this prefix, so cleanup is exact. */
const KEY_PREFIX = 's13-';

interface Fixture {
  /** The platform tenant, which owns the bootstrap identity's audit rows. */
  platformClientId: string;
  /** An ordinary tenant, whose client admin must be refused by every route. */
  clientId: string;
  clientSlug: string;
  outsiderEmail: string;
}

describeWithDb(
  `platform registry APIs (${configured ? 'live' : 'skipped: no DATABASE_URL'})`,
  () => {
    let app: INestApplication;
    let baseUrl: string;
    let admin: DataSource;
    let fixture: Fixture;
    let bootstrapSecret: string;
    /** Unique per run, so a crashed previous run cannot collide with this one. */
    let suffix: string;

    jest.setTimeout(180_000);

    beforeAll(async () => {
      const env = loadEnv();
      bootstrapSecret = env.PLATFORM_BOOTSTRAP_SECRET;

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
        await teardown(admin, fixture);
        await admin.query('select pg_advisory_unlock($1)', [IAM_SCHEMA_TEST_LOCK_ID]);
        await admin.destroy();
      }
    });

    /**
     * A clean catalog before every case.
     *
     * Deleting the application cascades its permissions, nav nodes and
     * `menu_permission` rows (migration 0002/0004), so one statement is enough
     * for the catalog. The audit rows need their own delete because
     * `audit_trail` has no foreign key to what it describes — deliberately, since
     * a record must outlive its target (Doc 01 §4.8).
     */
    beforeEach(async () => {
      suffix = randomUUID().slice(0, 8);
      await elevate(admin, fixture.platformClientId);
      await admin.query(`delete from ${S}."application" where key like $1`, [
        `${KEY_PREFIX}%`,
      ]);
      await admin.query(`delete from ${S}."audit_trail" where action = any($1::text[])`, [
        [...REGISTRY_ACTIONS],
      ]);
    });

    // ── the wire ──────────────────────────────────────────────────────────

    /**
     * A platform token, from the bootstrap credentials — the only platform
     * subject that exists before Session 15.
     */
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

    /** A perfectly ordinary client admin — authenticated, and not a platform subject. */
    const asOutsider = async (): Promise<string> => {
      const response = await fetch(`${baseUrl}/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          email: fixture.outsiderEmail,
          password: PASSWORD,
          client_slug: fixture.clientSlug,
        }),
      });
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

    const createApplication = (
      token: string,
      body: Record<string, unknown>,
    ): Promise<Response> => call(token, 'POST', '/iam/applications', body);

    const createdApplication = async (
      token: string,
      overrides: Record<string, unknown> = {},
    ): Promise<ApplicationDTO> => {
      const response = await createApplication(token, {
        key: `${KEY_PREFIX}${suffix}`,
        name: 'Gate Pass',
        ...overrides,
      });
      expect(response.status).toBe(201);
      return (await response.json()) as ApplicationDTO;
    };

    const addPermissions = (token: string, id: string, permissions: unknown[]) =>
      call(token, 'POST', `/iam/applications/${id}/permissions`, { permissions });

    const addNav = (token: string, id: string, nodes: unknown[]) =>
      call(token, 'POST', `/iam/applications/${id}/nav`, { nodes });

    const mapNav = (token: string, id: string, mappings: unknown[]) =>
      call(token, 'POST', `/iam/applications/${id}/nav-permissions`, { mappings });

    const unmapNav = (token: string, id: string, mappings: unknown[]) =>
      call(token, 'DELETE', `/iam/applications/${id}/nav-permissions`, { mappings });

    const navTree = async (token: string, id: string): Promise<NavCatalogResponse> => {
      const response = await call(token, 'GET', `/iam/applications/${id}/nav`);
      expect(response.status).toBe(200);
      return (await response.json()) as NavCatalogResponse;
    };

    const errorCodeOf = async (response: Response): Promise<string> =>
      ((await response.json()) as IamErrorResponse).error.code;

    // ── inspection ────────────────────────────────────────────────────────

    const auditActions = async (): Promise<string[]> => {
      await elevate(admin, fixture.platformClientId);
      const rows = (await admin.query(
        `select action from ${S}."audit_trail"
          where action = any($1::text[])
          order by created_at asc, id asc`,
        [[...REGISTRY_ACTIONS]],
      )) as { action: string }[];
      return rows.map((row) => row.action);
    };

    const auditPayloads = async (action: string): Promise<Record<string, unknown>[]> => {
      await elevate(admin, fixture.platformClientId);
      const rows = (await admin.query(
        `select payload from ${S}."audit_trail" where action = $1 order by created_at asc, id asc`,
        [action],
      )) as { payload: Record<string, unknown> }[];
      return rows.map((row) => row.payload);
    };

    const countRows = async (table: string, applicationId: string): Promise<number> => {
      await elevate(admin, fixture.platformClientId);
      const rows = (await admin.query(
        `select count(*)::int as total from ${S}."${table}" where application_id = $1`,
        [applicationId],
      )) as { total: number }[];
      return rows[0]?.total ?? 0;
    };

    // ── the Definition of Done ────────────────────────────────────────────

    describe('an application catalog built entirely over HTTP', () => {
      it('walks Doc 02 §2 end to end and reads the result back', async () => {
        const token = await asPlatform();

        // 1. The application.
        const application = await createdApplication(token, {
          description: 'Gate pass issuing and verification',
          config: { theme: 'industrial' },
        });
        expect(application.is_active).toBe(true);
        expect(application.config).toEqual({ theme: 'industrial' });

        // 2. Its permissions, in bulk.
        const permissionsResponse = await addPermissions(token, application.id, [
          { key: `${application.key}.dc.create`, name: 'Create DC' },
          { key: `${application.key}.dc.approve`, name: 'Approve DC' },
          { key: `${application.key}.gate.verify`, name: 'Verify at gate' },
        ]);
        expect(permissionsResponse.status).toBe(201);
        expect((await permissionsResponse.json()) as PermissionDTO[]).toHaveLength(3);

        // 3. Its nav tree — a module and two menus, in one call, with the
        //    children naming their parent by the key created moments earlier.
        const navResponse = await addNav(token, application.id, [
          { kind: 'module', key: 'gatepass', label: 'Gate Pass', icon: 'truck' },
          {
            kind: 'menu',
            key: 'dc.create',
            label: 'New DC',
            route: '/gatepass/new',
            parent_key: 'gatepass',
            sort_order: 1,
          },
          {
            kind: 'menu',
            key: 'dc.approvals',
            label: 'Approvals',
            route: '/gatepass/approvals',
            parent_key: 'gatepass',
            sort_order: 2,
          },
        ]);
        expect(navResponse.status).toBe(201);

        // 4. The mapping that decides who sees what (Doc 05 §3).
        const mapped = await mapNav(token, application.id, [
          { nav_key: 'dc.create', permission_keys: [`${application.key}.dc.create`] },
          {
            nav_key: 'dc.approvals',
            permission_keys: [`${application.key}.dc.approve`],
          },
        ]);
        expect(mapped.status).toBe(200);
        expect((await mapped.json()) as NavPermissionsResult).toEqual({
          changed: 2,
          unchanged: 0,
        });

        // And the catalog reads back as the tree it was described as.
        const tree = await navTree(token, application.id);
        expect(tree.tree).toHaveLength(1);

        const [module] = tree.tree;
        expect(module.key).toBe('gatepass');
        expect(module.parent_id).toBeNull();
        expect(module.requires).toEqual([]);
        expect(module.children.map((child: NavNodeCatalogDTO) => child.key)).toEqual([
          'dc.create',
          'dc.approvals',
        ]);
        expect(module.children[0].requires).toEqual([`${application.key}.dc.create`]);
        expect(module.children[1].requires).toEqual([`${application.key}.dc.approve`]);
      });

      it('audits every mutation along the way (Doc 10 §4)', async () => {
        const token = await asPlatform();
        const application = await createdApplication(token);
        await addPermissions(token, application.id, [
          { key: `${application.key}.dc.create`, name: 'Create DC' },
        ]);
        await addNav(token, application.id, [
          { kind: 'module', key: 'gatepass', label: 'Gate Pass' },
        ]);
        await mapNav(token, application.id, [
          { nav_key: 'gatepass', permission_keys: [`${application.key}.dc.create`] },
        ]);
        await unmapNav(token, application.id, [
          { nav_key: 'gatepass', permission_keys: [`${application.key}.dc.create`] },
        ]);

        expect(await auditActions()).toEqual([
          AUDIT_ACTIONS.APPLICATION_CREATED,
          AUDIT_ACTIONS.PERMISSION_CREATED,
          AUDIT_ACTIONS.NAV_NODE_CREATED,
          AUDIT_ACTIONS.MENU_PERMISSION_MAPPED,
          AUDIT_ACTIONS.MENU_PERMISSION_UNMAPPED,
        ]);
      });

      it('names the application and the key in the audit payloads', async () => {
        const token = await asPlatform();
        const application = await createdApplication(token);
        await addPermissions(token, application.id, [
          { key: `${application.key}.dc.create`, name: 'Create DC' },
        ]);

        expect(await auditPayloads(AUDIT_ACTIONS.APPLICATION_CREATED)).toContainEqual(
          expect.objectContaining({ key: application.key, name: 'Gate Pass' }),
        );
        expect(await auditPayloads(AUDIT_ACTIONS.PERMISSION_CREATED)).toContainEqual(
          expect.objectContaining({
            application_id: application.id,
            key: `${application.key}.dc.create`,
          }),
        );
      });
    });

    // ── uniqueness (Doc 06 §4) ────────────────────────────────────────────

    describe('duplicate keys are a 409', () => {
      it('refuses a second application with the same key', async () => {
        const token = await asPlatform();
        await createdApplication(token);

        const response = await createApplication(token, {
          key: `${KEY_PREFIX}${suffix}`,
          name: 'Impostor',
        });

        expect(response.status).toBe(409);
        expect(await errorCodeOf(response)).toBe(IamErrorCode.CONFLICT);
      });

      it('refuses a duplicate permission key within one application', async () => {
        const token = await asPlatform();
        const application = await createdApplication(token);
        const permission = { key: `${application.key}.dc.create`, name: 'Create DC' };
        await addPermissions(token, application.id, [permission]);

        const response = await addPermissions(token, application.id, [permission]);

        expect(response.status).toBe(409);
        expect(await errorCodeOf(response)).toBe(IamErrorCode.CONFLICT);
      });

      it('allows the same permission key under a different application', async () => {
        const token = await asPlatform();
        const first = await createdApplication(token);
        const second = await createdApplication(token, {
          key: `${KEY_PREFIX}${suffix}-b`,
          name: 'Second',
        });
        const permission = { key: 'shared.thing.do', name: 'Do the thing' };

        expect((await addPermissions(token, first.id, [permission])).status).toBe(201);
        // Uniqueness is on the *pair* (Doc 01 §6.3): two applications may each
        // define a key of the same spelling, and the global address that
        // distinguishes them is the application plus the key.
        expect((await addPermissions(token, second.id, [permission])).status).toBe(201);
      });

      it('rolls the whole bulk body back when one entry collides', async () => {
        const token = await asPlatform();
        const application = await createdApplication(token);
        await addPermissions(token, application.id, [
          { key: `${application.key}.a`, name: 'A' },
        ]);

        const response = await addPermissions(token, application.id, [
          { key: `${application.key}.b`, name: 'B' },
          { key: `${application.key}.a`, name: 'A again' },
          { key: `${application.key}.c`, name: 'C' },
        ]);

        expect(response.status).toBe(409);
        // `b` was inserted before the collision and must not survive it — the
        // request transaction is the unit, not the statement (Doc 07 §5).
        expect(await countRows('permission', application.id)).toBe(1);
      });

      it('refuses a duplicate nav node key', async () => {
        const token = await asPlatform();
        const application = await createdApplication(token);
        const node = { kind: 'module', key: 'gatepass', label: 'Gate Pass' };
        await addNav(token, application.id, [node]);

        expect((await addNav(token, application.id, [node])).status).toBe(409);
      });
    });

    // ── the parent constraint (Doc 06 §4) ─────────────────────────────────

    describe('a nav parent belongs to the same application', () => {
      it('refuses a parent id from another application with a 409', async () => {
        const token = await asPlatform();
        const owner = await createdApplication(token);
        const other = await createdApplication(token, {
          key: `${KEY_PREFIX}${suffix}-other`,
          name: 'Other',
        });

        const [foreignParent] = (await (
          await addNav(token, other.id, [
            { kind: 'module', key: 'elsewhere', label: 'Elsewhere' },
          ])
        ).json()) as NavNodeCatalogDTO[];

        const response = await addNav(token, owner.id, [
          {
            kind: 'menu',
            key: 'stolen',
            label: 'Stolen',
            parent_id: foreignParent.id,
          },
        ]);

        // Doc 06 §2 files a cross-entity reference under CONFLICT. The composite
        // foreign key of migration 0002 would refuse it regardless; the service
        // check is what makes the refusal a 409 instead of a 500.
        expect(response.status).toBe(409);
        expect(await errorCodeOf(response)).toBe(IamErrorCode.CONFLICT);
        expect(await countRows('nav_node', owner.id)).toBe(0);
      });

      it('refuses an unknown parent key', async () => {
        const token = await asPlatform();
        const application = await createdApplication(token);

        const response = await addNav(token, application.id, [
          { kind: 'menu', key: 'orphan', label: 'Orphan', parent_key: 'nobody' },
        ]);

        expect(response.status).toBe(409);
      });

      it('accepts a parent created earlier in the same request', async () => {
        const token = await asPlatform();
        const application = await createdApplication(token);

        const response = await addNav(token, application.id, [
          { kind: 'module', key: 'gatepass', label: 'Gate Pass' },
          {
            kind: 'menu',
            key: 'dc.create',
            label: 'New DC',
            route: '/gatepass/new',
            parent_key: 'gatepass',
          },
          {
            kind: 'sub_menu',
            key: 'dc.create.bulk',
            label: 'Bulk',
            route: '/gatepass/new/bulk',
            parent_key: 'dc.create',
          },
        ]);

        expect(response.status).toBe(201);
        const tree = await navTree(token, application.id);
        expect(tree.tree[0].children[0].children[0].key).toBe('dc.create.bulk');
      });
    });

    // ── deactivation preserves everything (Doc 02 §7) ─────────────────────

    describe('PATCH /iam/applications/:id', () => {
      it('deactivates without losing a single row', async () => {
        const token = await asPlatform();
        const application = await createdApplication(token);
        await addPermissions(token, application.id, [
          { key: `${application.key}.dc.create`, name: 'Create DC' },
        ]);
        await addNav(token, application.id, [
          { kind: 'module', key: 'gatepass', label: 'Gate Pass' },
        ]);
        await mapNav(token, application.id, [
          { nav_key: 'gatepass', permission_keys: [`${application.key}.dc.create`] },
        ]);

        const response = await call(token, 'PATCH', `/iam/applications/${application.id}`, {
          is_active: false,
        });

        expect(response.status).toBe(200);
        expect(((await response.json()) as ApplicationDTO).is_active).toBe(false);
        // "Hidden everywhere; existing data preserved" (Doc 02 §7). Hiding is
        // resolution's job; this endpoint's job is to not destroy anything.
        expect(await countRows('permission', application.id)).toBe(1);
        expect(await countRows('nav_node', application.id)).toBe(1);
        expect(await auditActions()).toContain(AUDIT_ACTIONS.APPLICATION_DEACTIVATED);
      });

      it('still lists a deactivated application, so it can be brought back', async () => {
        const token = await asPlatform();
        const application = await createdApplication(token);
        await call(token, 'PATCH', `/iam/applications/${application.id}`, {
          is_active: false,
        });

        const reactivated = await call(
          token,
          'PATCH',
          `/iam/applications/${application.id}`,
          { is_active: true },
        );

        expect(((await reactivated.json()) as ApplicationDTO).is_active).toBe(true);
        // Reactivation has no dedicated action in the Doc 10 §4 catalog, so it
        // rides in `application.updated` with `is_active` among the changed
        // fields.
        expect(await auditPayloads(AUDIT_ACTIONS.APPLICATION_UPDATED)).toContainEqual(
          expect.objectContaining({ changed: ['is_active'] }),
        );
      });

      it('records a rename as a compact before/after', async () => {
        const token = await asPlatform();
        const application = await createdApplication(token);

        await call(token, 'PATCH', `/iam/applications/${application.id}`, {
          name: 'Gate Pass v2',
        });

        expect(await auditPayloads(AUDIT_ACTIONS.APPLICATION_UPDATED)).toContainEqual(
          expect.objectContaining({
            key: application.key,
            changed: ['name'],
            before: { name: 'Gate Pass' },
            after: { name: 'Gate Pass v2' },
          }),
        );
      });

      it('writes nothing for a PATCH that changes nothing', async () => {
        const token = await asPlatform();
        const application = await createdApplication(token);

        const response = await call(token, 'PATCH', `/iam/applications/${application.id}`, {
          name: 'Gate Pass',
        });

        expect(response.status).toBe(200);
        // A trail that logs "updated" every time a form is re-submitted
        // unchanged is one nobody can read.
        expect(await auditActions()).not.toContain(AUDIT_ACTIONS.APPLICATION_UPDATED);
      });

      it('404s for an application that does not exist', async () => {
        const response = await call(
          await asPlatform(),
          'PATCH',
          `/iam/applications/${randomUUID()}`,
          { name: 'Nobody' },
        );

        expect(response.status).toBe(404);
      });
    });

    // ── mapping is idempotent in both directions ──────────────────────────

    describe('POST and DELETE /iam/applications/:id/nav-permissions', () => {
      const seedCatalog = async (token: string) => {
        const application = await createdApplication(token);
        await addPermissions(token, application.id, [
          { key: `${application.key}.dc.create`, name: 'Create DC' },
        ]);
        await addNav(token, application.id, [
          { kind: 'module', key: 'gatepass', label: 'Gate Pass' },
        ]);
        return {
          application,
          mapping: [
            { nav_key: 'gatepass', permission_keys: [`${application.key}.dc.create`] },
          ],
        };
      };

      it('maps once and reports the second call as unchanged', async () => {
        const token = await asPlatform();
        const { application, mapping } = await seedCatalog(token);

        await mapNav(token, application.id, mapping);
        const again = await mapNav(token, application.id, mapping);

        expect((await again.json()) as NavPermissionsResult).toEqual({
          changed: 0,
          unchanged: 1,
        });
        // Re-running a deployment script must not fill the trail with events
        // in which nothing happened.
        expect(
          (await auditActions()).filter(
            (action) => action === AUDIT_ACTIONS.MENU_PERMISSION_MAPPED,
          ),
        ).toHaveLength(1);
      });

      it('unmaps, keeping the nav node itself', async () => {
        const token = await asPlatform();
        const { application, mapping } = await seedCatalog(token);
        await mapNav(token, application.id, mapping);

        const response = await unmapNav(token, application.id, mapping);

        expect((await response.json()) as NavPermissionsResult).toEqual({
          changed: 1,
          unchanged: 0,
        });
        expect(await countRows('nav_node', application.id)).toBe(1);
        // An unmapped leaf becomes invisible to everyone rather than visible to
        // everyone (Doc 05 §3) — the safe direction.
        const tree = await navTree(token, application.id);
        expect(tree.tree[0].requires).toEqual([]);
      });

      it('reports an unmap of something never mapped as unchanged', async () => {
        const token = await asPlatform();
        const { application, mapping } = await seedCatalog(token);

        const response = await unmapNav(token, application.id, mapping);

        expect((await response.json()) as NavPermissionsResult).toEqual({
          changed: 0,
          unchanged: 1,
        });
        expect(await auditActions()).not.toContain(AUDIT_ACTIONS.MENU_PERMISSION_UNMAPPED);
      });

      it('404s on a permission key the application does not have', async () => {
        const token = await asPlatform();
        const { application } = await seedCatalog(token);

        const response = await mapNav(token, application.id, [
          { nav_key: 'gatepass', permission_keys: ['nothing.of.the.sort'] },
        ]);

        expect(response.status).toBe(404);
        expect(await errorCodeOf(response)).toBe(IamErrorCode.NOT_FOUND);
      });

      it('404s on a nav key the application does not have', async () => {
        const token = await asPlatform();
        const { application } = await seedCatalog(token);

        const response = await mapNav(token, application.id, [
          { nav_key: 'not-a-node', permission_keys: [`${application.key}.dc.create`] },
        ]);

        expect(response.status).toBe(404);
      });
    });

    // ── the lists (Doc 06 §1, §4) ─────────────────────────────────────────

    describe('the list endpoints', () => {
      it('paginates applications in the standard envelope', async () => {
        const token = await asPlatform();
        await createdApplication(token, { key: `${KEY_PREFIX}${suffix}-a`, name: 'A' });
        await createdApplication(token, { key: `${KEY_PREFIX}${suffix}-b`, name: 'B' });

        const page = (await (
          await call(token, 'GET', '/iam/applications?page=1&limit=1')
        ).json()) as Paginated<ApplicationDTO>;

        expect(page.data).toHaveLength(1);
        expect(page.limit).toBe(1);
        // The catalog is global, so the total counts every application the
        // platform has ever registered, not just this suite's two.
        expect(page.total).toBeGreaterThanOrEqual(2);
      });

      it('lists an application’s permissions alphabetically', async () => {
        const token = await asPlatform();
        const application = await createdApplication(token);
        await addPermissions(token, application.id, [
          { key: `${application.key}.z.last`, name: 'Last' },
          { key: `${application.key}.a.first`, name: 'First' },
        ]);

        const page = (await (
          await call(token, 'GET', `/iam/applications/${application.id}/permissions`)
        ).json()) as Paginated<PermissionDTO>;

        expect(page.total).toBe(2);
        expect(page.data.map((permission) => permission.key)).toEqual([
          `${application.key}.a.first`,
          `${application.key}.z.last`,
        ]);
      });

      it('404s on a sub-resource of an application that does not exist', async () => {
        const token = await asPlatform();
        const unknown = randomUUID();

        expect(
          (await call(token, 'GET', `/iam/applications/${unknown}/permissions`)).status,
        ).toBe(404);
        expect((await call(token, 'GET', `/iam/applications/${unknown}/nav`)).status).toBe(
          404,
        );
        expect(
          (await addPermissions(token, unknown, [{ key: 'a.b', name: 'A' }])).status,
        ).toBe(404);
      });

      it('400s on an id that is not a uuid, before any query runs', async () => {
        expect(
          (await call(await asPlatform(), 'GET', '/iam/applications/not-a-uuid/nav'))
            .status,
        ).toBe(400);
      });
    });

    // ── the interim permission rule ───────────────────────────────────────

    describe('who may administer the registry', () => {
      it('refuses an authenticated non-platform subject with a 403', async () => {
        const outsider = await asOutsider();

        const response = await createApplication(outsider, {
          key: `${KEY_PREFIX}${suffix}`,
          name: 'Not yours',
        });

        // Doc 06 §4 gates this on `iam.platform.*`, which needs Session 23's
        // PermissionGuard. Until then the check is "is this a platform subject",
        // derived from a binding at the platform scope root and never asserted
        // by the caller (`rls-context.ts`).
        expect(response.status).toBe(403);
        expect(await errorCodeOf(response)).toBe(IamErrorCode.PERMISSION_DENIED);
      });

      it('refuses a non-platform subject the reads as well', async () => {
        const outsider = await asOutsider();

        expect((await call(outsider, 'GET', '/iam/applications')).status).toBe(403);
      });

      it('refuses an unauthenticated caller with a 401', async () => {
        const response = await fetch(`${baseUrl}/iam/applications`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ key: `${KEY_PREFIX}nobody`, name: 'Nobody' }),
        });

        expect(response.status).toBe(401);
      });

      it('writes nothing when it refuses', async () => {
        const outsider = await asOutsider();
        await createApplication(outsider, {
          key: `${KEY_PREFIX}${suffix}`,
          name: 'Not yours',
        });

        await elevate(admin, fixture.platformClientId);
        const rows = (await admin.query(
          `select count(*)::int as total from ${S}."application" where key like $1`,
          [`${KEY_PREFIX}%`],
        )) as { total: number }[];

        expect(rows[0].total).toBe(0);
        expect(await auditActions()).toHaveLength(0);
      });
    });

    // ── validation reaches the wire (Doc 06 §2) ───────────────────────────

    describe('malformed bodies', () => {
      it('400s an application key that is not a machine key', async () => {
        const response = await createApplication(await asPlatform(), {
          key: 'Gate Pass',
          name: 'Gate Pass',
        });

        expect(response.status).toBe(400);
        expect(await errorCodeOf(response)).toBe(IamErrorCode.VALIDATION_FAILED);
      });

      it('400s an empty PATCH', async () => {
        const token = await asPlatform();
        const application = await createdApplication(token);

        expect(
          (await call(token, 'PATCH', `/iam/applications/${application.id}`, {})).status,
        ).toBe(400);
      });

      it('400s a nav route that points off-site', async () => {
        const token = await asPlatform();
        const application = await createdApplication(token);

        const response = await addNav(token, application.id, [
          {
            kind: 'menu',
            key: 'evil',
            label: 'Evil',
            route: 'https://example.test/steal',
          },
        ]);

        expect(response.status).toBe(400);
      });
    });
  },
);

/** Platform context on the admin connection, so fixtures can be read and written. */
async function elevate(admin: DataSource, clientId: string): Promise<void> {
  await admin.query(`select set_config('app.is_platform_admin', 'true', false)`);
  await admin.query(`select set_config('app.current_client_id', $1, false)`, [clientId]);
}

/**
 * One ordinary tenant with one client admin.
 *
 * The client admin exists to prove a negative: `user.is_client_admin` is the
 * strongest thing a tenant can be, and it is still not a platform subject. The
 * platform identity itself is not seeded here — migration 0011 already did that,
 * which is the point.
 */
async function seed(admin: DataSource, secretHash: string): Promise<Fixture> {
  const suffix = randomUUID().slice(0, 8);

  // Platform context *before* the lookup. `client` carries
  // `force row level security` (migration 0007), which applies to the owner
  // running this connection too — without the flag the policy filters the
  // platform tenant out and the seed reads as "the migration never ran".
  await admin.query(`select set_config('app.is_platform_admin', 'true', false)`);

  const [platform] = (await admin.query(
    `select id from ${S}."client" where slug = $1`,
    [PLATFORM_CLIENT_SLUG],
  )) as { id: string }[];

  if (platform === undefined) {
    throw new Error(
      `No "${PLATFORM_CLIENT_SLUG}" client — run the migrations (0011 seeds the platform identity).`,
    );
  }

  const fixture: Fixture = {
    platformClientId: platform.id,
    clientId: randomUUID(),
    clientSlug: `s13-reg-${suffix}`,
    outsiderEmail: `outsider-${suffix}@example.test`,
  };

  await elevate(admin, fixture.clientId);
  await admin.query(
    `insert into ${S}."client" (id, name, slug, status) values ($1, $2, $3, 'active')`,
    [fixture.clientId, `Session 13 ${suffix}`, fixture.clientSlug],
  );

  const outsiderId = randomUUID();
  await admin.query(
    `insert into ${S}."user" (id, client_id, email, full_name, status, is_client_admin)
     values ($1, $2, $3, 'Session 13 Fixture', 'active', true)`,
    [outsiderId, fixture.clientId, fixture.outsiderEmail],
  );
  await admin.query(
    `insert into ${S}."user_identity" (client_id, user_id, provider, secret_hash)
     values ($1, $2, 'password', $3)`,
    [fixture.clientId, outsiderId, secretHash],
  );

  return fixture;
}

async function teardown(admin: DataSource, fixture: Fixture): Promise<void> {
  if (fixture === undefined) return;

  await elevate(admin, fixture.platformClientId);
  await admin.query(`delete from ${S}."application" where key like $1`, [`${KEY_PREFIX}%`]);
  await admin.query(`delete from ${S}."audit_trail" where action = any($1::text[])`, [
    [...REGISTRY_ACTIONS],
  ]);

  await elevate(admin, fixture.clientId);
  await admin.query(`delete from ${S}."session" where client_id = $1`, [fixture.clientId]);
  await admin.query(`delete from ${S}."user_identity" where client_id = $1`, [
    fixture.clientId,
  ]);
  await admin.query(`delete from ${S}."user" where client_id = $1`, [fixture.clientId]);
  await admin.query(`delete from ${S}."audit_trail" where client_id = $1`, [
    fixture.clientId,
  ]);
  await admin.query(`delete from ${S}."client" where id = $1`, [fixture.clientId]);
}
