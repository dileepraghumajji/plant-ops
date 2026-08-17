/**
 * The Session 20 Definition of Done: **every cross-tenant safety rule of
 * Doc 02 §6, over HTTP, against a real Postgres** (Doc 06 §9, Doc 01 §4.5,
 * Doc 09 §3.4).
 *
 * A `role_binding` is the only row in this system whose existence gives somebody
 * access to something, and almost everything worth asserting about it is a claim
 * about the database rather than about this service. That the composite foreign
 * keys of migration 0004 make another tenant's role unnameable; that
 * `role_binding_subject_role_scope_key` refuses a second identical grant while
 * permitting one at an ancestor; that the subject XOR holds; that a
 * platform-level service account — which has no `client_id` for a composite key
 * to catch — is kept out of a tenant's binding space by this service instead;
 * and that a foreign id and a nonexistent one produce byte-identical refusals. A
 * fake database can express none of them, so this suite runs against a real one:
 *
 *   pg_ctl start                # a local Postgres 17 (see .env)
 *   npm run migration:run
 *   npx nx test @plantops/iam-api
 *
 * **Destructive within its own fixtures only.** Every client it creates is
 * slugged `s20-…`, and it is removed afterwards with the rows that hang off it —
 * including the platform-level service account, which belongs to no client and
 * is therefore purged by name.
 *
 * ## The caller is a tenant's own client admin
 *
 * A client-tier surface (Doc 06 §9): the subject is a user of the tenant, logged
 * in at `POST /auth/login`, and the tenant comes from that token's `cid`. The
 * second tenant exists precisely so the Doc 02 §6 rules are tested rather than
 * assumed — each of them needs a role, a node, a person and a machine identity
 * that belong to somebody else.
 *
 * ## Deliberate deviations from the shipped configuration
 *
 * - **Rate limiting is off.** These cases make dozens of calls against a surface
 *   bounded at sixty a minute.
 * - **`GrantInvalidationService.publish` is spied on** where the Doc 04 §7 hook
 *   is under test, and the spy reads the database *on another connection* to see
 *   whether the write had committed by the time it ran. That is the assertion;
 *   the stub's own body is a log line and has nothing to prove.
 * - **Nothing else.** The interim permission rule, the validation pipe, the RLS
 *   context, the isolation level on `POST` and the audit path are the shipped
 *   ones.
 */

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { loadEnv } from '@plantops/config';
import {
  IamErrorCode,
  type IamErrorResponse,
  type Paginated,
  type RoleBindingDTO,
  type ScopeNodeDTO,
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
import { GrantInvalidationService } from '../authz/invalidation.service';
import { ENV } from '../config/config.module';
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

/** Everything this suite creates carries this prefix. */
const PREFIX = 's20-';

/** The platform-level machine identity of Doc 01 §3.7 — null `client_id`. */
const PLATFORM_ACCOUNT_KEY = `${PREFIX}platform-account`;

/** A day out, so a slow suite cannot walk past an expiry mid-run. */
const TOMORROW = () => new Date(Date.now() + 86_400_000).toISOString();

/** One tenant, with one of everything a binding names. */
interface Tenant {
  clientId: string;
  slug: string;
  /** `is_client_admin` — the caller for almost every case. */
  adminEmail: string;
  adminUserId: string;
  /** An ordinary user: the interim authorization must refuse one, and grants land on them. */
  memberEmail: string;
  memberUserId: string;
  /** The org root — the WHERE every case binds at unless it says otherwise. */
  rootId: string;
  rootPath: string;
  /** A plant beneath the root, for the ancestor/descendant case. */
  plantId: string;
  /** The WHAT. */
  roleId: string;
  /** The tenant's own machine identity (Doc 09 §3.5). */
  serviceAccountId: string;
}

interface Fixture {
  acme: Tenant;
  other: Tenant;
  /** Belongs to no client at all (Doc 01 §3.7). */
  platformServiceAccountId: string;
}

describeWithDb(
  `role binding APIs (${configured ? 'live' : 'skipped: no DATABASE_URL'})`,
  () => {
    let app: INestApplication;
    let baseUrl: string;
    let admin: DataSource;
    let fixture: Fixture;
    let invalidation: GrantInvalidationService;

    jest.setTimeout(180_000);

    beforeAll(async () => {
      const env = loadEnv();

      admin = createMigrationDataSource(env);
      await admin.initialize();
      await admin.query('select pg_advisory_lock($1)', [IAM_SCHEMA_TEST_LOCK_ID]);
      await purge(admin);

      const secretHash = await hashSecret(PASSWORD);
      fixture = {
        acme: await seedTenant(admin, 'acme', secretHash),
        other: await seedTenant(admin, 'other', secretHash),
        platformServiceAccountId: await seedPlatformAccount(admin, secretHash),
      };

      const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(ENV)
        .useValue({ ...env, RATE_LIMIT_ENABLED: false })
        .compile();

      app = createTestApplication(moduleRef);
      await app.init();
      await app.listen(0);
      baseUrl = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
      invalidation = app.get(GrantInvalidationService);
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
      // Back to two tenants with no grants and no audit history. Every case here
      // writes bindings against fixtures it shares with the next one, so the
      // state is restored rather than assumed — a leftover grant would make an
      // unrelated `total` fail for a reason it does not name.
      for (const tenant of [fixture.acme, fixture.other]) {
        await resetTenant(admin, tenant);
      }
      jest.restoreAllMocks();
    });

    // ── the wire ──────────────────────────────────────────────────────────

    const loginOk = async (email: string, slug: string): Promise<TokenPairResponse> => {
      const response = await fetch(`${baseUrl}/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, password: PASSWORD, client_slug: slug }),
      });
      expect(response.status).toBe(200);
      return (await response.json()) as TokenPairResponse;
    };

    const asAdmin = async (tenant: Tenant = fixture.acme): Promise<string> =>
      (await loginOk(tenant.adminEmail, tenant.slug)).access_token;

    const asMember = async (tenant: Tenant = fixture.acme): Promise<string> =>
      (await loginOk(tenant.memberEmail, tenant.slug)).access_token;

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

    /** The comparable part of a refusal — everything but the per-request id. */
    const refusalOf = async (response: Response) => {
      const { code, message } = await errorOf(response);
      return { status: response.status, code, message };
    };

    /** Binds, asserts the 201, and returns the DTO. */
    const bind = async (
      token: string,
      body: Record<string, unknown>,
    ): Promise<RoleBindingDTO> => {
      const response = await call(token, 'POST', '/iam/role-bindings', body);
      expect(response.status).toBe(201);
      return (await response.json()) as RoleBindingDTO;
    };

    /**
     * `GET /iam/role-bindings`, unfiltered unless asked.
     *
     * Every tenant carries one grant this suite did not make: since Session 23
     * the administrator's own `iam.client.binding.*` permissions come from a
     * binding at the root, or none of these calls would be authorized
     * (`testing/authorization.fixture.ts`). It is a real row and the API is
     * right to list it, so the counts below include it rather than the helper
     * hiding it — `bindingRows` is the database-side view that does not, because
     * it is asserting what a *case* wrote.
     */
    const listBindings = async (
      token: string,
      query = '',
    ): Promise<Paginated<RoleBindingDTO>> => {
      const response = await call(token, 'GET', `/iam/role-bindings${query}`);
      expect(response.status).toBe(200);
      return (await response.json()) as Paginated<RoleBindingDTO>;
    };

    /** The ordinary grant almost every case starts from. */
    const memberAtRoot = (tenant: Tenant = fixture.acme) => ({
      user_id: tenant.memberUserId,
      role_id: tenant.roleId,
      scope_node_id: tenant.rootId,
    });

    // ── inspection, through the owner connection ──────────────────────────

    /**
     * Every grant this suite's cases made — which is every grant in the tenant
     * *except* the administrator's own.
     *
     * Since Session 23 the fixture binds the admin to a role carrying the
     * `iam.client.*` permissions, or none of these calls would be authorized at
     * all (`testing/authorization.fixture.ts`). That binding is scaffolding, not
     * a result, and counting it here would make every `toHaveLength` in this file
     * assert one more than the case is about.
     */
    const bindingRows = async (tenant: Tenant) => {
      await elevate(admin, tenant.clientId);
      return (await admin.query(
        `select rb.id, rb.user_id, rb.service_account_id, rb.role_id,
                rb.scope_node_id, rb.expires_at
           from ${S}."role_binding" rb
           join ${S}."role" r on r.id = rb.role_id
          where rb.client_id = $1 and r.name <> $2
          order by rb.created_at asc, rb.id asc`,
        [tenant.clientId, IAM_ADMIN_ROLE_NAME],
      )) as {
        id: string;
        user_id: string | null;
        service_account_id: string | null;
        role_id: string;
        scope_node_id: string;
        expires_at: Date | null;
      }[];
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

    // ── binding (Doc 06 §9, Doc 09 §3.4) ─────────────────────────────────

    describe('binding', () => {
      it('grants a role to a user at a scope node, and audits it', async () => {
        const token = await asAdmin();

        const binding = await bind(token, memberAtRoot());

        // The tenant is the token's, never a field of the request, and every id
        // comes back beside the name it stands for — a binding rendered as four
        // uuids is not a rendering of anything (Doc 09 §3.4).
        expect(binding).toMatchObject({
          client_id: fixture.acme.clientId,
          subject_type: 'user',
          subject_id: fixture.acme.memberUserId,
          subject_name: 'Session 20 Member',
          subject_email: fixture.acme.memberEmail,
          role_id: fixture.acme.roleId,
          role_name: 'Session 20 Role',
          scope_node_id: fixture.acme.rootId,
          scope_node_path: fixture.acme.rootPath,
          expires_at: null,
          expired: false,
        });

        const [record] = await auditFor(fixture.acme, AUDIT_ACTIONS.ROLE_BINDING_CREATED);
        expect(record).toMatchObject({
          subject_type: 'user',
          user_id: fixture.acme.memberUserId,
          service_account_id: null,
          role_id: fixture.acme.roleId,
          role_name: 'Session 20 Role',
          scope_node_id: fixture.acme.rootId,
          scope_node_path: fixture.acme.rootPath,
          expires_at: null,
        });
      });

      it('grants to a service account, which has no address', async () => {
        const token = await asAdmin();

        const binding = await bind(token, {
          service_account_id: fixture.acme.serviceAccountId,
          role_id: fixture.acme.roleId,
          scope_node_id: fixture.acme.rootId,
        });

        // Doc 09 §3.5: a machine identity is bound like a person. The XOR is
        // what makes that one code path rather than two.
        expect(binding).toMatchObject({
          subject_type: 'service',
          subject_id: fixture.acme.serviceAccountId,
          subject_name: 'Session 20 Integration',
          subject_email: null,
        });

        const [row] = await bindingRows(fixture.acme);
        expect(row.user_id).toBeNull();
        expect(row.service_account_id).toBe(fixture.acme.serviceAccountId);
      });

      it('stores an expiry, and reports it as not yet lapsed', async () => {
        const token = await asAdmin();
        const expires = TOMORROW();

        const binding = await bind(token, { ...memberAtRoot(), expires_at: expires });

        expect(binding.expired).toBe(false);
        expect(binding.expires_at).not.toBeNull();
        expect(Date.parse(binding.expires_at as string)).toBe(Date.parse(expires));

        const [row] = await bindingRows(fixture.acme);
        expect(row.expires_at).not.toBeNull();
      });

      it('refuses a second identical grant', async () => {
        const token = await asAdmin();
        await bind(token, memberAtRoot());

        const duplicate = await call(token, 'POST', '/iam/role-bindings', memberAtRoot());

        // `role_binding_subject_role_scope_key`. Naming the three parts is safe:
        // the caller sent all of them, and the index is scoped to their own
        // tenant.
        expect(duplicate.status).toBe(409);
        expect((await errorOf(duplicate)).code).toBe(IamErrorCode.CONFLICT);
        expect(await bindingRows(fixture.acme)).toHaveLength(1);
      });

      it('permits the same subject and role at an ancestor and a descendant', async () => {
        const token = await asAdmin();

        await bind(token, memberAtRoot());
        const beneath = await bind(token, {
          ...memberAtRoot(),
          scope_node_id: fixture.acme.plantId,
        });

        // Doc 01 §4.5 makes this explicitly legal: the ancestor already covers
        // the descendant, so the second row grants nothing new — but refusing it
        // would mean deleting the wider grant silently revoked the narrower one.
        // Resolution dedupes the covering paths instead (Doc 04 §4.1).
        expect(beneath.scope_node_id).toBe(fixture.acme.plantId);
        expect(await bindingRows(fixture.acme)).toHaveLength(2);
      });

      // Lazily, because the fixture ids do not exist until `beforeAll` has run.
      it.each([
        [
          'neither subject',
          () => ({ role_id: fixture.acme.roleId, scope_node_id: fixture.acme.rootId }),
        ],
        [
          'both subjects',
          () => ({
            user_id: fixture.acme.memberUserId,
            service_account_id: fixture.acme.serviceAccountId,
            role_id: fixture.acme.roleId,
            scope_node_id: fixture.acme.rootId,
          }),
        ],
      ])('refuses a body naming %s with a 400', async (_case, body) => {
        const token = await asAdmin();

        const response = await call(token, 'POST', '/iam/role-bindings', body());

        // A 400 rather than the check constraint's 500: the body is malformed in
        // a way no row could settle, so the schema refuses it (Doc 06 §2).
        expect(response.status).toBe(400);
        expect((await errorOf(response)).code).toBe(IamErrorCode.VALIDATION_FAILED);
        expect(await bindingRows(fixture.acme)).toEqual([]);
      });

      it('refuses an expiry that has already passed', async () => {
        const token = await asAdmin();

        const response = await call(token, 'POST', '/iam/role-bindings', {
          ...memberAtRoot(),
          expires_at: new Date(Date.now() - 86_400_000).toISOString(),
        });

        expect(response.status).toBe(400);
        expect(await bindingRows(fixture.acme)).toEqual([]);
      });
    });

    // ── the Doc 02 §6 cross-tenant safety rules — this session's DoD ──────

    describe('cross-tenant safety (Doc 02 §6)', () => {
      /**
       * The refusal a nonexistent id of the same kind gets.
       *
       * Every case below compares against this rather than merely asserting a
       * 409: the promise of Doc 06 §2 is not that a foreign id is refused, it is
       * that the refusal is *indistinguishable* from one for an id that names
       * nothing anywhere. A request carrying four ids that reported differently
       * on each would be an oracle for enumerating another tenant, one uuid at a
       * time.
       */
      const compare = async (
        token: string,
        foreign: Record<string, unknown>,
        missing: Record<string, unknown>,
      ) => {
        const a = await call(token, 'POST', '/iam/role-bindings', foreign);
        const b = await call(token, 'POST', '/iam/role-bindings', missing);

        expect(a.status).toBe(409);
        expect(await refusalOf(a)).toEqual(await refusalOf(b));
        expect(await bindingRows(fixture.acme)).toEqual([]);
      };

      it('refuses a role belonging to another client — "a user may only be bound to roles of their own client"', async () => {
        await compare(
          await asAdmin(),
          { ...memberAtRoot(), role_id: fixture.other.roleId },
          { ...memberAtRoot(), role_id: randomUUID() },
        );
      });

      it('refuses a scope node belonging to another client — "a binding`s scope_node must belong to the same client as the role"', async () => {
        await compare(
          await asAdmin(),
          { ...memberAtRoot(), scope_node_id: fixture.other.rootId },
          { ...memberAtRoot(), scope_node_id: randomUUID() },
        );
      });

      it('refuses a user belonging to another client', async () => {
        await compare(
          await asAdmin(),
          { ...memberAtRoot(), user_id: fixture.other.memberUserId },
          { ...memberAtRoot(), user_id: randomUUID() },
        );
      });

      it('refuses a service account belonging to another client', async () => {
        const token = await asAdmin();
        const foreign = {
          service_account_id: fixture.other.serviceAccountId,
          role_id: fixture.acme.roleId,
          scope_node_id: fixture.acme.rootId,
        };

        await compare(token, foreign, {
          ...foreign,
          service_account_id: randomUUID(),
        });
      });

      it('refuses a platform-level service account — "platform admins never appear inside a client`s role/binding space"', async () => {
        const token = await asAdmin();
        const platform = {
          service_account_id: fixture.platformServiceAccountId,
          role_id: fixture.acme.roleId,
          scope_node_id: fixture.acme.rootId,
        };

        // The one rule with no database enforcement behind it. A platform
        // account's `client_id` is null (Doc 01 §3.7), so `role_binding`'s
        // service-account foreign key is a plain one rather than the composite
        // one the user arm gets — migration 0004 says so at the constraint and
        // hands the check to this service. Without it, the row would be written.
        await compare(token, platform, {
          ...platform,
          service_account_id: randomUUID(),
        });
      });

      it('does not let the other tenant see, or unbind, this one`s grant', async () => {
        const binding = await bind(await asAdmin(), memberAtRoot());
        const theirs = await asAdmin(fixture.other);

        // Their own administrator's grant, and nothing of Acme's.
        expect(
          (await listBindings(theirs)).data.map((entry) => entry.role_name),
        ).toEqual([IAM_ADMIN_ROLE_NAME]);

        const deletion = await call(
          theirs,
          'DELETE',
          `/iam/role-bindings/${binding.id}`,
        );
        const missing = await call(
          theirs,
          'DELETE',
          `/iam/role-bindings/${randomUUID()}`,
        );

        // Invisible under RLS, so it is the same 404 a nonexistent id gets — the
        // response cannot be used to discover that a grant exists elsewhere.
        expect(deletion.status).toBe(404);
        expect(await refusalOf(deletion)).toEqual(await refusalOf(missing));
        expect(await bindingRows(fixture.acme)).toHaveLength(1);
      });
    });

    // ── listing and filtering (Doc 06 §9, Doc 09 §3.4) ───────────────────

    describe('listing', () => {
      it('returns the pagination envelope, ordered by subject then path', async () => {
        const token = await asAdmin();
        await bind(token, { ...memberAtRoot(), scope_node_id: fixture.acme.plantId });
        await bind(token, memberAtRoot());
        await bind(token, {
          service_account_id: fixture.acme.serviceAccountId,
          role_id: fixture.acme.roleId,
          scope_node_id: fixture.acme.rootId,
        });

        const body = await listBindings(token);

        expect(body).toMatchObject({ page: 1, limit: 25, total: 4 });
        // By subject first, so the table groups by *who*; then by path, so one
        // person's grants read the way the org tree does — the root before the
        // plant beneath it, whichever order they were written in.
        expect(
          body.data.map((entry) => [entry.subject_name, entry.scope_node_id]),
        ).toEqual([
          ['Session 20 Admin', fixture.acme.rootId],
          ['Session 20 Integration', fixture.acme.rootId],
          ['Session 20 Member', fixture.acme.rootId],
          ['Session 20 Member', fixture.acme.plantId],
        ]);
      });

      it('pages, and reports the total rather than the page length', async () => {
        const token = await asAdmin();
        await bind(token, memberAtRoot());
        await bind(token, { ...memberAtRoot(), scope_node_id: fixture.acme.plantId });

        const body = await listBindings(token, '?page=2&limit=1');

        expect(body).toMatchObject({ page: 2, limit: 1, total: 3 });
        expect(body.data).toHaveLength(1);
      });

      it('filters by user, by role, by scope node, and by machine identity', async () => {
        const token = await asAdmin();
        const atRoot = await bind(token, memberAtRoot());
        const atPlant = await bind(token, {
          ...memberAtRoot(),
          scope_node_id: fixture.acme.plantId,
        });
        const machine = await bind(token, {
          service_account_id: fixture.acme.serviceAccountId,
          role_id: fixture.acme.roleId,
          scope_node_id: fixture.acme.rootId,
        });

        const ids = async (query: string) =>
          (await listBindings(token, query)).data.map((entry) => entry.id);

        expect(await ids(`?user_id=${fixture.acme.memberUserId}`)).toEqual([
          atRoot.id,
          atPlant.id,
        ]);
        expect(
          await ids(`?service_account_id=${fixture.acme.serviceAccountId}`),
        ).toEqual([machine.id]);
        expect(await ids(`?scope_node_id=${fixture.acme.plantId}`)).toEqual([
          atPlant.id,
        ]);
        expect((await ids(`?role_id=${fixture.acme.roleId}`)).sort()).toEqual(
          [atRoot.id, atPlant.id, machine.id].sort(),
        );

        // Combined with `and`, so a fully filtered call is the duplicate check
        // an operator can run before binding.
        expect(
          await ids(
            `?user_id=${fixture.acme.memberUserId}&scope_node_id=${fixture.acme.rootId}`,
          ),
        ).toEqual([atRoot.id]);
      });

      it('lists an expired grant, flagged rather than hidden', async () => {
        const token = await asAdmin();
        // Written directly: the API refuses to *create* a lapsed grant, and this
        // is the row that exists because time passed rather than because anybody
        // asked for it — which is exactly the case Doc 01 §4.5 says fires no
        // event at all.
        await insertBinding(admin, fixture.acme, {
          userId: fixture.acme.memberUserId,
          scopeNodeId: fixture.acme.rootId,
          expiresAt: new Date(Date.now() - 86_400_000),
        });

        const body = await listBindings(token);

        // A grant that lapsed last Friday is the answer to "why did this stop
        // working"; a list that dropped the row would leave it unanswerable.
        expect(body.total).toBe(2);
        const [lapsed] = body.data.filter((entry) => entry.expired);
        expect(lapsed).toMatchObject({ expired: true });
        expect(lapsed?.expires_at).not.toBeNull();
      });

      it('shows the caller only their own tenant`s grants', async () => {
        const token = await asAdmin();
        await bind(await asAdmin(fixture.other), memberAtRoot(fixture.other));
        await bind(token, memberAtRoot());

        const body = await listBindings(token);

        expect(body.total).toBe(2);
        expect(
          body.data.every((entry) => entry.client_id === fixture.acme.clientId),
        ).toBe(true);
      });
    });

    // ── unbinding (Doc 06 §9) ────────────────────────────────────────────

    describe('unbinding', () => {
      it('removes the grant and audits whose access it took away', async () => {
        const token = await asAdmin();
        const binding = await bind(token, { ...memberAtRoot(), expires_at: TOMORROW() });

        const response = await call(
          token,
          'DELETE',
          `/iam/role-bindings/${binding.id}`,
        );

        expect(response.status).toBe(204);
        expect(await bindingRows(fixture.acme)).toEqual([]);

        const [record] = await auditFor(fixture.acme, AUDIT_ACTIONS.ROLE_BINDING_DELETED);
        // Read before the delete, because afterwards there is nothing left to
        // say whose access was removed and where.
        expect(record).toMatchObject({
          subject_type: 'user',
          user_id: fixture.acme.memberUserId,
          subject_name: 'Session 20 Member',
          role_name: 'Session 20 Role',
          scope_node_path: fixture.acme.rootPath,
        });
        // No `cause`: that field is what distinguishes this from the same action
        // written by `RolesService.remove` for a binding that went with its role.
        expect(record['cause']).toBeUndefined();
      });

      it('gives an already-removed grant the same 404 as a nonexistent one', async () => {
        const token = await asAdmin();
        const binding = await bind(token, memberAtRoot());
        expect(
          (await call(token, 'DELETE', `/iam/role-bindings/${binding.id}`)).status,
        ).toBe(204);

        const again = await call(token, 'DELETE', `/iam/role-bindings/${binding.id}`);
        const missing = await call(
          token,
          'DELETE',
          `/iam/role-bindings/${randomUUID()}`,
        );

        expect(again.status).toBe(404);
        expect(await refusalOf(again)).toEqual(await refusalOf(missing));
      });
    });

    // ── the Doc 04 §7 invalidation hook ──────────────────────────────────

    describe('grant invalidation', () => {
      it('publishes for the bound subject, and only after the commit', async () => {
        const token = await asAdmin();
        const observed: { rowsVisibleElsewhere: number; call: unknown }[] = [];

        jest
          .spyOn(invalidation, 'publish')
          .mockImplementation(async (clientId, subjects, reason) => {
            observed.push({
              // Read on the *owner* connection, outside the request's
              // transaction: if this sees the row, the insert had already
              // committed when the publish ran. Invalidating before commit lets
              // a reader repopulate from pre-change state and re-poison the
              // cache (Doc 04 §7.1).
              rowsVisibleElsewhere: (await bindingRows(fixture.acme)).length,
              call: { clientId, subjects: [...subjects], reason },
            });
          });

        const binding = await bind(token, memberAtRoot());

        expect(observed).toHaveLength(1);
        expect(observed[0].rowsVisibleElsewhere).toBe(1);
        expect(observed[0].call).toEqual({
          clientId: fixture.acme.clientId,
          subjects: [{ type: 'user', id: fixture.acme.memberUserId }],
          reason: { cause: 'role_binding.created', bindingId: binding.id },
        });
      });

      it('publishes for the machine identity when a grant is revoked', async () => {
        const token = await asAdmin();
        const binding = await bind(token, {
          service_account_id: fixture.acme.serviceAccountId,
          role_id: fixture.acme.roleId,
          scope_node_id: fixture.acme.rootId,
        });
        const published = jest.spyOn(invalidation, 'publish').mockResolvedValue();

        expect(
          (await call(token, 'DELETE', `/iam/role-bindings/${binding.id}`)).status,
        ).toBe(204);

        // Doc 04 §7's first row, in the other direction: a deleted binding
        // invalidates that subject, machine or human alike.
        expect(published).toHaveBeenCalledWith(
          fixture.acme.clientId,
          [{ type: 'service', id: fixture.acme.serviceAccountId }],
          { cause: 'role_binding.deleted', bindingId: binding.id },
        );
      });

      it('publishes nothing when the bind is refused', async () => {
        const token = await asAdmin();
        const published = jest.spyOn(invalidation, 'publish').mockResolvedValue();

        const response = await call(token, 'POST', '/iam/role-bindings', {
          ...memberAtRoot(),
          role_id: fixture.other.roleId,
        });
        expect(response.status).toBe(409);

        // `afterCommit` callbacks are registered on the transaction's scope and
        // discarded with it, so a rollback cannot announce a grant that was
        // never written.
        expect(published).not.toHaveBeenCalled();
      });
    });

    // ── the move-versus-bind race (Doc 04 §7.1 rule 2) ───────────────────

    describe('a bind racing a scope move', () => {
      it('leaves the grant anchored to the node, at whatever path the move gave it', async () => {
        const token = await asAdmin();
        // A second branch to move the plant under, so the two requests contend
        // over the same subtree rather than over unrelated rows.
        const branch = await createNode(token, 'Session 20 Branch');

        const [bound, moved] = await Promise.all([
          call(token, 'POST', '/iam/role-bindings', {
            ...memberAtRoot(),
            scope_node_id: fixture.acme.plantId,
          }),
          call(token, 'PATCH', `/iam/scopes/${fixture.acme.plantId}`, {
            parent_id: branch.id,
          }),
        ]);

        // Both succeed: `POST` runs at `REPEATABLE READ` with two retries
        // (Doc 04 §7.1 rule 2), so an insert that loses the race re-runs against
        // committed state rather than failing the operator's request.
        expect(bound.status).toBe(201);
        expect(moved.status).toBe(200);

        const [row] = await bindingRows(fixture.acme);
        expect(row.scope_node_id).toBe(fixture.acme.plantId);

        // The claim worth making, and the reason `path` is id-derived: a binding
        // references the *node*, never a snapshot of where the node was. So
        // whichever order the two committed in, reading the grant afterwards
        // reports the post-move path and coverage follows the tree.
        const [listed] = (await listBindings(token)).data.filter(
          (entry) => entry.scope_node_id === fixture.acme.plantId,
        );
        expect(listed?.scope_node_path).toBe(
          `${branch.path}.${scopePathLabel(fixture.acme.plantId)}`,
        );
      });
    });

    // ── the interim authorization (Doc 06 §9) ────────────────────────────

    describe('authorization', () => {
      it('refuses an ordinary user of the tenant', async () => {
        const member = await asMember();

        for (const [method, path, body] of [
          ['GET', '/iam/role-bindings', undefined],
          ['POST', '/iam/role-bindings', memberAtRoot()],
          ['DELETE', `/iam/role-bindings/${randomUUID()}`, undefined],
        ] as const) {
          const response = await call(member, method, path, body);
          // A 403 rather than a 404: no target has been named at the point the
          // check runs, so there is nothing whose existence it could reveal.
          expect(response.status).toBe(403);
          expect((await errorOf(response)).code).toBe(IamErrorCode.PERMISSION_DENIED);
        }

        // And nothing was written on the way to the refusal.
        expect(await bindingRows(fixture.acme)).toEqual([]);
      });

      it('refuses an unauthenticated request', async () => {
        const response = await fetch(`${baseUrl}/iam/role-bindings`);
        expect(response.status).toBe(401);
      });
    });

    /** A node beneath the tenant root, through the shipped `/iam/scopes` API. */
    async function createNode(token: string, name: string): Promise<ScopeNodeDTO> {
      const response = await call(token, 'POST', '/iam/scopes', {
        parent_id: fixture.acme.rootId,
        kind: 'plant',
        name,
      });
      expect(response.status).toBe(201);
      return (await response.json()) as ScopeNodeDTO;
    }
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
 * One tenant with an admin, a member, an org root, a plant, a role and a machine
 * identity — one of everything a binding can name.
 *
 * Seeded directly rather than through the APIs that create them, so this suite's
 * fixtures do not depend on Sessions 15–19 — the same choice
 * `users.integration.spec.ts` makes, for the same reason.
 */
async function seedTenant(
  admin: DataSource,
  label: string,
  secretHash: string,
): Promise<Tenant> {
  const suffix = randomUUID().slice(0, 8);
  const rootId = randomUUID();
  const tenant: Tenant = {
    clientId: randomUUID(),
    slug: `${PREFIX}${label}-${suffix}`,
    adminEmail: `admin-${label}-${suffix}@example.test`,
    adminUserId: randomUUID(),
    memberEmail: `member-${label}-${suffix}@example.test`,
    memberUserId: randomUUID(),
    rootId,
    rootPath: scopePathLabel(rootId),
    plantId: randomUUID(),
    roleId: randomUUID(),
    serviceAccountId: randomUUID(),
  };

  await elevate(admin, tenant.clientId);
  await admin.query(
    `insert into ${S}."client" (id, name, slug, status) values ($1, $2, $3, 'active')`,
    [tenant.clientId, `Session 20 ${label} ${suffix}`, tenant.slug],
  );

  for (const [id, email, name, isAdmin] of [
    [tenant.adminUserId, tenant.adminEmail, 'Session 20 Admin', true],
    [tenant.memberUserId, tenant.memberEmail, 'Session 20 Member', false],
  ] as const) {
    await admin.query(
      `insert into ${S}."user" (id, client_id, email, full_name, status, is_client_admin)
       values ($1, $2, $3, $4, 'active', $5)`,
      [id, tenant.clientId, email, name, isAdmin],
    );
    await admin.query(
      `insert into ${S}."user_identity" (client_id, user_id, provider, secret_hash)
       values ($1, $2, 'password', $3)`,
      [tenant.clientId, id, secretHash],
    );
  }

  // The org root and one plant beneath it, with the id-derived ltree labels of
  // Doc 01 §3.5 — the ancestor/descendant pair the duplicate rule needs.
  await admin.query(
    `insert into ${S}."scope_node" (id, client_id, parent_id, kind, name, path)
     values ($1, $2, null, 'group', $3, $4::ltree)`,
    [tenant.rootId, tenant.clientId, `Session 20 ${label}`, tenant.rootPath],
  );
  await admin.query(
    `insert into ${S}."scope_node" (id, client_id, parent_id, kind, name, path)
     values ($1, $2, $3, 'plant', 'Session 20 Plant', $4::ltree)`,
    [
      tenant.plantId,
      tenant.clientId,
      tenant.rootId,
      `${tenant.rootPath}.${scopePathLabel(tenant.plantId)}`,
    ],
  );

  await admin.query(
    `insert into ${S}."role" (id, client_id, name, description)
     values ($1, $2, 'Session 20 Role', 'Session 20 fixture')`,
    [tenant.roleId, tenant.clientId],
  );

  await admin.query(
    `insert into ${S}."service_account" (id, client_id, name, key, key_hash, status)
     values ($1, $2, 'Session 20 Integration', $3, $4, 'active')`,
    [
      tenant.serviceAccountId,
      tenant.clientId,
      `${PREFIX}${label}-${suffix}`,
      secretHash,
    ],
  );

  return tenant;
}

/**
 * The machine identity that belongs to no client (Doc 01 §3.7).
 *
 * A null `client_id` is only insertable under platform context — migration
 * 0007's `service_account` policy has an explicit arm for it — which is what
 * `elevate` establishes. It exists here so the one Doc 02 §6 rule with no
 * database enforcement behind it can be tested rather than assumed.
 */
async function seedPlatformAccount(
  admin: DataSource,
  secretHash: string,
): Promise<string> {
  const id = randomUUID();
  await admin.query(`select set_config('app.is_platform_admin', 'true', false)`);
  await admin.query(`select set_config('app.current_client_id', '', false)`);
  await admin.query(
    `insert into ${S}."service_account" (id, client_id, name, key, key_hash, status)
     values ($1, null, 'Session 20 Platform', $2, $3, 'active')`,
    [id, PLATFORM_ACCOUNT_KEY, secretHash],
  );
  return id;
}

/** A binding written straight to the table — for the states the API refuses to create. */
async function insertBinding(
  admin: DataSource,
  tenant: Tenant,
  options: { userId: string; scopeNodeId: string; expiresAt?: Date },
): Promise<void> {
  await elevate(admin, tenant.clientId);
  await admin.query(
    `insert into ${S}."role_binding" (client_id, user_id, role_id, scope_node_id, expires_at)
     values ($1, $2, $3, $4, $5)`,
    [
      tenant.clientId,
      options.userId,
      tenant.roleId,
      options.scopeNodeId,
      options.expiresAt ?? null,
    ],
  );
}

/**
 * Back to a tenant with no grants and no history.
 *
 * The tenants, their tree, role and identities are seeded once: logging in is
 * the slowest thing here (argon2id, by design), so the accounts that log in are
 * not rebuilt per case. The plant is restored to the root because the
 * move-versus-bind case reparents it.
 */
async function resetTenant(admin: DataSource, tenant: Tenant): Promise<void> {
  await elevate(admin, tenant.clientId);

  await admin.query(`delete from ${S}."role_binding" where client_id = $1`, [
    tenant.clientId,
  ]);
  await admin.query(`delete from ${S}."session" where client_id = $1`, [tenant.clientId]);

  // The plant goes home *before* the nodes above it are removed: the
  // move-versus-bind case reparents it under a branch, and `scope_node`'s parent
  // key is `on delete restrict`, so deleting that branch while it still has a
  // child would fail rather than cascade.
  await admin.query(
    `update ${S}."scope_node"
        set parent_id = $2, path = $3::ltree
      where client_id = $1 and id = $4`,
    [
      tenant.clientId,
      tenant.rootId,
      `${tenant.rootPath}.${scopePathLabel(tenant.plantId)}`,
      tenant.plantId,
    ],
  );
  await deleteScopeNodes(admin, tenant.clientId, [tenant.rootId, tenant.plantId]);

  await admin.query(`delete from ${S}."audit_trail" where client_id = $1`, [
    tenant.clientId,
  ]);
  // The administrator's own authorization, last, because the wipes above take
  // it with them: since Session 23 every route on this surface is gated on an
  // `iam.client.*` permission, held through a role bound at the tenant root
  // (`testing/authorization.fixture.ts`).
  await grantIamClientAdmin(admin, tenant.clientId, tenant.rootId, {
    userId: tenant.adminUserId,
  });
}

/**
 * Deletes a client's scope nodes leaf-first, keeping `keep`.
 *
 * A single `delete` over the whole set would not do: the parent key is `on
 * delete restrict`, which Postgres checks per row and immediately, so a
 * statement removing a parent and its child in one pass is refused even though
 * the child is going too. Deleting whatever currently has no children, and
 * repeating, terminates at the depth of the tree.
 */
async function deleteScopeNodes(
  admin: DataSource,
  clientId: string,
  keep: readonly string[],
): Promise<void> {
  for (;;) {
    const removed = (await admin.query(
      `with leaves as (
         delete from ${S}."scope_node" sn
          where sn.client_id = $1
            and sn.id <> all($2::uuid[])
            and not exists (
              select 1 from ${S}."scope_node" c
               where c.client_id = sn.client_id and c.parent_id = sn.id
            )
         returning sn.id
       )
       select id from leaves`,
      [clientId, [...keep]],
    )) as { id: string }[];

    if (removed.length === 0) return;
  }
}

/** Every `s20-` tenant, and everything hanging off it. */
async function purge(admin: DataSource): Promise<void> {
  await admin.query(`select set_config('app.is_platform_admin', 'true', false)`);
  await admin.query(`select set_config('app.current_client_id', '', false)`);
  await admin.query(`delete from ${S}."service_account" where key = $1`, [
    PLATFORM_ACCOUNT_KEY,
  ]);

  const clients = (await admin.query(
    `select id from ${S}."client" where slug like $1`,
    [`${PREFIX}%`],
  )) as { id: string }[];

  for (const { id } of clients) {
    await elevate(admin, id);
    for (const statement of [
      `delete from ${S}."role_binding" where client_id = $1`,
      `delete from ${S}."session" where client_id = $1`,
      `delete from ${S}."user_identity" where client_id = $1`,
      `delete from ${S}."user" where client_id = $1`,
      `delete from ${S}."role" where client_id = $1`,
      `delete from ${S}."service_account" where client_id = $1`,
      `delete from ${S}."client_application" where client_id = $1`,
      `delete from ${S}."audit_trail" where client_id = $1`,
    ]) {
      await admin.query(statement, [id]);
    }
    await deleteScopeNodes(admin, id, []);
    await admin.query(`delete from ${S}."client" where id = $1`, [id]);
  }
}
