/**
 * The Session 21 Definition of Done: **the resolution correctness matrix of
 * Doc 04, over HTTP, against a real Postgres** (Doc 04 §3–5, §9, Doc 06 §11).
 *
 * Resolution is the one computation in this system that nothing else can check.
 * A binding is a row and a role is a row, and a mistake in either is visible as
 * a wrong row; a mistake here is a subject who quietly has access to a gate
 * nobody granted them, and the only artefact of it is a `true` where a `false`
 * belonged. So the matrix below is written as questions rather than as
 * assertions about internals: bind this, ask about that, and compare the answer
 * against Doc 04's own text.
 *
 * Almost every case is a claim about the *database* rather than about a
 * service. That ltree's `<@` and `path.util`'s `isWithin` agree about what lies
 * beneath what; that a binding at a plant covers its gates with no extra rows;
 * that `now()` decides expiry rather than this process's clock; that a
 * `client_application` toggle makes an application's permissions inert without
 * touching a single role mapping. A fake database can express none of them:
 *
 *   pg_ctl start                # a local Postgres 17 (see .env)
 *   npm run migration:run
 *   npx nx test @plantops/iam-api
 *
 * **Destructive within its own fixtures only.** Every client it creates is
 * slugged `s21-…` and every application key is `s21-…`; both are removed
 * afterwards with everything hanging off them.
 *
 * ## Why the bindings are inserted rather than posted
 *
 * `POST /iam/role-bindings` is Session 20's surface and has its own suite. Here
 * a binding is a *precondition*, not the subject of the test, and writing it
 * through the owner connection keeps each case's setup to one statement — and
 * lets the two cases that need a state the API refuses to create (an already
 * expired grant) be written at all.
 *
 * ## Deliberate deviations from the shipped configuration
 *
 * - **Rate limiting is off.** These cases make dozens of calls.
 * - **The grants cache is cleared between cases**, through the same
 *   `GrantsCacheService.bump()` that Session 22 will call from every mutation in
 *   Doc 04 §7's table. Until that wiring exists, a binding written here would
 *   otherwise be invisible behind an entry cached by the previous case — which
 *   is precisely the gap Session 22 closes, stated here as a `beforeEach`
 *   rather than left as a flake. Where Redis is not running, every read is a
 *   miss and the bump is a no-op; the matrix is identical either way, which is
 *   the point of resolving from Postgres on a miss.
 * - **Nothing else.** The validation pipe, the RLS context, the auth guard and
 *   the error envelope are the shipped ones.
 */

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { loadEnv } from '@plantops/config';
import {
  SubjectType,
  type AccessTokenResponse,
  type IntrospectResponse,
  type PermissionCheckResponse,
  type ResolvedGrants,
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
import { ENV } from '../config/config.module';
import { createTestApplication } from '../testing/app-harness';
import { GrantsCacheService } from './grants-cache.service';
import type { SubjectRef } from './resolver.service';

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
const PREFIX = 's21-';

/** A day out, so a slow suite cannot walk past an expiry mid-run. */
const TOMORROW = () => new Date(Date.now() + 86_400_000);
const YESTERDAY = () => new Date(Date.now() - 86_400_000);

/** A node of the fixture tree — the id a binding names, and the path it covers. */
interface Node {
  id: string;
  path: string;
}

/**
 * The catalog, which belongs to no tenant (Doc 01 §3.1–3.2).
 *
 * Two applications, because half the matrix is about the *slice*: the
 * `?applicationId=` filter, and the two ways an application stops granting —
 * disabled for one client (Doc 02 §6) and deactivated platform-wide (Doc 02 §7).
 */
interface Catalog {
  gatepassId: string;
  visitorId: string;
  /** Permission ids, for the role mappings. */
  approveId: string;
  createId: string;
  visitorReadId: string;
  /** The keys those ids stand for — what `resolve` returns. */
  approve: string;
  create: string;
  visitorRead: string;
}

/** One tenant: a tree three deep, three roles, a person and a machine. */
interface Tenant {
  clientId: string;
  slug: string;
  adminEmail: string;
  adminUserId: string;
  memberEmail: string;
  memberUserId: string;
  serviceAccountId: string;
  serviceAccountKey: string;
  /** `group → { plantA → gate1, gate2 }, { plantB → gate3 }`. */
  root: Node;
  plantA: Node;
  plantB: Node;
  gate1: Node;
  gate2: Node;
  gate3: Node;
  /** Maps `dc.approve`. */
  approverRoleId: string;
  /** Maps `dc.create`. */
  creatorRoleId: string;
  /** Maps the *other* application's `log.read`. */
  visitorRoleId: string;
}

interface Fixture {
  catalog: Catalog;
  acme: Tenant;
  other: Tenant;
}

describeWithDb(
  `resolution endpoints (${configured ? 'live' : 'skipped: no DATABASE_URL'})`,
  () => {
    let app: INestApplication;
    let baseUrl: string;
    let admin: DataSource;
    let fixture: Fixture;
    let cache: GrantsCacheService;

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
        catalog,
        acme: await seedTenant(admin, 'acme', secretHash, catalog),
        other: await seedTenant(admin, 'other', secretHash, catalog),
      };

      const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(ENV)
        .useValue({ ...env, RATE_LIMIT_ENABLED: false })
        .compile();

      app = createTestApplication(moduleRef);
      await app.init();
      await app.listen(0);
      baseUrl = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
      cache = app.get(GrantsCacheService);
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
      for (const tenant of [fixture.acme, fixture.other]) {
        await resetTenant(admin, tenant, fixture.catalog);
        for (const subject of subjectsOf(tenant)) await cache.bump(subject);
      }
      await reactivateCatalog(admin, fixture.catalog);
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

    const asMember = (tenant: Tenant = fixture.acme): Promise<string> =>
      login(tenant.memberEmail, tenant.slug);

    const asMachine = async (tenant: Tenant = fixture.acme): Promise<string> => {
      const response = await fetch(`${baseUrl}/auth/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          account_key: tenant.serviceAccountKey,
          account_secret: PASSWORD,
        }),
      });
      expect(response.status).toBe(200);
      return ((await response.json()) as AccessTokenResponse).access_token;
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

    const resolve = async (token: string, query = ''): Promise<ResolvedGrants> => {
      const response = await call(token, 'GET', `/iam/permissions/resolve${query}`);
      expect(response.status).toBe(200);
      return (await response.json()) as ResolvedGrants;
    };

    const check = async (
      token: string,
      permission: string,
      scopeNodeId: string,
    ): Promise<boolean> => {
      const response = await call(token, 'POST', '/iam/permissions/check', {
        permission,
        scopeNodeId,
      });
      expect(response.status).toBe(200);
      return ((await response.json()) as PermissionCheckResponse).allowed;
    };

    const introspect = async (
      token: string,
      subject: string,
    ): Promise<IntrospectResponse> => {
      const response = await call(token, 'POST', '/iam/introspect', { token: subject });
      expect(response.status).toBe(200);
      return (await response.json()) as IntrospectResponse;
    };

    /** Grants `role` at `node` to the member, straight to the table. */
    const grant = (
      node: Node,
      roleId: string,
      options: { tenant?: Tenant; expiresAt?: Date; serviceAccount?: boolean } = {},
    ): Promise<void> =>
      insertBinding(admin, options.tenant ?? fixture.acme, {
        roleId,
        scopeNodeId: node.id,
        expiresAt: options.expiresAt,
        serviceAccount: options.serviceAccount ?? false,
      });

    // ── the grant set (Doc 04 §4.1) ───────────────────────────────────────

    describe('resolve', () => {
      it('is empty for a subject with no bindings', async () => {
        // Deny-by-default, Doc 04 §9. No binding, no access, and no special
        // case anywhere downstream — the empty answer is an ordinary one.
        await expect(resolve(await asMember())).resolves.toEqual({
          permissions: [],
          scopes: {},
        });
      });

      it('returns the bound node’s path as the covering scope', async () => {
        const { plantA } = fixture.acme;
        await grant(plantA, fixture.acme.approverRoleId);

        expect(await resolve(await asMember())).toEqual({
          permissions: [fixture.catalog.approve],
          scopes: { [fixture.catalog.approve]: [plantA.path] },
        });
      });

      it('unions the permissions of every role the subject holds', async () => {
        await grant(fixture.acme.plantA, fixture.acme.approverRoleId);
        await grant(fixture.acme.gate3, fixture.acme.creatorRoleId);

        const grants = await resolve(await asMember());

        expect(grants.permissions.sort()).toEqual(
          [fixture.catalog.approve, fixture.catalog.create].sort(),
        );
        expect(grants.scopes[fixture.catalog.approve]).toEqual([fixture.acme.plantA.path]);
        expect(grants.scopes[fixture.catalog.create]).toEqual([fixture.acme.gate3.path]);
      });

      it('keeps sibling subtrees as separate covering paths', async () => {
        await grant(fixture.acme.gate1, fixture.acme.approverRoleId);
        await grant(fixture.acme.gate3, fixture.acme.approverRoleId);

        const grants = await resolve(await asMember());

        // Neither covers the other, so minimization has nothing to do — which
        // is as much a part of the rule as the case where it does.
        expect(grants.scopes[fixture.catalog.approve]).toEqual(
          [fixture.acme.gate1.path, fixture.acme.gate3.path].sort(),
        );
      });

      it('reduces an ancestor and its descendant to the ancestor alone', async () => {
        const { root, plantA, gate1 } = fixture.acme;
        await grant(gate1, fixture.acme.approverRoleId);
        await grant(plantA, fixture.acme.approverRoleId);
        await grant(root, fixture.acme.approverRoleId);

        // Doc 04 §4.1's required minimization. All three rows are legal — Doc 01
        // §4.5 makes an ancestor/descendant pair deliberately not a duplicate —
        // and the covering set is one path, because the root already covers the
        // other two by `<@`.
        expect((await resolve(await asMember())).scopes[fixture.catalog.approve]).toEqual([
          root.path,
        ]);

        expect(await bindingCount(admin, fixture.acme)).toBe(3);
      });

      it('minimizes each permission independently', async () => {
        await grant(fixture.acme.root, fixture.acme.approverRoleId);
        await grant(fixture.acme.gate1, fixture.acme.creatorRoleId);

        const grants = await resolve(await asMember());

        expect(grants.scopes[fixture.catalog.approve]).toEqual([fixture.acme.root.path]);
        // Not absorbed by the root above: the root grant carries a different
        // permission, and coverage never crosses the permission dimension.
        expect(grants.scopes[fixture.catalog.create]).toEqual([fixture.acme.gate1.path]);
      });

      it('honours a future expiry and ignores a lapsed one', async () => {
        await grant(fixture.acme.plantA, fixture.acme.approverRoleId, {
          expiresAt: TOMORROW(),
        });
        await grant(fixture.acme.plantB, fixture.acme.creatorRoleId, {
          expiresAt: YESTERDAY(),
        });

        const grants = await resolve(await asMember());

        // Doc 01 §4.5: the lapsed row is still there — `bindings.service.ts`
        // lists it and flags it — and contributes nothing. Decided by `now()`
        // in the same statement, not by this process's clock.
        expect(grants.permissions).toEqual([fixture.catalog.approve]);
        expect(await bindingCount(admin, fixture.acme)).toBe(2);
      });

      it('resolves a service account exactly like a person', async () => {
        await grant(fixture.acme.plantB, fixture.acme.approverRoleId, {
          serviceAccount: true,
        });

        // Doc 09 §3.5: a machine identity holds roles at scopes the same way,
        // which is why the resolver's only difference between them is which
        // column it reads.
        expect(await resolve(await asMachine())).toEqual({
          permissions: [fixture.catalog.approve],
          scopes: { [fixture.catalog.approve]: [fixture.acme.plantB.path] },
        });

        // …and the person, bound to nothing, still holds nothing.
        expect((await resolve(await asMember())).permissions).toEqual([]);
      });

      it('never returns another tenant’s grants', async () => {
        await grant(fixture.acme.root, fixture.acme.approverRoleId);
        await grant(fixture.other.root, fixture.other.creatorRoleId, {
          tenant: fixture.other,
        });

        expect((await resolve(await asMember())).permissions).toEqual([
          fixture.catalog.approve,
        ]);
        expect((await resolve(await asMember(fixture.other))).permissions).toEqual([
          fixture.catalog.create,
        ]);
      });
    });

    // ── the catalog's three off-switches (Doc 02 §6–7, Doc 04 §7) ─────────

    describe('permissions that have stopped granting', () => {
      it('drops an application disabled for this client', async () => {
        await grant(fixture.acme.root, fixture.acme.approverRoleId);
        await grant(fixture.acme.root, fixture.acme.visitorRoleId);

        expect((await resolve(await asMember())).permissions.sort()).toEqual(
          [fixture.catalog.approve, fixture.catalog.visitorRead].sort(),
        );

        await setApplicationEnabled(admin, fixture.acme, fixture.catalog.visitorId, false);
        await bumpAll(cache, fixture.acme);

        // Doc 04 §7: "disabling makes the app's permissions inert". The role
        // mapping is untouched — nothing was deleted — and the grant is simply
        // absent, which is what makes re-enabling restore it.
        expect((await resolve(await asMember())).permissions).toEqual([
          fixture.catalog.approve,
        ]);

        await setApplicationEnabled(admin, fixture.acme, fixture.catalog.visitorId, true);
        await bumpAll(cache, fixture.acme);

        expect((await resolve(await asMember())).permissions.sort()).toEqual(
          [fixture.catalog.approve, fixture.catalog.visitorRead].sort(),
        );
      });

      it('drops an application deactivated platform-wide', async () => {
        await grant(fixture.acme.root, fixture.acme.visitorRoleId);
        await setApplicationActive(admin, fixture.catalog.visitorId, false);
        await bumpAll(cache, fixture.acme);

        expect((await resolve(await asMember())).permissions).toEqual([]);
      });

      it('drops a permission retired from its catalog', async () => {
        await grant(fixture.acme.root, fixture.acme.approverRoleId);
        await setPermissionActive(admin, fixture.catalog.approveId, false);
        await bumpAll(cache, fixture.acme);

        // Doc 02 §7's soft deactivation. Doc 04 §7 lists it as an invalidation
        // trigger precisely because "cached grants may still reference a
        // now-inert permission key" — which is only a hazard if resolution
        // treats it as live, and it does not.
        expect((await resolve(await asMember())).permissions).toEqual([]);
      });
    });

    // ── the slice (Doc 06 §11) ────────────────────────────────────────────

    describe('?applicationId=', () => {
      it('returns only that application’s permissions', async () => {
        await grant(fixture.acme.plantA, fixture.acme.approverRoleId);
        await grant(fixture.acme.plantB, fixture.acme.visitorRoleId);

        const token = await asMember();

        expect(await resolve(token, `?applicationId=${fixture.catalog.gatepassId}`)).toEqual(
          {
            permissions: [fixture.catalog.approve],
            scopes: { [fixture.catalog.approve]: [fixture.acme.plantA.path] },
          },
        );
        expect(await resolve(token, `?applicationId=${fixture.catalog.visitorId}`)).toEqual({
          permissions: [fixture.catalog.visitorRead],
          scopes: { [fixture.catalog.visitorRead]: [fixture.acme.plantB.path] },
        });
      });

      it('is empty for an application the subject holds nothing in', async () => {
        await grant(fixture.acme.plantA, fixture.acme.approverRoleId);

        expect(
          await resolve(await asMember(), `?applicationId=${fixture.catalog.visitorId}`),
        ).toEqual({ permissions: [], scopes: {} });
      });

      it('refuses an application id that is not a uuid', async () => {
        const response = await call(
          await asMember(),
          'GET',
          '/iam/permissions/resolve?applicationId=gatepass',
        );

        expect(response.status).toBe(400);
      });
    });

    // ── the point check (Doc 04 §3, §4.2, §9) ─────────────────────────────

    describe('check', () => {
      it('covers the bound node and every node beneath it', async () => {
        await grant(fixture.acme.plantA, fixture.acme.approverRoleId);
        const token = await asMember();
        const { approve } = fixture.catalog;

        // Doc 04 §3's worked example: a role bound at Plant A covers Gate 1 and
        // Gate 2 automatically, with no extra rows.
        expect(await check(token, approve, fixture.acme.plantA.id)).toBe(true);
        expect(await check(token, approve, fixture.acme.gate1.id)).toBe(true);
        expect(await check(token, approve, fixture.acme.gate2.id)).toBe(true);
      });

      it('does not cover an ancestor of the bound node', async () => {
        await grant(fixture.acme.plantA, fixture.acme.approverRoleId);

        // Coverage runs downwards only. Being able to approve at one plant is
        // not authority over the group that contains it.
        expect(
          await check(await asMember(), fixture.catalog.approve, fixture.acme.root.id),
        ).toBe(false);
      });

      it('does not cover a sibling plant or its gates', async () => {
        await grant(fixture.acme.plantA, fixture.acme.approverRoleId);
        const token = await asMember();

        expect(await check(token, fixture.catalog.approve, fixture.acme.plantB.id)).toBe(
          false,
        );
        expect(await check(token, fixture.catalog.approve, fixture.acme.gate3.id)).toBe(
          false,
        );
      });

      it('preserves the permission asymmetry — approve does not imply create', async () => {
        await grant(fixture.acme.root, fixture.acme.approverRoleId);
        const token = await asMember();

        // Doc 04 §9, the deliberate asymmetry: inheritance exists on the scope
        // dimension and on no other.
        expect(await check(token, fixture.catalog.approve, fixture.acme.gate1.id)).toBe(
          true,
        );
        expect(await check(token, fixture.catalog.create, fixture.acme.gate1.id)).toBe(
          false,
        );
      });

      it('is false, not 404, for another tenant’s node', async () => {
        await grant(fixture.acme.root, fixture.acme.approverRoleId);

        // Doc 06 §2: a denial must not reveal whether the target exists
        // elsewhere. A foreign node and a nonexistent one are indistinguishable
        // — both are simply nodes this subject holds nothing at.
        expect(
          await check(
            await asMember(),
            fixture.catalog.approve,
            fixture.other.plantA.id,
          ),
        ).toBe(false);
        expect(
          await check(await asMember(), fixture.catalog.approve, randomUUID()),
        ).toBe(false);
      });

      it('is false for a permission no application has ever registered', async () => {
        await grant(fixture.acme.root, fixture.acme.approverRoleId);

        expect(
          await check(await asMember(), 'nothing.of.the.sort', fixture.acme.gate1.id),
        ).toBe(false);
      });

      it('is false once the binding has expired', async () => {
        await grant(fixture.acme.plantA, fixture.acme.approverRoleId, {
          expiresAt: YESTERDAY(),
        });

        expect(
          await check(await asMember(), fixture.catalog.approve, fixture.acme.gate1.id),
        ).toBe(false);
      });
    });

    // ── introspection (Doc 06 §11) ────────────────────────────────────────

    describe('introspect', () => {
      it('reports a live token with its subject', async () => {
        const token = await asMember();

        expect(await introspect(token, token)).toMatchObject({
          active: true,
          cid: fixture.acme.clientId,
          sub: fixture.acme.memberUserId,
          sty: SubjectType.USER,
        });
      });

      it('reports a token whose session was revoked as inactive', async () => {
        const token = await asMember();
        expect(await introspect(token, token)).toMatchObject({ active: true });

        const logout = await call(token, 'POST', '/auth/logout');
        expect(logout.status).toBe(204);

        // The whole reason this endpoint exists beside JWKS: `exp` has not
        // moved, so a local verifier would still accept this token. Only the
        // issuer knows the session is dead.
        const caller = await asMember();
        expect(await introspect(caller, token)).toEqual({ active: false });
      });

      it('reports anything that is not a token as inactive, never as an error', async () => {
        const token = await asMember();

        expect(await introspect(token, 'not-a-token')).toEqual({ active: false });
        expect(await introspect(token, `${token}x`)).toEqual({ active: false });
      });
    });

    // ── the surface itself ────────────────────────────────────────────────

    describe('the endpoints', () => {
      it('require a bearer token', async () => {
        for (const [method, path] of [
          ['GET', '/iam/permissions/resolve'],
          ['POST', '/iam/permissions/check'],
          ['POST', '/iam/introspect'],
        ] as const) {
          const response = await fetch(`${baseUrl}${path}`, {
            method,
            headers: { 'content-type': 'application/json' },
            body: method === 'GET' ? undefined : '{}',
          });
          expect(response.status).toBe(401);
        }
      });

      it('answers an ordinary member, with no administrative rights at all', async () => {
        await grant(fixture.acme.root, fixture.acme.approverRoleId);

        // The member is not `is_client_admin`, and these routes carry no
        // `assertAdministrator()` — they answer questions about the bearer, so
        // holding the token is the whole of the authorization
        // (`authz.controller.ts`). Asserted here because the *absence* of a
        // check is the kind of thing a later session adds "for consistency".
        const denied = await call(await asMember(), 'GET', '/iam/role-bindings');
        expect(denied.status).toBe(403);

        expect((await resolve(await asMember())).permissions).toEqual([
          fixture.catalog.approve,
        ]);
      });
    });
  },
);

/** The subjects a tenant's cases resolve for. */
function subjectsOf(tenant: Tenant): SubjectRef[] {
  return [
    { clientId: tenant.clientId, type: SubjectType.USER, id: tenant.memberUserId },
    { clientId: tenant.clientId, type: SubjectType.USER, id: tenant.adminUserId },
    {
      clientId: tenant.clientId,
      type: SubjectType.SERVICE,
      id: tenant.serviceAccountId,
    },
  ];
}

/** What Session 22 will do from the mutation itself — see the header. */
async function bumpAll(cache: GrantsCacheService, tenant: Tenant): Promise<void> {
  for (const subject of subjectsOf(tenant)) await cache.bump(subject);
}

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
 * Two applications and three permissions, in the catalog every tenant shares
 * (Doc 01 §3.1–3.2).
 *
 * The keys are namespaced by application, as Doc 02 §2 has them, so the matrix
 * reads the way a real grant set does — `s21gatepass.dc.approve` rather than a
 * bare verb whose owner nobody can tell.
 */
async function seedCatalog(admin: DataSource): Promise<Catalog> {
  const suffix = randomUUID().slice(0, 8);
  const gatepassId = randomUUID();
  const visitorId = randomUUID();
  const approveId = randomUUID();
  const createId = randomUUID();
  const visitorReadId = randomUUID();

  await admin.query(`select set_config('app.is_platform_admin', 'true', false)`);
  await admin.query(`select set_config('app.current_client_id', '', false)`);

  for (const [id, key, name] of [
    [gatepassId, `${PREFIX}gatepass-${suffix}`, 'Session 21 Gatepass'],
    [visitorId, `${PREFIX}visitor-${suffix}`, 'Session 21 Visitor'],
  ] as const) {
    await admin.query(
      `insert into ${S}."application" (id, key, name) values ($1, $2, $3)`,
      [id, key, name],
    );
  }

  const catalog: Catalog = {
    gatepassId,
    visitorId,
    approveId,
    createId,
    visitorReadId,
    approve: `s21gatepass${suffix}.dc.approve`,
    create: `s21gatepass${suffix}.dc.create`,
    visitorRead: `s21visitor${suffix}.log.read`,
  };

  for (const [id, applicationId, key, name] of [
    [approveId, gatepassId, catalog.approve, 'Approve a delivery challan'],
    [createId, gatepassId, catalog.create, 'Create a delivery challan'],
    [visitorReadId, visitorId, catalog.visitorRead, 'Read the visitor log'],
  ] as const) {
    await admin.query(
      `insert into ${S}."permission" (id, application_id, key, name)
       values ($1, $2, $3, $4)`,
      [id, applicationId, key, name],
    );
  }

  return catalog;
}

/**
 * One tenant: a tree three levels deep, three roles mapped to the catalog, a
 * person, an administrator and a machine identity.
 *
 * Seeded directly rather than through the APIs that create them, so this suite
 * does not depend on Sessions 13–20 — the same choice
 * `bindings.integration.spec.ts` makes, for the same reason.
 */
async function seedTenant(
  admin: DataSource,
  label: string,
  secretHash: string,
  catalog: Catalog,
): Promise<Tenant> {
  const suffix = randomUUID().slice(0, 8);

  const node = (id: string, parentPath?: string): Node => ({
    id,
    path: parentPath === undefined ? scopePathLabel(id) : `${parentPath}.${scopePathLabel(id)}`,
  });

  const root = node(randomUUID());
  const plantA = node(randomUUID(), root.path);
  const plantB = node(randomUUID(), root.path);
  const gate1 = node(randomUUID(), plantA.path);
  const gate2 = node(randomUUID(), plantA.path);
  const gate3 = node(randomUUID(), plantB.path);

  const tenant: Tenant = {
    clientId: randomUUID(),
    slug: `${PREFIX}${label}-${suffix}`,
    adminEmail: `admin-${label}-${suffix}@example.test`,
    adminUserId: randomUUID(),
    memberEmail: `member-${label}-${suffix}@example.test`,
    memberUserId: randomUUID(),
    serviceAccountId: randomUUID(),
    serviceAccountKey: `${PREFIX}${label}-${suffix}`,
    root,
    plantA,
    plantB,
    gate1,
    gate2,
    gate3,
    approverRoleId: randomUUID(),
    creatorRoleId: randomUUID(),
    visitorRoleId: randomUUID(),
  };

  await elevate(admin, tenant.clientId);
  await admin.query(
    `insert into ${S}."client" (id, name, slug, status) values ($1, $2, $3, 'active')`,
    [tenant.clientId, `Session 21 ${label} ${suffix}`, tenant.slug],
  );

  for (const [id, email, name, isAdmin] of [
    [tenant.adminUserId, tenant.adminEmail, 'Session 21 Admin', true],
    [tenant.memberUserId, tenant.memberEmail, 'Session 21 Member', false],
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

  await admin.query(
    `insert into ${S}."service_account" (id, client_id, name, key, key_hash, status)
     values ($1, $2, 'Session 21 Integration', $3, $4, 'active')`,
    [tenant.serviceAccountId, tenant.clientId, tenant.serviceAccountKey, secretHash],
  );

  for (const [current, parentId, kind, name] of [
    [root, null, 'group', `Session 21 ${label}`],
    [plantA, root.id, 'plant', 'Plant A'],
    [plantB, root.id, 'plant', 'Plant B'],
    [gate1, plantA.id, 'gate', 'Gate 1'],
    [gate2, plantA.id, 'gate', 'Gate 2'],
    [gate3, plantB.id, 'gate', 'Gate 3'],
  ] as const) {
    await admin.query(
      `insert into ${S}."scope_node" (id, client_id, parent_id, kind, name, path)
       values ($1, $2, $3, $4, $5, $6::ltree)`,
      [current.id, tenant.clientId, parentId, kind, name, current.path],
    );
  }

  for (const [id, name, permissionId] of [
    [tenant.approverRoleId, 'Session 21 Approver', catalog.approveId],
    [tenant.creatorRoleId, 'Session 21 Creator', catalog.createId],
    [tenant.visitorRoleId, 'Session 21 Visitor', catalog.visitorReadId],
  ] as const) {
    await admin.query(
      `insert into ${S}."role" (id, client_id, name, description)
       values ($1, $2, $3, 'Session 21 fixture')`,
      [id, tenant.clientId, name],
    );
    await admin.query(
      `insert into ${S}."role_permission" (role_id, permission_id) values ($1, $2)`,
      [id, permissionId],
    );
  }

  for (const applicationId of [catalog.gatepassId, catalog.visitorId]) {
    await admin.query(
      `insert into ${S}."client_application" (client_id, application_id, enabled)
       values ($1, $2, true)`,
      [tenant.clientId, applicationId],
    );
  }

  return tenant;
}

/** A binding written straight to the table — the precondition, not the subject. */
async function insertBinding(
  admin: DataSource,
  tenant: Tenant,
  options: {
    roleId: string;
    scopeNodeId: string;
    expiresAt?: Date;
    serviceAccount: boolean;
  },
): Promise<void> {
  await elevate(admin, tenant.clientId);
  await admin.query(
    `insert into ${S}."role_binding"
       (client_id, user_id, service_account_id, role_id, scope_node_id, expires_at)
     values ($1, $2, $3, $4, $5, $6)`,
    [
      tenant.clientId,
      options.serviceAccount ? null : tenant.memberUserId,
      options.serviceAccount ? tenant.serviceAccountId : null,
      options.roleId,
      options.scopeNodeId,
      options.expiresAt ?? null,
    ],
  );
}

async function bindingCount(admin: DataSource, tenant: Tenant): Promise<number> {
  await elevate(admin, tenant.clientId);
  const [row] = (await admin.query(
    `select count(*)::int as total from ${S}."role_binding" where client_id = $1`,
    [tenant.clientId],
  )) as { total: number }[];
  return row?.total ?? 0;
}

async function setApplicationEnabled(
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

async function setApplicationActive(
  admin: DataSource,
  applicationId: string,
  isActive: boolean,
): Promise<void> {
  await admin.query(`select set_config('app.is_platform_admin', 'true', false)`);
  await admin.query(`update ${S}."application" set is_active = $2 where id = $1`, [
    applicationId,
    isActive,
  ]);
}

async function setPermissionActive(
  admin: DataSource,
  permissionId: string,
  isActive: boolean,
): Promise<void> {
  await admin.query(`select set_config('app.is_platform_admin', 'true', false)`);
  await admin.query(`update ${S}."permission" set is_active = $2 where id = $1`, [
    permissionId,
    isActive,
  ]);
}

/** Back to a tenant with no grants, no sessions, and both applications on. */
async function resetTenant(
  admin: DataSource,
  tenant: Tenant,
  catalog: Catalog,
): Promise<void> {
  await elevate(admin, tenant.clientId);
  await admin.query(`delete from ${S}."role_binding" where client_id = $1`, [
    tenant.clientId,
  ]);
  await admin.query(`delete from ${S}."session" where client_id = $1`, [tenant.clientId]);
  await admin.query(
    `update ${S}."client_application" set enabled = true
      where client_id = $1 and application_id = any($2::uuid[])`,
    [tenant.clientId, [catalog.gatepassId, catalog.visitorId]],
  );
  await admin.query(`delete from ${S}."audit_trail" where client_id = $1`, [
    tenant.clientId,
  ]);
}

/** Undoes whatever a case switched off in the shared catalog. */
async function reactivateCatalog(admin: DataSource, catalog: Catalog): Promise<void> {
  await admin.query(`select set_config('app.is_platform_admin', 'true', false)`);
  await admin.query(
    `update ${S}."application" set is_active = true where id = any($1::uuid[])`,
    [[catalog.gatepassId, catalog.visitorId]],
  );
  await admin.query(
    `update ${S}."permission" set is_active = true where id = any($1::uuid[])`,
    [[catalog.approveId, catalog.createId, catalog.visitorReadId]],
  );
}

/** Every `s21-` tenant and application, and everything hanging off them. */
async function purge(admin: DataSource): Promise<void> {
  await admin.query(`select set_config('app.is_platform_admin', 'true', false)`);
  await admin.query(`select set_config('app.current_client_id', '', false)`);

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
    await deleteScopeNodes(admin, id);
    await admin.query(`delete from ${S}."client" where id = $1`, [id]);
  }

  await admin.query(`select set_config('app.is_platform_admin', 'true', false)`);
  await admin.query(`select set_config('app.current_client_id', '', false)`);
  // `permission` cascades from `application`; the role mappings that referenced
  // them went with the roles above.
  await admin.query(`delete from ${S}."application" where key like $1`, [`${PREFIX}%`]);
}

/**
 * Deletes a client's scope nodes leaf-first.
 *
 * A single `delete` over the whole set would not do: the parent key is `on
 * delete restrict`, which Postgres checks per row and immediately, so a
 * statement removing a parent and its child in one pass is refused even though
 * the child is going too. Deleting whatever currently has no children, and
 * repeating, terminates at the depth of the tree.
 */
async function deleteScopeNodes(admin: DataSource, clientId: string): Promise<void> {
  for (;;) {
    const removed = (await admin.query(
      `with leaves as (
         delete from ${S}."scope_node" sn
          where sn.client_id = $1
            and not exists (
              select 1 from ${S}."scope_node" c
               where c.client_id = sn.client_id and c.parent_id = sn.id
            )
         returning sn.id
       )
       select id from leaves`,
      [clientId],
    )) as { id: string }[];

    if (removed.length === 0) return;
  }
}
