/**
 * The Session 14 Definition of Done: **register → evolve → shrink**, over HTTP,
 * against a real Postgres (Doc 02 §2, §7).
 *
 * `manifest.spec.ts` pins what a manifest *is* and what a diff *says*; both are
 * properties of a document and a snapshot, and neither needs a database. This
 * suite exists for the three claims that cannot be checked against a fake:
 *
 * 1. **The rows are the same rows.** An evolve updates in place — same uuid,
 *    same `menu_permission`, same `role_permission` — and a shrink sets
 *    `is_active = false` rather than deleting. Ids captured before and compared
 *    after are the only honest way to say that.
 * 2. **A re-upload is genuinely a no-op**, down to `updated_at` and the audit
 *    trail: not "an update that happened to write the same values".
 * 3. **Nothing partial survives a refusal.**
 *
 *   docker compose up -d postgres
 *   npm run migration:run
 *   npx nx test @plantops/iam-api
 *
 * **Destructive within its own fixtures only** — everything it creates is keyed
 * `s14-…`, and it deletes only the catalog actions it wrote.
 *
 * ## On the transactional criterion
 *
 * "A mid-manifest validation failure changes nothing." Note *where* that holds:
 * `manifest.dto.ts` validates the whole document — keys, `requires`, nesting,
 * every field's shape — before the handler is entered, so a malformed manifest
 * is refused with nothing written and nothing to roll back. That is the case
 * this suite exercises, because it is the one a caller can reach. The
 * transaction underneath is the same one Session 12 proved coupling on: every
 * statement below runs on `entityManager()`, so a failure anywhere in the upsert
 * takes the whole of it — rows and audit records alike — with it (Doc 07 §5,
 * Doc 10 §3).
 */

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { loadEnv } from '@plantops/config';
import {
  IamErrorCode,
  type AccessTokenResponse,
  type ApplicationDTO,
  type ApplicationManifest,
  type IamErrorResponse,
  type ManifestNavNode,
  type ManifestUpsertResponse,
  type NavCatalogResponse,
  type NavNodeCatalogDTO,
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
import { createTestApplication } from '../testing/app-harness';

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

/** Every action a manifest upload can write — the set this suite may clean up. */
const CATALOG_ACTIONS = [
  AUDIT_ACTIONS.APPLICATION_CREATED,
  AUDIT_ACTIONS.APPLICATION_UPDATED,
  AUDIT_ACTIONS.APPLICATION_MANIFEST_UPSERTED,
  AUDIT_ACTIONS.APPLICATION_DEACTIVATED,
  AUDIT_ACTIONS.PERMISSION_CREATED,
  AUDIT_ACTIONS.PERMISSION_UPDATED,
  AUDIT_ACTIONS.PERMISSION_DEACTIVATED,
  AUDIT_ACTIONS.NAV_NODE_CREATED,
  AUDIT_ACTIONS.NAV_NODE_UPDATED,
  AUDIT_ACTIONS.NAV_NODE_DEACTIVATED,
  AUDIT_ACTIONS.MENU_PERMISSION_MAPPED,
  AUDIT_ACTIONS.MENU_PERMISSION_UNMAPPED,
] as const;

const KEY_PREFIX = 's14-';

interface Fixture {
  platformClientId: string;
  clientId: string;
  clientSlug: string;
  outsiderEmail: string;
}

describeWithDb(
  `manifest upsert (${configured ? 'live' : 'skipped: no DATABASE_URL'})`,
  () => {
    let app: INestApplication;
    let baseUrl: string;
    let admin: DataSource;
    let fixture: Fixture;
    let bootstrapSecret: string;
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

      app = createTestApplication(moduleRef);
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

    beforeEach(async () => {
      suffix = randomUUID().slice(0, 8);
      await elevate(admin, fixture.platformClientId);
      await admin.query(`delete from ${S}."application" where key like $1`, [
        `${KEY_PREFIX}%`,
      ]);
      await admin.query(`delete from ${S}."audit_trail" where action = any($1::text[])`, [
        [...CATALOG_ACTIONS],
      ]);
    });

    // ── the wire ──────────────────────────────────────────────────────────

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

    /** The application row every case in this suite hangs its manifest off. */
    const registeredApplication = async (token: string): Promise<ApplicationDTO> => {
      const response = await call(token, 'POST', '/iam/applications', {
        key: `${KEY_PREFIX}${suffix}`,
        name: 'Gate Pass',
      });
      expect(response.status).toBe(201);
      return (await response.json()) as ApplicationDTO;
    };

    /**
     * Doc 02 §2's example manifest, keyed to this run's application, in pieces.
     *
     * The evolve cases each differ from the baseline in one field and rebuild
     * the tree to say so, rather than patching a clone: a manifest is a document
     * an author *writes*, and the interesting thing about an evolution is what
     * the second document says, not which lines of the first it edited.
     */
    const moduleNode = (children: ManifestNavNode[]): ManifestNavNode => ({
      kind: 'module',
      key: 'gatepass',
      label: 'Gate Pass',
      icon: 'truck',
      children,
    });

    const createNode = (
      application: ApplicationDTO,
      overrides: Partial<ManifestNavNode> = {},
    ): ManifestNavNode => ({
      kind: 'menu',
      key: 'dc.create',
      label: 'New DC',
      route: '/gatepass/new',
      requires: [`${application.key}.dc.create`],
      ...overrides,
    });

    const approvalsNode = (
      application: ApplicationDTO,
      overrides: Partial<ManifestNavNode> = {},
    ): ManifestNavNode => ({
      kind: 'menu',
      key: 'dc.approvals',
      label: 'Approvals',
      route: '/gatepass/approvals',
      requires: [`${application.key}.dc.approve`],
      ...overrides,
    });

    const manifestWith = (
      application: ApplicationDTO,
      nav: ManifestNavNode[],
      overrides: Partial<ApplicationManifest> = {},
    ): ApplicationManifest => ({
      key: application.key,
      name: 'Gate Pass',
      permissions: [
        { key: `${application.key}.dc.create`, name: 'Create DC' },
        { key: `${application.key}.dc.approve`, name: 'Approve DC' },
        { key: `${application.key}.gate.verify`, name: 'Verify at gate' },
      ],
      nav,
      ...overrides,
    });

    /** The baseline every scenario starts from. */
    const manifestFor = (application: ApplicationDTO): ApplicationManifest =>
      manifestWith(application, [
        moduleNode([createNode(application), approvalsNode(application)]),
      ]);

    const upload = (
      token: string,
      id: string,
      manifest: unknown,
    ): Promise<Response> =>
      call(token, 'POST', `/iam/applications/${id}/manifest`, manifest);

    const uploaded = async (
      token: string,
      id: string,
      manifest: unknown,
    ): Promise<ManifestUpsertResponse> => {
      const response = await upload(token, id, manifest);
      expect(response.status).toBe(200);
      return (await response.json()) as ManifestUpsertResponse;
    };

    // ── inspection ────────────────────────────────────────────────────────

    const navTree = async (token: string, id: string): Promise<NavCatalogResponse> => {
      const response = await call(token, 'GET', `/iam/applications/${id}/nav`);
      expect(response.status).toBe(200);
      return (await response.json()) as NavCatalogResponse;
    };

    /** Every nav node of an application, flattened, by key. */
    const navByKey = async (
      token: string,
      id: string,
    ): Promise<Map<string, NavNodeCatalogDTO>> => {
      const flat = new Map<string, NavNodeCatalogDTO>();
      const visit = (nodes: readonly NavNodeCatalogDTO[]): void => {
        for (const node of nodes) {
          flat.set(node.key, node);
          visit(node.children);
        }
      };
      visit((await navTree(token, id)).tree);
      return flat;
    };

    const permissionsByKey = async (
      token: string,
      id: string,
    ): Promise<Map<string, PermissionDTO>> => {
      const response = await call(
        token,
        'GET',
        `/iam/applications/${id}/permissions?limit=100`,
      );
      expect(response.status).toBe(200);
      const page = (await response.json()) as Paginated<PermissionDTO>;
      return new Map(page.data.map((permission) => [permission.key, permission]));
    };

    const auditActions = async (): Promise<string[]> => {
      await elevate(admin, fixture.platformClientId);
      const rows = (await admin.query(
        `select action from ${S}."audit_trail"
          where action = any($1::text[])
          order by created_at asc, id asc`,
        [[...CATALOG_ACTIONS]],
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

    /** Row counts straight from the database — what the API's filters would hide. */
    const rowCount = async (table: string, applicationId: string): Promise<number> => {
      await elevate(admin, fixture.platformClientId);
      const rows = (await admin.query(
        `select count(*)::int as total from ${S}."${table}" where application_id = $1`,
        [applicationId],
      )) as { total: number }[];
      return rows[0]?.total ?? 0;
    };

    const menuPermissionCount = async (applicationId: string): Promise<number> => {
      await elevate(admin, fixture.platformClientId);
      const rows = (await admin.query(
        `select count(*)::int as total
           from ${S}."menu_permission" mp
           join ${S}."nav_node" n on n.id = mp.nav_node_id
          where n.application_id = $1`,
        [applicationId],
      )) as { total: number }[];
      return rows[0]?.total ?? 0;
    };

    // ── register ──────────────────────────────────────────────────────────

    describe('register — the first upload', () => {
      it('builds the whole catalog from one document', async () => {
        const token = await asPlatform();
        const application = await registeredApplication(token);

        const result = await uploaded(token, application.id, manifestFor(application));

        expect(result.changed).toBe(true);
        expect(result.diff.permissions.created).toHaveLength(3);
        expect(result.diff.nav.created).toEqual(['gatepass', 'dc.create', 'dc.approvals']);

        const tree = (await navTree(token, application.id)).tree;
        expect(tree).toHaveLength(1);
        expect(tree[0].key).toBe('gatepass');
        expect(tree[0].icon).toBe('truck');
        // Declaration order, not key order — `dc.approvals` would otherwise sort
        // first and Doc 02 §2's own example would render backwards.
        expect(tree[0].children.map((child) => child.key)).toEqual([
          'dc.create',
          'dc.approvals',
        ]);
        expect(tree[0].children[0].requires).toEqual([`${application.key}.dc.create`]);
        expect(tree[0].children[1].requires).toEqual([`${application.key}.dc.approve`]);
      });

      it('audits the summary and each row it created', async () => {
        const token = await asPlatform();
        const application = await registeredApplication(token);

        await uploaded(token, application.id, manifestFor(application));

        const actions = await auditActions();
        expect(actions).toContain(AUDIT_ACTIONS.APPLICATION_MANIFEST_UPSERTED);
        // The composed services write their own records: the manifest and the
        // form path produce the same trail because they run the same code.
        expect(
          actions.filter((action) => action === AUDIT_ACTIONS.PERMISSION_CREATED),
        ).toHaveLength(3);
        expect(
          actions.filter((action) => action === AUDIT_ACTIONS.NAV_NODE_CREATED),
        ).toHaveLength(3);

        const [summary] = await auditPayloads(
          AUDIT_ACTIONS.APPLICATION_MANIFEST_UPSERTED,
        );
        expect(summary['nav']).toEqual({
          created: ['gatepass', 'dc.create', 'dc.approvals'],
          updated: [],
          deactivated: [],
        });
        expect(summary['menu_permissions']).toEqual({
          mapped: [
            { nav_key: 'dc.create', permission_keys: [`${application.key}.dc.create`] },
            {
              nav_key: 'dc.approvals',
              permission_keys: [`${application.key}.dc.approve`],
            },
          ],
          unmapped: [],
        });
      });

      it('refuses a manifest addressed to a different application', async () => {
        const token = await asPlatform();
        const application = await registeredApplication(token);

        const response = await upload(token, application.id, {
          ...manifestFor(application),
          key: `${KEY_PREFIX}someone-else`,
        });

        // Applying one application's manifest to another would deactivate every
        // permission the target has and rebuild its menu as a copy — reported as
        // a successful upsert.
        expect(response.status).toBe(409);
        expect(await errorCodeOf(response)).toBe(IamErrorCode.CONFLICT);
        expect(await rowCount('permission', application.id)).toBe(0);
      });

      it('404s for an application that does not exist', async () => {
        const token = await asPlatform();
        const application = await registeredApplication(token);

        const response = await upload(
          token,
          randomUUID(),
          manifestFor(application),
        );

        expect(response.status).toBe(404);
      });
    });

    // ── idempotence ───────────────────────────────────────────────────────

    describe('re-upload — the idempotence criterion', () => {
      it('changes nothing, touches no row, and writes no audit record', async () => {
        const token = await asPlatform();
        const application = await registeredApplication(token);
        const manifest = manifestFor(application);
        await uploaded(token, application.id, manifest);

        const before = await updatedAts(admin, application.id);
        // The first upload's records are the noise this case is measuring
        // against, so clear them and let the second upload speak for itself.
        await elevate(admin, fixture.platformClientId);
        await admin.query(
          `delete from ${S}."audit_trail" where action = any($1::text[])`,
          [[...CATALOG_ACTIONS]],
        );

        const again = await uploaded(token, application.id, manifest);

        expect(again.changed).toBe(false);
        expect(again.diff.permissions).toEqual({
          created: [],
          updated: [],
          deactivated: [],
        });
        // `updated_at` is the honest witness: a `set name = <same name>` would
        // still fire the trigger, so an unchanged timestamp is the difference
        // between "no-op" and "an update that wrote the same values".
        expect(await updatedAts(admin, application.id)).toEqual(before);
        // A trail with one `application.manifest.upserted` per deploy is one in
        // which the deploy that changed the catalog is invisible.
        expect(await auditActions()).toEqual([]);
      });
    });

    // ── evolve ────────────────────────────────────────────────────────────

    describe('evolve — the same rows, changed', () => {
      it('updates labels and routes in place, keeping every id', async () => {
        const token = await asPlatform();
        const application = await registeredApplication(token);
        await uploaded(token, application.id, manifestFor(application));
        const before = await navByKey(token, application.id);

        const evolved = manifestWith(application, [
          moduleNode([
            createNode(application, { label: 'Raise a DC', route: '/gatepass/dc/new' }),
            approvalsNode(application),
          ]),
        ]);
        const result = await uploaded(token, application.id, evolved);

        expect(result.diff.nav.updated).toEqual(['dc.create']);
        expect(result.diff.nav.created).toEqual([]);

        const after = await navByKey(token, application.id);
        expect(after.get('dc.create')?.label).toBe('Raise a DC');
        expect(after.get('dc.create')?.route).toBe('/gatepass/dc/new');
        // The same row. Every `menu_permission` and `role_permission` pointing at
        // this uuid still points at the node the operator renamed.
        expect(after.get('dc.create')?.id).toBe(before.get('dc.create')?.id);
        expect(await rowCount('nav_node', application.id)).toBe(3);
      });

      it('adds new permissions and nodes without disturbing the rest', async () => {
        const token = await asPlatform();
        const application = await registeredApplication(token);
        await uploaded(token, application.id, manifestFor(application));
        const before = await navByKey(token, application.id);

        const evolved = manifestWith(application, [
          moduleNode([
            createNode(application),
            approvalsNode(application),
            {
              kind: 'menu',
              key: 'gate.verify',
              label: 'Gate',
              route: '/gatepass/gate',
              requires: [`${application.key}.gate.verify`],
            },
          ]),
        ]);
        const result = await uploaded(token, application.id, evolved);

        expect(result.diff.nav.created).toEqual(['gate.verify']);
        expect(result.diff.nav.updated).toEqual([]);
        expect(result.diff.menu_permissions.mapped).toEqual([
          { nav_key: 'gate.verify', permission_keys: [`${application.key}.gate.verify`] },
        ]);

        const after = await navByKey(token, application.id);
        expect(after.get('gatepass')?.id).toBe(before.get('gatepass')?.id);
        expect(after.get('gate.verify')?.requires).toEqual([
          `${application.key}.gate.verify`,
        ]);
      });

      it('re-parents a node rather than recreating it', async () => {
        const token = await asPlatform();
        const application = await registeredApplication(token);
        await uploaded(token, application.id, manifestFor(application));
        const before = await navByKey(token, application.id);

        const evolved = manifestWith(application, [
          moduleNode([createNode(application)]),
          approvalsNode(application, { kind: 'module' }),
        ]);
        const result = await uploaded(token, application.id, evolved);

        expect(result.diff.nav.updated).toEqual(['dc.approvals']);

        const tree = (await navTree(token, application.id)).tree;
        expect(tree.map((node) => node.key)).toEqual(['gatepass', 'dc.approvals']);
        expect((await navByKey(token, application.id)).get('dc.approvals')?.id).toBe(
          before.get('dc.approvals')?.id,
        );
      });

      it('re-gates a node, mapping and unmapping only the difference', async () => {
        const token = await asPlatform();
        const application = await registeredApplication(token);
        await uploaded(token, application.id, manifestFor(application));

        const evolved = manifestWith(application, [
          moduleNode([
            createNode(application, {
              requires: [`${application.key}.dc.create`, `${application.key}.dc.approve`],
            }),
            approvalsNode(application, { requires: [] }),
          ]),
        ]);
        const result = await uploaded(token, application.id, evolved);

        expect(result.diff.menu_permissions.mapped).toEqual([
          { nav_key: 'dc.create', permission_keys: [`${application.key}.dc.approve`] },
        ]);
        expect(result.diff.menu_permissions.unmapped).toEqual([
          { nav_key: 'dc.approvals', permission_keys: [`${application.key}.dc.approve`] },
        ]);

        const after = await navByKey(token, application.id);
        expect(after.get('dc.create')?.requires.sort()).toEqual(
          [`${application.key}.dc.approve`, `${application.key}.dc.create`].sort(),
        );
        // An unmapped leaf becomes invisible to everyone rather than visible to
        // everyone (Doc 05 §3) — the node itself is untouched.
        expect(after.get('dc.approvals')?.requires).toEqual([]);
        expect(after.get('dc.approvals')).toBeDefined();
      });

      it('records a permission relabel as a before/after', async () => {
        const token = await asPlatform();
        const application = await registeredApplication(token);
        await uploaded(token, application.id, manifestFor(application));

        const evolved = manifestWith(
          application,
          [moduleNode([createNode(application), approvalsNode(application)])],
          {
            permissions: [
              { key: `${application.key}.dc.create`, name: 'Raise a delivery challan' },
              { key: `${application.key}.dc.approve`, name: 'Approve DC' },
              { key: `${application.key}.gate.verify`, name: 'Verify at gate' },
            ],
          },
        );
        await uploaded(token, application.id, evolved);

        expect(await auditPayloads(AUDIT_ACTIONS.PERMISSION_UPDATED)).toContainEqual(
          expect.objectContaining({
            key: `${application.key}.dc.create`,
            changed: ['name'],
            before: { name: 'Create DC' },
            after: { name: 'Raise a delivery challan' },
          }),
        );
      });

      it('renames the application itself when the manifest does', async () => {
        const token = await asPlatform();
        const application = await registeredApplication(token);
        await uploaded(token, application.id, manifestFor(application));

        const result = await uploaded(token, application.id, {
          ...manifestFor(application),
          name: 'Gate Pass v2',
        });

        expect(result.diff.application.changed).toEqual(['name']);
        // Through `ApplicationsService.update`, so it is audited as the
        // `application.updated` it is — the manifest owns the row, not just the
        // catalog hanging off it.
        expect(await auditPayloads(AUDIT_ACTIONS.APPLICATION_UPDATED)).toContainEqual(
          expect.objectContaining({ changed: ['name'] }),
        );
      });
    });

    // ── shrink ────────────────────────────────────────────────────────────

    describe('shrink — removal is deactivation', () => {
      const shrunk = (application: ApplicationDTO): ApplicationManifest => ({
        key: application.key,
        name: 'Gate Pass',
        permissions: [{ key: `${application.key}.dc.create`, name: 'Create DC' }],
        nav: [
          {
            kind: 'module',
            key: 'gatepass',
            label: 'Gate Pass',
            icon: 'truck',
            children: [
              {
                kind: 'menu',
                key: 'dc.create',
                label: 'New DC',
                route: '/gatepass/new',
                requires: [`${application.key}.dc.create`],
              },
            ],
          },
        ],
      });

      it('deactivates what the manifest stopped mentioning and deletes nothing', async () => {
        const token = await asPlatform();
        const application = await registeredApplication(token);
        await uploaded(token, application.id, manifestFor(application));
        const mappingsBefore = await menuPermissionCount(application.id);

        const result = await uploaded(token, application.id, shrunk(application));

        expect(result.diff.permissions.deactivated.sort()).toEqual([
          `${application.key}.dc.approve`,
          `${application.key}.gate.verify`,
        ]);
        expect(result.diff.nav.deactivated).toEqual(['dc.approvals']);

        // Every row is still there — `role_permission` and audit payloads still
        // name these keys (Doc 02 §7).
        expect(await rowCount('permission', application.id)).toBe(3);
        expect(await rowCount('nav_node', application.id)).toBe(3);
        // Including the gate of the node that went: it is inert while the node
        // is inactive, and keeping it is what makes a key that comes back come
        // back gated as it was.
        expect(await menuPermissionCount(application.id)).toBe(mappingsBefore);

        const permissions = await permissionsByKey(token, application.id);
        expect(permissions.get(`${application.key}.dc.approve`)?.is_active).toBe(false);
        expect(permissions.get(`${application.key}.dc.create`)?.is_active).toBe(true);

        const nav = await navByKey(token, application.id);
        expect(nav.get('dc.approvals')?.is_active).toBe(false);
      });

      it('audits each retirement under its own action', async () => {
        const token = await asPlatform();
        const application = await registeredApplication(token);
        await uploaded(token, application.id, manifestFor(application));
        await uploaded(token, application.id, shrunk(application));

        const actions = await auditActions();
        // "When did this permission go away" has to be answerable by an action
        // filter, not only by reading a manifest summary.
        expect(
          actions.filter((action) => action === AUDIT_ACTIONS.PERMISSION_DEACTIVATED),
        ).toHaveLength(2);
        expect(actions).toContain(AUDIT_ACTIONS.NAV_NODE_DEACTIVATED);
      });

      it('brings a key back as the row it was, not a new one', async () => {
        const token = await asPlatform();
        const application = await registeredApplication(token);
        await uploaded(token, application.id, manifestFor(application));
        const before = await navByKey(token, application.id);
        const permissionsBefore = await permissionsByKey(token, application.id);

        await uploaded(token, application.id, shrunk(application));
        const result = await uploaded(token, application.id, manifestFor(application));

        expect(result.diff.nav.created).toEqual([]);
        expect(result.diff.nav.updated).toEqual(['dc.approvals']);
        expect(result.diff.permissions.created).toEqual([]);

        const after = await navByKey(token, application.id);
        expect(after.get('dc.approvals')?.id).toBe(before.get('dc.approvals')?.id);
        expect(after.get('dc.approvals')?.is_active).toBe(true);
        // And still gated, because the shrink never dropped the mapping.
        expect(after.get('dc.approvals')?.requires).toEqual([
          `${application.key}.dc.approve`,
        ]);
        expect(
          (await permissionsByKey(token, application.id)).get(
            `${application.key}.dc.approve`,
          )?.id,
        ).toBe(permissionsBefore.get(`${application.key}.dc.approve`)?.id);
      });

      it('accepts a manifest that declares nothing at all', async () => {
        const token = await asPlatform();
        const application = await registeredApplication(token);
        await uploaded(token, application.id, manifestFor(application));

        const result = await uploaded(token, application.id, {
          key: application.key,
          name: 'Gate Pass',
          permissions: [],
          nav: [],
        });

        expect(result.diff.permissions.deactivated).toHaveLength(3);
        expect(result.diff.nav.deactivated.sort()).toEqual([
          'dc.approvals',
          'dc.create',
          'gatepass',
        ]);
        expect(await rowCount('nav_node', application.id)).toBe(3);
      });
    });

    // ── nothing partial ───────────────────────────────────────────────────

    describe('a refused manifest changes nothing', () => {
      it('rejects the document before any statement runs', async () => {
        const token = await asPlatform();
        const application = await registeredApplication(token);
        await uploaded(token, application.id, manifestFor(application));

        // Valid up to the last node, which points off-site. Everything before it
        // — a rename, a new permission, a new menu — would be a real change.
        const broken = manifestWith(
          application,
          [
            moduleNode([
              createNode(application),
              approvalsNode(application),
              {
                kind: 'menu',
                key: 'evil',
                label: 'Evil',
                route: 'https://example.test/steal',
              },
            ]),
          ],
          {
            name: 'Gate Pass v2',
            permissions: [
              { key: `${application.key}.dc.create`, name: 'Create DC' },
              { key: `${application.key}.dc.approve`, name: 'Approve DC' },
              { key: `${application.key}.gate.verify`, name: 'Verify at gate' },
              { key: `${application.key}.dc.void`, name: 'Void DC' },
            ],
          },
        );

        const response = await upload(token, application.id, broken);

        expect(response.status).toBe(400);
        expect(await errorCodeOf(response)).toBe(IamErrorCode.VALIDATION_FAILED);
        expect(await rowCount('permission', application.id)).toBe(3);
        expect(await rowCount('nav_node', application.id)).toBe(3);

        const unchanged = await call(token, 'GET', '/iam/applications?limit=100');
        const page = (await unchanged.json()) as Paginated<ApplicationDTO>;
        expect(page.data.find((row) => row.id === application.id)?.name).toBe('Gate Pass');
      });

      it('names the path in the document that failed', async () => {
        const token = await asPlatform();
        const application = await registeredApplication(token);

        const broken = manifestWith(application, [
          moduleNode([
            createNode(application, { requires: ['not.declared.anywhere'] }),
            approvalsNode(application),
          ]),
        ]);

        const response = await upload(token, application.id, broken);
        const body = (await response.json()) as IamErrorResponse;

        expect(response.status).toBe(400);
        expect(body.error.details?.[0].field).toBe('nav[0].children[0].requires[0]');
      });

      it('refuses a non-platform subject with a 403, having written nothing', async () => {
        const platform = await asPlatform();
        const application = await registeredApplication(platform);
        const outsider = await asOutsider();

        const response = await upload(outsider, application.id, manifestFor(application));

        expect(response.status).toBe(403);
        expect(await errorCodeOf(response)).toBe(IamErrorCode.PERMISSION_DENIED);
        expect(await rowCount('permission', application.id)).toBe(0);
      });
    });

    const errorCodeOf = async (response: Response): Promise<string> =>
      ((await response.json()) as IamErrorResponse).error.code;
  },
);

/** `updated_at` of every catalog row, so a no-op can be shown to be one. */
async function updatedAts(
  admin: DataSource,
  applicationId: string,
): Promise<Record<string, string>> {
  const rows = (await admin.query(
    `select 'permission:' || key as row_key, updated_at from ${S}."permission"
      where application_id = $1
     union all
     select 'nav:' || key as row_key, updated_at from ${S}."nav_node"
      where application_id = $1
     order by row_key asc`,
    [applicationId],
  )) as { row_key: string; updated_at: Date }[];

  return Object.fromEntries(
    rows.map((row) => [row.row_key, row.updated_at.toISOString()]),
  );
}

/** Platform context on the admin connection, so fixtures can be read and written. */
async function elevate(admin: DataSource, clientId: string): Promise<void> {
  await admin.query(`select set_config('app.is_platform_admin', 'true', false)`);
  await admin.query(`select set_config('app.current_client_id', $1, false)`, [clientId]);
}

/** One ordinary tenant with one client admin — see `registry.integration.spec.ts`. */
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
    clientId: randomUUID(),
    clientSlug: `s14-man-${suffix}`,
    outsiderEmail: `outsider-s14-${suffix}@example.test`,
  };

  await elevate(admin, fixture.clientId);
  await admin.query(
    `insert into ${S}."client" (id, name, slug, status) values ($1, $2, $3, 'active')`,
    [fixture.clientId, `Session 14 ${suffix}`, fixture.clientSlug],
  );

  const outsiderId = randomUUID();
  await admin.query(
    `insert into ${S}."user" (id, client_id, email, full_name, status, is_client_admin)
     values ($1, $2, $3, 'Session 14 Fixture', 'active', true)`,
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
    [...CATALOG_ACTIONS],
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
