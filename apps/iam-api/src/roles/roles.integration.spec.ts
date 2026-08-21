/**
 * The Session 17 Definition of Done: **the role lifecycle over HTTP, including
 * enabled-app validation and the RLS negative cases** (Doc 06 §7, Doc 02 §6,
 * Doc 07 §6).
 *
 * Every claim this session makes is a claim about Postgres. That `unique
 * (client_id, name)` lets two tenants each own a role called "Gate Supervisor";
 * that a permission from an application nobody enabled cannot be mapped, and
 * that the refusal leaves *nothing* behind; that a mapping already made survives
 * its application being disabled underneath it (Doc 02 §7) while a new one in the
 * same state is refused (Doc 02 §6); that deleting a role cascades its bindings
 * and that the audit for each of them was written before the rows went; and that
 * another tenant's role is a 404 rather than a 403. A fake database can express
 * none of them, so this suite runs against a real one:
 *
 *   pg_ctl start                # a local Postgres 17 (see .env)
 *   npm run migration:run
 *   npx nx test @plantops/iam-api
 *
 * **Destructive within its own fixtures only.** Every client it creates is
 * slugged `s17-…` and every application it registers is keyed `s17-…`; both are
 * removed afterwards with the rows that hang off them.
 *
 * ## The caller is a tenant's own client admin
 *
 * A client-tier surface (Doc 06 §7): the subject is a user of the tenant, logged
 * in at `POST /auth/login`, and the tenant comes from that token's `cid`. The
 * second tenant exists precisely so "another client's role is invisible" is
 * tested rather than assumed.
 *
 * ## The catalog is seeded directly, and deliberately not through its own API
 *
 * Four applications, each standing for one state a permission's owner can be in:
 * enabled for the tenant, disabled for the tenant, never enabled at all, and
 * deactivated platform-wide. The last two cannot both be produced through
 * Session 13–15's endpoints — enabling a deactivated application is itself a 409
 * — and the state that matters here (an application deactivated *after* a tenant
 * was given it) is reached by time passing, not by a call. Seeding the rows says
 * what is being tested; a five-call setup would say it less clearly and would
 * make this suite fail when those endpoints change.
 *
 * ## Deliberate deviations from the shipped configuration
 *
 * - **Rate limiting is off.** These cases make dozens of calls against a surface
 *   bounded at sixty a minute.
 * - **Nothing else.** The interim permission rule, the validation pipe, the RLS
 *   context and the audit path are the shipped ones.
 */

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { loadEnv } from '@plantops/config';
import {
  IamErrorCode,
  type IamErrorResponse,
  type Paginated,
  type PermissionCatalogResponse,
  type RoleDTO,
  type RolePermissionsResponse,
  type TokenPairResponse,
} from '@plantops/contracts';
import {
  IAM_SCHEMA,
  IAM_SCHEMA_TEST_LOCK_ID,
  createMigrationDataSource,
  hashSecret,
  scopePathLabel,
} from '@plantops/db';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { DataSource } from 'typeorm';
import { AppModule } from '../app/app.module';
import { AUDIT_ACTIONS } from '../audit/audit-actions';
import { ENV } from '../config/env.token';
import { createTestApplication } from '../testing/app-harness';
import {
  grantIamClientAdmin,
  IAM_ADMIN_ROLE_NAME,
} from '../testing/authorization.fixture';

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

/** Everything this suite creates carries this prefix — tenants and catalog alike. */
const PREFIX = 's17-';

/** The name the tenant's seeded system role carries, as Session 15 spells it. */
const SYSTEM_ROLE_NAME = 'Client Admin';

/** One tenant, with the identities and the org root the cases need. */
interface Tenant {
  clientId: string;
  slug: string;
  /** `is_client_admin` — the caller for almost every case. */
  adminEmail: string;
  adminUserId: string;
  /** An ordinary user: the interim authorization must refuse one, and a binding needs a subject. */
  memberEmail: string;
  memberUserId: string;
  /** The org root, so a binding has somewhere to hang. */
  scopeNodeId: string;
  /** Re-seeded before every case, because the reset deletes every role. */
  systemRoleId: string;
}

/**
 * The four applications and their permissions.
 *
 * `gatepass` is the ordinary case. The other three are the three ways a
 * permission can be unmappable, one application each, so a failing assertion
 * names the rule it broke.
 */
interface Catalog {
  /** Enabled for Acme. Two live permissions and one retired one. */
  gatepassId: string;
  approveId: string;
  createId: string;
  retiredId: string;
  /** Enabled for Acme, then toggled off — `client_application.enabled = false`. */
  weighbridgeId: string;
  weighId: string;
  /** Never enabled for anyone: no `client_application` row at all. */
  visitorId: string;
  visitId: string;
  /** Enabled for Acme, but `application.is_active = false` platform-wide. */
  legacyId: string;
  legacyDoId: string;
}

interface Fixture {
  acme: Tenant;
  other: Tenant;
  catalog: Catalog;
}

describeWithDb(
  `role APIs (${configured ? 'live' : 'skipped: no DATABASE_URL'})`,
  () => {
    let app: INestApplication;
    let baseUrl: string;
    let admin: DataSource;
    let fixture: Fixture;

    jest.setTimeout(180_000);

    beforeAll(async () => {
      const env = loadEnv();

      admin = createMigrationDataSource(env);
      await admin.initialize();
      await admin.query('select pg_advisory_lock($1)', [IAM_SCHEMA_TEST_LOCK_ID]);
      await purge(admin);

      const secretHash = await hashSecret(PASSWORD);
      const catalog = await seedCatalog(admin);
      fixture = {
        acme: await seedTenant(admin, 'acme', secretHash),
        other: await seedTenant(admin, 'other', secretHash),
        catalog,
      };

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
      // A clean role space and a canonical enablement state before every case.
      // The tenants and the catalog themselves are seeded once: logging in is
      // the slowest thing here (argon2id, by design).
      for (const tenant of [fixture.acme, fixture.other]) {
        await resetTenant(admin, tenant, fixture.catalog);
      }
    });

    // ── the wire ──────────────────────────────────────────────────────────

    const login = async (email: string, slug: string): Promise<string> => {
      const response = await fetch(`${baseUrl}/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, password: PASSWORD, client_slug: slug }),
      });
      expect(response.status).toBe(200);
      return ((await response.json()) as TokenPairResponse).access_token;
    };

    const asAdmin = (tenant: Tenant = fixture.acme) =>
      login(tenant.adminEmail, tenant.slug);

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

    const errorOf = async (response: Response) =>
      ((await response.json()) as IamErrorResponse).error;

    /** Creates a role and asserts the 201, returning the DTO. */
    const createRole = async (
      token: string,
      body: Record<string, unknown>,
    ): Promise<RoleDTO> => {
      const response = await call(token, 'POST', '/iam/roles', body);
      expect(response.status).toBe(201);
      return (await response.json()) as RoleDTO;
    };

    /** Sets a role's permissions and asserts the 200, returning the mapping. */
    const setPermissions = async (
      token: string,
      roleId: string,
      permissionIds: readonly string[],
    ): Promise<RolePermissionsResponse> => {
      const response = await call(token, 'PUT', `/iam/roles/${roleId}/permissions`, {
        permission_ids: permissionIds,
      });
      expect(response.status).toBe(200);
      return (await response.json()) as RolePermissionsResponse;
    };

    // ── inspection, through the owner connection ──────────────────────────

    const mappedIds = async (tenant: Tenant, roleId: string): Promise<string[]> => {
      await elevate(admin, tenant.clientId);
      const rows = (await admin.query(
        `select permission_id from ${S}."role_permission" where role_id = $1
          order by permission_id`,
        [roleId],
      )) as { permission_id: string }[];
      return rows.map((row) => row.permission_id);
    };

    const bindingIds = async (tenant: Tenant, roleId: string): Promise<string[]> => {
      await elevate(admin, tenant.clientId);
      const rows = (await admin.query(
        `select id from ${S}."role_binding" where client_id = $1 and role_id = $2`,
        [tenant.clientId, roleId],
      )) as { id: string }[];
      return rows.map((row) => row.id);
    };

    const roleExists = async (tenant: Tenant, roleId: string): Promise<boolean> => {
      await elevate(admin, tenant.clientId);
      const rows = (await admin.query(
        `select 1 from ${S}."role" where client_id = $1 and id = $2`,
        [tenant.clientId, roleId],
      )) as unknown[];
      return rows.length > 0;
    };

    const auditFor = async (
      tenant: Tenant,
      action: string,
    ): Promise<Record<string, unknown>[]> => {
      await elevate(admin, tenant.clientId);
      const rows = (await admin.query(
        `select payload from ${S}."audit_trail"
          where client_id = $1 and action = $2
          order by created_at asc, id asc`,
        [tenant.clientId, action],
      )) as { payload: Record<string, unknown> }[];
      return rows.map((row) => row.payload);
    };

    /** What the tenant's records of `action` point at. */
    const auditTargets = async (tenant: Tenant, action: string): Promise<string[]> => {
      await elevate(admin, tenant.clientId);
      const rows = (await admin.query(
        `select target_id from ${S}."audit_trail"
          where client_id = $1 and action = $2
          order by target_id asc`,
        [tenant.clientId, action],
      )) as { target_id: string }[];
      return rows.map((row) => row.target_id);
    };

    // ── the role itself ───────────────────────────────────────────────────

    describe('creating and listing', () => {
      it('creates a role in the caller`s own tenant and reports the list columns', async () => {
        const token = await asAdmin();

        const role = await createRole(token, {
          name: 'Gate Supervisor',
          description: 'Approves delivery challans at the gate',
        });

        // The tenant is the token's, never a field of the request.
        expect(role.client_id).toBe(fixture.acme.clientId);
        expect(role.is_system).toBe(false);
        expect(role.permission_count).toBe(0);
        expect(role.bound_subject_count).toBe(0);

        const listed = await call(token, 'GET', '/iam/roles');
        expect(listed.status).toBe(200);
        const body = (await listed.json()) as Paginated<RoleDTO>;

        // Alphabetical, and both seeded system roles are in the list: they are
        // roles the tenant has, and hiding them would make this disagree with
        // the picker every binding screen uses. `Fixture IAM Admin` is the one
        // carrying the `iam.client.*` permissions this very call was authorized
        // by (`testing/authorization.fixture.ts`).
        expect(body.data.map((entry) => entry.name)).toEqual([
          SYSTEM_ROLE_NAME,
          IAM_ADMIN_ROLE_NAME,
          'Gate Supervisor',
        ]);
        expect(body.total).toBe(3);

        const [record] = await auditFor(fixture.acme, AUDIT_ACTIONS.ROLE_CREATED);
        expect(record).toMatchObject({ name: 'Gate Supervisor', is_system: false });
      });

      it('counts mapped permissions and distinct bound subjects', async () => {
        const token = await asAdmin();
        const role = await createRole(token, { name: 'Gate Supervisor' });
        const { approveId, createId } = fixture.catalog;

        await setPermissions(token, role.id, [approveId, createId]);
        // The same user, bound twice — at the root and at a child. One person
        // holds this role, which is what Doc 09 §3.2's column means.
        const child = await insertScopeNode(admin, fixture.acme, 'Plant B');
        await insertBinding(admin, fixture.acme, role.id, fixture.acme.scopeNodeId);
        await insertBinding(admin, fixture.acme, role.id, child);

        const listed = await call(token, 'GET', '/iam/roles');
        const body = (await listed.json()) as Paginated<RoleDTO>;
        const found = body.data.find((entry) => entry.id === role.id) as RoleDTO;

        expect(found.permission_count).toBe(2);
        expect(found.bound_subject_count).toBe(1);
      });

      it('refuses a duplicate name inside one client, and permits it across two', async () => {
        const token = await asAdmin();
        await createRole(token, { name: 'Gate Supervisor' });

        const duplicate = await call(token, 'POST', '/iam/roles', {
          name: 'Gate Supervisor',
        });
        expect(duplicate.status).toBe(409);
        const error = await errorOf(duplicate);
        expect(error.code).toBe(IamErrorCode.CONFLICT);
        expect(error.message).toContain('Gate Supervisor');

        // `unique (client_id, name)`, not `unique (name)`: two organisations may
        // each have a role by that name and neither learns of the other.
        const otherToken = await asAdmin(fixture.other);
        const theirs = await createRole(otherToken, { name: 'Gate Supervisor' });
        expect(theirs.client_id).toBe(fixture.other.clientId);
      });
    });

    describe('renaming', () => {
      it('renames, and audits the before and after', async () => {
        const token = await asAdmin();
        const role = await createRole(token, {
          name: 'Gate Supervisor',
          description: 'Approves DCs',
        });

        const response = await call(token, 'PATCH', `/iam/roles/${role.id}`, {
          name: 'Shift Supervisor',
        });
        expect(response.status).toBe(200);
        const updated = (await response.json()) as RoleDTO;

        expect(updated.name).toBe('Shift Supervisor');
        expect(updated.description).toBe('Approves DCs');

        const [record] = await auditFor(fixture.acme, AUDIT_ACTIONS.ROLE_UPDATED);
        expect(record).toMatchObject({
          name: 'Shift Supervisor',
          changed: ['name'],
          before: { name: 'Gate Supervisor' },
          after: { name: 'Shift Supervisor' },
        });
      });

      it('audits nothing when the body is resubmitted unchanged', async () => {
        const token = await asAdmin();
        const role = await createRole(token, {
          name: 'Gate Supervisor',
          description: 'Approves DCs',
        });

        const response = await call(token, 'PATCH', `/iam/roles/${role.id}`, {
          name: 'Gate Supervisor',
          description: 'Approves DCs',
        });

        expect(response.status).toBe(200);
        expect(await auditFor(fixture.acme, AUDIT_ACTIONS.ROLE_UPDATED)).toEqual([]);
      });

      it('refuses a name another role of the same client already holds', async () => {
        const token = await asAdmin();
        await createRole(token, { name: 'Gate Supervisor' });
        const second = await createRole(token, { name: 'Weighbridge Operator' });

        const response = await call(token, 'PATCH', `/iam/roles/${second.id}`, {
          name: 'Gate Supervisor',
        });

        expect(response.status).toBe(409);
      });

      it('refuses to rename the system role', async () => {
        const token = await asAdmin();

        const response = await call(
          token,
          'PATCH',
          `/iam/roles/${fixture.acme.systemRoleId}`,
          { name: 'Something Else' },
        );

        expect(response.status).toBe(409);
        // A 409, not a 403: the caller may administer roles — this one simply is
        // not theirs to restructure.
        const error = await errorOf(response);
        expect(error.code).toBe(IamErrorCode.CONFLICT);
        expect(error.message).toContain('system role');
      });
    });

    // ── the rule this session exists for (Doc 02 §6) ──────────────────────

    /**
     * The picker's source (Doc 09 §3.2), and the reason it exists: a tenant
     * administrator cannot read the catalog — that is `iam.platform.permission.read`
     * — so without this endpoint the only permissions a role editor could offer
     * are the ones the role already has.
     *
     * What is under test is that the offered set is exactly the mappable set.
     * All four ways a permission is not mappable exist in this suite's fixture,
     * and each of them is a 409 from `setPermissions`: offering a row the save
     * would refuse is the failure this endpoint exists to prevent.
     */
    describe('the permission catalog', () => {
      const catalogOf = async (token: string): Promise<PermissionCatalogResponse> => {
        const response = await call(token, 'GET', '/iam/roles/permission-catalog');
        expect(response.status).toBe(200);
        return (await response.json()) as PermissionCatalogResponse;
      };

      it('offers the enabled application’s live permissions', async () => {
        const catalog = await catalogOf(await asAdmin());

        expect(catalog.client_id).toBe(fixture.acme.clientId);
        expect(catalog.permissions.map((entry) => entry.key)).toEqual(
          expect.arrayContaining([
            `${PREFIX}gatepass.dc.approve`,
            `${PREFIX}gatepass.dc.create`,
          ]),
        );
        expect(
          catalog.permissions.find((entry) => entry.id === fixture.catalog.createId),
        ).toMatchObject({
          application_id: fixture.catalog.gatepassId,
          application_key: `${PREFIX}gatepass`,
          is_active: true,
          application_enabled: true,
        });
      });

      it('offers nothing the save would refuse', async () => {
        const catalog = await catalogOf(await asAdmin());
        const offered = new Set(catalog.permissions.map((entry) => entry.id));

        // Retired by a later manifest upload — `permission.is_active = false`.
        expect(offered.has(fixture.catalog.retiredId)).toBe(false);
        // Enabled for Acme once, since toggled off — `client_application.enabled`.
        expect(offered.has(fixture.catalog.weighId)).toBe(false);
        // Never enabled for anyone — no `client_application` row at all.
        expect(offered.has(fixture.catalog.visitId)).toBe(false);
        // Deactivated platform-wide — `application.is_active = false`.
        expect(offered.has(fixture.catalog.legacyDoId)).toBe(false);
      });

      it('offers exactly what a save then accepts', async () => {
        // The property the picker rests on, checked rather than assumed: every
        // id offered maps in one call, so a 409 from a save is a real conflict
        // rather than the ordinary result of choosing a row that was on screen.
        const token = await asAdmin();
        const catalog = await catalogOf(token);
        const role = await createRole(token, { name: 'Everything' });

        const mapping = await setPermissions(
          token,
          role.id,
          catalog.permissions.map((entry) => entry.id),
        );

        expect(mapping.permissions.map((entry) => entry.id).sort()).toEqual(
          catalog.permissions.map((entry) => entry.id).sort(),
        );
      });

      it('follows the caller’s own enablement, not the catalog’s', async () => {
        // The two tenants share a platform catalog and differ only in what they
        // have switched on, which is the whole of what this endpoint filters by.
        // `beforeEach` restores the canonical enablement, so the toggle is local
        // to this case.
        await toggleApplication(admin, fixture.other, fixture.catalog.gatepassId, false);

        const acme = await catalogOf(await asAdmin());
        const other = await catalogOf(await asAdmin(fixture.other));

        expect(other.client_id).toBe(fixture.other.clientId);
        expect(acme.permissions.map((entry) => entry.key)).toContain(
          `${PREFIX}gatepass.dc.create`,
        );
        expect(other.permissions.map((entry) => entry.key)).not.toContain(
          `${PREFIX}gatepass.dc.create`,
        );
      });

      it('refuses a subject without the permission-read grant', async () => {
        const member = await login(fixture.acme.memberEmail, fixture.acme.slug);

        const response = await call(member, 'GET', '/iam/roles/permission-catalog');

        expect(response.status).toBe(403);
      });
    });

    describe('mapping permissions', () => {
      it('maps permissions from an enabled application, grouped for the picker', async () => {
        const token = await asAdmin();
        const role = await createRole(token, { name: 'Gate Supervisor' });
        const { approveId, createId } = fixture.catalog;

        const mapping = await setPermissions(token, role.id, [createId, approveId]);

        expect(mapping.role_id).toBe(role.id);
        // Ordered by application key then permission key, whatever order the
        // request listed them in — the order Doc 09 §3.2's picker groups by.
        expect(mapping.permissions.map((entry) => entry.key)).toEqual([
          `${PREFIX}gatepass.dc.approve`,
          `${PREFIX}gatepass.dc.create`,
        ]);
        expect(mapping.permissions[0]).toMatchObject({
          id: approveId,
          application_id: fixture.catalog.gatepassId,
          application_key: `${PREFIX}gatepass`,
          is_active: true,
          application_enabled: true,
        });

        // And the same answer through the read endpoint.
        const read = await call(token, 'GET', `/iam/roles/${role.id}/permissions`);
        expect(read.status).toBe(200);
        expect((await read.json()) as RolePermissionsResponse).toEqual(mapping);

        const [record] = await auditFor(fixture.acme, AUDIT_ACTIONS.ROLE_PERMISSION_SET);
        expect(record).toMatchObject({
          role_name: 'Gate Supervisor',
          added: [`${PREFIX}gatepass.dc.approve`, `${PREFIX}gatepass.dc.create`],
          removed: [],
          total: 2,
        });
      });

      it('replaces the set, and audits only the diff', async () => {
        const token = await asAdmin();
        const role = await createRole(token, { name: 'Gate Supervisor' });
        const { approveId, createId, weighId } = fixture.catalog;

        await setPermissions(token, role.id, [approveId, createId]);
        // The weighbridge app is disabled for Acme, so this set is deliberately
        // all-gatepass: what is under test is the replacement, not the guard.
        expect(weighId).toBeDefined();

        const mapping = await setPermissions(token, role.id, [createId]);

        expect(mapping.permissions.map((entry) => entry.id)).toEqual([createId]);
        expect(await mappedIds(fixture.acme, role.id)).toEqual([createId]);

        const [, second] = await auditFor(fixture.acme, AUDIT_ACTIONS.ROLE_PERMISSION_SET);
        expect(second).toMatchObject({
          added: [],
          removed: [`${PREFIX}gatepass.dc.approve`],
          total: 1,
        });
      });

      it('clears the set with an empty array', async () => {
        const token = await asAdmin();
        const role = await createRole(token, { name: 'Gate Supervisor' });
        await setPermissions(token, role.id, [fixture.catalog.approveId]);

        const mapping = await setPermissions(token, role.id, []);

        expect(mapping.permissions).toEqual([]);
        expect(await mappedIds(fixture.acme, role.id)).toEqual([]);
      });

      it('writes nothing and audits nothing when the same set is resubmitted', async () => {
        const token = await asAdmin();
        const role = await createRole(token, { name: 'Gate Supervisor' });
        const { approveId, createId } = fixture.catalog;

        await setPermissions(token, role.id, [approveId, createId]);
        await setPermissions(token, role.id, [createId, approveId]);

        // One record, from the first call. A trail that logged "set" every time
        // a picker was saved unchanged is one nobody can read.
        expect(await auditFor(fixture.acme, AUDIT_ACTIONS.ROLE_PERMISSION_SET)).toHaveLength(
          1,
        );
      });

      it.each([
        [
          'an application that was never enabled for this client',
          () => fixture.catalog.visitId,
          'not enabled for this client',
        ],
        [
          'an application currently disabled for this client',
          () => fixture.catalog.weighId,
          'not enabled for this client',
        ],
        [
          'an application deactivated platform-wide',
          () => fixture.catalog.legacyDoId,
          'deactivated platform-wide',
        ],
        [
          'a permission retired from its own catalog',
          () => fixture.catalog.retiredId,
          'retired',
        ],
      ])('refuses a permission from %s, without a partial write', async (
        _case,
        permissionId,
        expected,
      ) => {
        const token = await asAdmin();
        const role = await createRole(token, { name: 'Gate Supervisor' });
        const { approveId } = fixture.catalog;

        const response = await call(token, 'PUT', `/iam/roles/${role.id}/permissions`, {
          permission_ids: [approveId, permissionId()],
        });

        expect(response.status).toBe(409);
        const error = await errorOf(response);
        expect(error.code).toBe(IamErrorCode.CONFLICT);
        expect(error.message).toContain(expected);

        // The acceptance criterion, and the reason validation runs before the
        // first write: the legitimate half of the body did not land either.
        expect(await mappedIds(fixture.acme, role.id)).toEqual([]);
        expect(await auditFor(fixture.acme, AUDIT_ACTIONS.ROLE_PERMISSION_SET)).toEqual([]);
      });

      it('refuses a permission id that names nothing at all', async () => {
        const token = await asAdmin();
        const role = await createRole(token, { name: 'Gate Supervisor' });

        const response = await call(token, 'PUT', `/iam/roles/${role.id}/permissions`, {
          permission_ids: [randomUUID()],
        });

        expect(response.status).toBe(409);
        expect((await errorOf(response)).message).toContain('catalog');
      });

      it('keeps an existing mapping when its application is disabled underneath it', async () => {
        const token = await asAdmin();
        const role = await createRole(token, { name: 'Gate Supervisor' });
        const { approveId, createId, gatepassId } = fixture.catalog;

        await setPermissions(token, role.id, [approveId]);
        await toggleApplication(admin, fixture.acme, gatepassId, false);

        // Doc 02 §7: disabling preserves the mapping, inert. The response says so
        // rather than dropping the row, which would report the role as smaller
        // than it is.
        const read = await call(token, 'GET', `/iam/roles/${role.id}/permissions`);
        const mapping = (await read.json()) as RolePermissionsResponse;
        expect(mapping.permissions).toHaveLength(1);
        expect(mapping.permissions[0]).toMatchObject({
          id: approveId,
          application_enabled: false,
        });

        // Retaining it is legal; the alternative would silently strip exactly
        // what Doc 02 §7 promises to keep on the tenant's next role edit.
        const retained = await setPermissions(token, role.id, [approveId]);
        expect(retained.permissions.map((entry) => entry.id)).toEqual([approveId]);

        // Adding a *new* one from the same disabled application is the Doc 02 §6
        // refusal.
        const added = await call(token, 'PUT', `/iam/roles/${role.id}/permissions`, {
          permission_ids: [approveId, createId],
        });
        expect(added.status).toBe(409);
        expect(await mappedIds(fixture.acme, role.id)).toEqual([approveId]);

        // And removing one is always allowed, enabled or not.
        const cleared = await setPermissions(token, role.id, []);
        expect(cleared.permissions).toEqual([]);
      });

      it('maps permissions onto the system role — the deliberate exception', async () => {
        const token = await asAdmin();

        // Renaming and deleting are refused; mapping is not. The `Client Admin`
        // role is seeded with no permissions and gets its `iam.client.*` set
        // through this very endpoint in Session 23.
        const mapping = await setPermissions(token, fixture.acme.systemRoleId, [
          fixture.catalog.approveId,
        ]);

        expect(mapping.permissions).toHaveLength(1);
      });
    });

    // ── delete: guarded, and cascading with a trail ───────────────────────

    describe('deleting', () => {
      it('cascades the bindings and audits each one before the rows go', async () => {
        const token = await asAdmin();
        const role = await createRole(token, { name: 'Gate Supervisor' });
        const { approveId, createId } = fixture.catalog;
        await setPermissions(token, role.id, [approveId, createId]);

        const child = await insertScopeNode(admin, fixture.acme, 'Plant B');
        await insertBinding(admin, fixture.acme, role.id, fixture.acme.scopeNodeId);
        await insertBinding(admin, fixture.acme, role.id, child);
        const doomed = await bindingIds(fixture.acme, role.id);
        expect(doomed).toHaveLength(2);

        const response = await call(token, 'DELETE', `/iam/roles/${role.id}`);
        expect(response.status).toBe(204);

        expect(await roleExists(fixture.acme, role.id)).toBe(false);
        expect(await bindingIds(fixture.acme, role.id)).toEqual([]);
        expect(await mappedIds(fixture.acme, role.id)).toEqual([]);

        // One record per revoked grant, each naming the subject and where the
        // grant applied — after the cascade there is nothing left that could say
        // whose access was removed.
        const revoked = await auditFor(fixture.acme, AUDIT_ACTIONS.ROLE_BINDING_DELETED);
        expect(revoked).toHaveLength(2);
        for (const record of revoked) {
          expect(record).toMatchObject({
            user_id: fixture.acme.memberUserId,
            service_account_id: null,
            role_id: role.id,
            role_name: 'Gate Supervisor',
            cause: AUDIT_ACTIONS.ROLE_DELETED,
          });
          expect(typeof record['scope_node_path']).toBe('string');
        }

        const [deleted] = await auditFor(fixture.acme, AUDIT_ACTIONS.ROLE_DELETED);
        expect(deleted).toMatchObject({
          name: 'Gate Supervisor',
          permissions_unmapped: 2,
          bindings_deleted: 2,
        });

        // Written *before* the deletion, and this is what proves it. Write order
        // itself is not recoverable from the trail — every row of one transaction
        // carries the same `now()` and a random uuid to break the tie — but these
        // records **name the rows that no longer exist**: each points at one of
        // the two bindings the cascade removed, and each carries the subject and
        // the scope path read off it. A service that deleted first could not have
        // written any of that.
        expect(await auditTargets(fixture.acme, AUDIT_ACTIONS.ROLE_BINDING_DELETED)).toEqual(
          [...doomed].sort(),
        );
      });

      it('deletes a role nothing is bound to, without inventing binding records', async () => {
        const token = await asAdmin();
        const role = await createRole(token, { name: 'Gate Supervisor' });

        const response = await call(token, 'DELETE', `/iam/roles/${role.id}`);

        expect(response.status).toBe(204);
        expect(await auditFor(fixture.acme, AUDIT_ACTIONS.ROLE_BINDING_DELETED)).toEqual(
          [],
        );
        const [deleted] = await auditFor(fixture.acme, AUDIT_ACTIONS.ROLE_DELETED);
        expect(deleted).toMatchObject({ bindings_deleted: 0, permissions_unmapped: 0 });
      });

      it('refuses to delete the system role', async () => {
        const token = await asAdmin();

        const response = await call(
          token,
          'DELETE',
          `/iam/roles/${fixture.acme.systemRoleId}`,
        );

        expect(response.status).toBe(409);
        expect((await errorOf(response)).message).toContain('system role');
        expect(await roleExists(fixture.acme, fixture.acme.systemRoleId)).toBe(true);
      });
    });

    // ── who may do any of this ────────────────────────────────────────────

    describe('authorization and tenant isolation', () => {
      it('refuses an ordinary user of the tenant', async () => {
        const token = await login(fixture.acme.memberEmail, fixture.acme.slug);

        const response = await call(token, 'POST', '/iam/roles', { name: 'Not mine' });

        expect(response.status).toBe(403);
        expect((await errorOf(response)).code).toBe(IamErrorCode.PERMISSION_DENIED);
      });

      it('refuses an unauthenticated caller', async () => {
        const response = await fetch(`${baseUrl}/iam/roles`);
        expect(response.status).toBe(401);
      });

      it('shows each tenant only its own roles', async () => {
        const acmeToken = await asAdmin();
        const otherToken = await asAdmin(fixture.other);
        await createRole(acmeToken, { name: 'Gate Supervisor' });
        const theirs = await createRole(otherToken, { name: 'Their Role' });

        const response = await call(otherToken, 'GET', '/iam/roles');
        const body = (await response.json()) as Paginated<RoleDTO>;

        expect(body.data.map((entry) => entry.name)).toEqual([
          SYSTEM_ROLE_NAME,
          IAM_ADMIN_ROLE_NAME,
          'Their Role',
        ]);
        expect(body.data.every((entry) => entry.client_id === fixture.other.clientId)).toBe(
          true,
        );
        expect(theirs.client_id).toBe(fixture.other.clientId);
      });

      it('answers 404 — never 403 — for another client`s role, on every route', async () => {
        const acmeToken = await asAdmin();
        const otherToken = await asAdmin(fixture.other);
        const mine = await createRole(acmeToken, { name: 'Gate Supervisor' });
        await setPermissions(acmeToken, mine.id, [fixture.catalog.approveId]);

        const routes: [string, string, unknown?][] = [
          ['PATCH', `/iam/roles/${mine.id}`, { name: 'Renamed by a stranger' }],
          ['DELETE', `/iam/roles/${mine.id}`],
          ['GET', `/iam/roles/${mine.id}/permissions`],
          ['PUT', `/iam/roles/${mine.id}/permissions`, { permission_ids: [] }],
        ];

        for (const [method, path, body] of routes) {
          const response = await call(otherToken, method, path, body);
          expect(response.status).toBe(404);
          // RLS makes the row invisible rather than forbidden, so nothing
          // distinguishes it from an id that never existed (Doc 06 §2).
          const error = await errorOf(response);
          expect(error.code).toBe(IamErrorCode.NOT_FOUND);
          expect(error.message).not.toContain('Gate Supervisor');
        }

        // And none of it touched anything: the role and its mapping are intact.
        expect(await roleExists(fixture.acme, mine.id)).toBe(true);
        expect(await mappedIds(fixture.acme, mine.id)).toEqual([
          fixture.catalog.approveId,
        ]);
      });

      it('gives a missing id of the caller`s own tenant the identical answer', async () => {
        const token = await asAdmin();
        const otherToken = await asAdmin(fixture.other);
        const mine = await createRole(token, { name: 'Gate Supervisor' });

        const bodyOf = async (response: Response) => {
          const { code, message } = await errorOf(response);
          return { code, message };
        };

        const foreign = await call(otherToken, 'GET', `/iam/roles/${mine.id}/permissions`);
        const missing = await call(
          otherToken,
          'GET',
          `/iam/roles/${randomUUID()}/permissions`,
        );

        // Identical down to the wording — only the `requestId` differs, which is
        // per-request by construction and carries nothing about the target.
        expect(await bodyOf(foreign)).toEqual(await bodyOf(missing));
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
 * The four applications of {@link Catalog}, with their permissions.
 *
 * Catalog rows carry no `client_id` (Doc 07 §6); the platform flag alone admits
 * the write, and `current_client_id` is set only because `elevate` sets both.
 */
async function seedCatalog(admin: DataSource): Promise<Catalog> {
  await admin.query(`select set_config('app.is_platform_admin', 'true', false)`);

  const application = async (key: string, name: string, isActive = true) => {
    const [row] = (await admin.query(
      `insert into ${S}."application" (key, name, description, is_active)
       values ($1, $2, 'Session 17 fixture', $3)
       returning id`,
      [`${PREFIX}${key}`, name, isActive],
    )) as { id: string }[];
    return row.id;
  };

  const permission = async (applicationId: string, key: string, isActive = true) => {
    const [row] = (await admin.query(
      `insert into ${S}."permission" (application_id, key, name, is_active)
       values ($1, $2, $3, $4)
       returning id`,
      [applicationId, `${PREFIX}${key}`, key, isActive],
    )) as { id: string }[];
    return row.id;
  };

  const gatepassId = await application('gatepass', 'Session 17 Gate Pass');
  const weighbridgeId = await application('weighbridge', 'Session 17 Weighbridge');
  const visitorId = await application('visitor', 'Session 17 Visitor');
  const legacyId = await application('legacy', 'Session 17 Legacy', false);

  return {
    gatepassId,
    approveId: await permission(gatepassId, 'gatepass.dc.approve'),
    createId: await permission(gatepassId, 'gatepass.dc.create'),
    // Retired by a later manifest upload (Doc 02 §7) — mappable never again.
    retiredId: await permission(gatepassId, 'gatepass.dc.void', false),
    weighbridgeId,
    weighId: await permission(weighbridgeId, 'weighbridge.ticket.print'),
    visitorId,
    visitId: await permission(visitorId, 'visitor.pass.issue'),
    legacyId,
    legacyDoId: await permission(legacyId, 'legacy.thing.do'),
  };
}

/**
 * One tenant with an admin, an ordinary member, an org root and a system role.
 *
 * Seeded directly rather than through `POST /iam/clients/:id/admins`, so this
 * suite's subject does not depend on Session 15's endpoint — the same choice
 * `scopes.integration.spec.ts` makes, for the same reason.
 */
async function seedTenant(
  admin: DataSource,
  label: string,
  secretHash: string,
): Promise<Tenant> {
  const suffix = randomUUID().slice(0, 8);
  const scopeNodeId = randomUUID();
  const tenant: Tenant = {
    clientId: randomUUID(),
    slug: `${PREFIX}${label}-${suffix}`,
    adminEmail: `admin-${label}-${suffix}@example.test`,
    adminUserId: randomUUID(),
    memberEmail: `member-${label}-${suffix}@example.test`,
    memberUserId: randomUUID(),
    scopeNodeId,
    // Replaced by `resetTenant` before the first case runs.
    systemRoleId: randomUUID(),
  };

  await elevate(admin, tenant.clientId);
  await admin.query(
    `insert into ${S}."client" (id, name, slug, status) values ($1, $2, $3, 'active')`,
    [tenant.clientId, `Session 17 ${label} ${suffix}`, tenant.slug],
  );

  for (const [id, email, isAdmin] of [
    [tenant.adminUserId, tenant.adminEmail, true],
    [tenant.memberUserId, tenant.memberEmail, false],
  ] as const) {
    await admin.query(
      `insert into ${S}."user" (id, client_id, email, full_name, status, is_client_admin)
       values ($1, $2, $3, 'Session 17 Fixture', 'active', $4)`,
      [id, tenant.clientId, email, isAdmin],
    );
    await admin.query(
      `insert into ${S}."user_identity" (client_id, user_id, provider, secret_hash)
       values ($1, $2, 'password', $3)`,
      [tenant.clientId, id, secretHash],
    );
  }

  // The org root, with the id-derived ltree label of Doc 01 §3.5.
  await admin.query(
    `insert into ${S}."scope_node" (id, client_id, parent_id, kind, name, path)
     values ($1, $2, null, 'group', $3, $4::ltree)`,
    [scopeNodeId, tenant.clientId, `Session 17 ${label}`, scopePathLabel(scopeNodeId)],
  );

  return tenant;
}

/** A scope node under the tenant's root, so a second binding has somewhere to go. */
async function insertScopeNode(
  admin: DataSource,
  tenant: Tenant,
  name: string,
): Promise<string> {
  await elevate(admin, tenant.clientId);
  const id = randomUUID();
  const [root] = (await admin.query(
    `select path::text as path from ${S}."scope_node" where id = $1`,
    [tenant.scopeNodeId],
  )) as { path: string }[];

  await admin.query(
    `insert into ${S}."scope_node" (id, client_id, parent_id, kind, name, path)
     values ($1, $2, $3, 'plant', $4, $5::ltree)`,
    [id, tenant.clientId, tenant.scopeNodeId, name, `${root.path}.${scopePathLabel(id)}`],
  );

  return id;
}

/** Binds the tenant's ordinary member to `roleId` at `scopeNodeId`. */
async function insertBinding(
  admin: DataSource,
  tenant: Tenant,
  roleId: string,
  scopeNodeId: string,
): Promise<void> {
  await elevate(admin, tenant.clientId);
  await admin.query(
    `insert into ${S}."role_binding" (client_id, user_id, role_id, scope_node_id)
     values ($1, $2, $3, $4)`,
    [tenant.clientId, tenant.memberUserId, roleId, scopeNodeId],
  );
}

/** Flips `client_application.enabled` behind the API's back, as time would. */
async function toggleApplication(
  admin: DataSource,
  tenant: Tenant,
  applicationId: string,
  enabled: boolean,
): Promise<void> {
  await elevate(admin, tenant.clientId);
  await admin.query(
    `update ${S}."client_application" set enabled = $3
      where client_id = $1 and application_id = $2`,
    [tenant.clientId, applicationId, enabled],
  );
}

/**
 * Empties one tenant's role space and restores the canonical enablement state.
 *
 * Deleting the roles takes their `role_permission` and `role_binding` rows with
 * them — the cascade this session's `DELETE` route relies on — so the system role
 * has to be re-seeded, and its new id handed back on the fixture.
 */
async function resetTenant(
  admin: DataSource,
  tenant: Tenant,
  catalog: Catalog,
): Promise<void> {
  await elevate(admin, tenant.clientId);
  await admin.query(`delete from ${S}."role" where client_id = $1`, [tenant.clientId]);
  await admin.query(
    `delete from ${S}."scope_node" where client_id = $1 and parent_id is not null`,
    [tenant.clientId],
  );
  await admin.query(`delete from ${S}."audit_trail" where client_id = $1`, [
    tenant.clientId,
  ]);

  const [role] = (await admin.query(
    `insert into ${S}."role" (client_id, name, description, is_system)
     values ($1, $2, 'Session 17 fixture', true)
     returning id`,
    [tenant.clientId, SYSTEM_ROLE_NAME],
  )) as { id: string }[];
  tenant.systemRoleId = role.id;

  // gatepass on, weighbridge off, legacy on-but-deactivated, visitor absent.
  await admin.query(
    `delete from ${S}."client_application" where client_id = $1`,
    [tenant.clientId],
  );
  for (const [applicationId, enabled] of [
    [catalog.gatepassId, true],
    [catalog.weighbridgeId, false],
    [catalog.legacyId, true],
  ] as const) {
    await admin.query(
      `insert into ${S}."client_application" (client_id, application_id, enabled)
       values ($1, $2, $3)`,
      [tenant.clientId, applicationId, enabled],
    );
  }

  // Last, because the wipes above take both halves of it: since Session 23
  // every route here is gated on an `iam.client.role.*` permission, which is
  // held through a role bound at the tenant root — and is inert unless the IAM
  // is among the tenant's enabled applications (Doc 02 §6).
  await grantIamClientAdmin(admin, tenant.clientId, tenant.scopeNodeId, {
    userId: tenant.adminUserId,
  });
}

/** Every `s17-` tenant and application, and everything hanging off them. */
async function purge(admin: DataSource): Promise<void> {
  await admin.query(`select set_config('app.is_platform_admin', 'true', false)`);
  const clients = (await admin.query(
    `select id from ${S}."client" where slug like $1`,
    [`${PREFIX}%`],
  )) as { id: string }[];

  for (const { id } of clients) {
    await elevate(admin, id);
    for (const statement of [
      `delete from ${S}."role_binding" where client_id = $1`,
      `delete from ${S}."session" where client_id = $1`,
      `delete from ${S}."password_reset_token" where client_id = $1`,
      `delete from ${S}."user_identity" where client_id = $1`,
      `delete from ${S}."user" where client_id = $1`,
      // Takes `role_permission` with it — the cascade of migration 0004.
      `delete from ${S}."role" where client_id = $1`,
      `delete from ${S}."scope_node" where client_id = $1 and parent_id is not null`,
      `delete from ${S}."scope_node" where client_id = $1`,
      `delete from ${S}."client_application" where client_id = $1`,
      `delete from ${S}."audit_trail" where client_id = $1`,
    ]) {
      await admin.query(statement, [id]);
    }
    await admin.query(`delete from ${S}."client" where id = $1`, [id]);
  }

  // Applications cascade to their permissions and to any surviving
  // `client_application` row (migration 0004).
  await admin.query(`select set_config('app.is_platform_admin', 'true', false)`);
  await admin.query(`delete from ${S}."application" where key like $1`, [`${PREFIX}%`]);
}
