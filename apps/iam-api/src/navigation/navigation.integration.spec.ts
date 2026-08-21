/**
 * The Session 24 Definition of Done: **the pruning matrix and a live catalog
 * edit, over HTTP, against a real Postgres** (Doc 05, Doc 06 §11).
 *
 * `prune.spec.ts` decides the rule over plain values. What only a live database
 * can decide is everything the rule is applied *to*: that `client_application`
 * enablement and `application.is_active` are two different switches with
 * different owners; that catalog rows are globally readable while enablement is
 * not, so one tenant's menu never depends on another's toggles; that
 * `is_active = false` on a nav node removes it and its subtree; that
 * `sort_order` and not `key` decides sibling order; and — the claim Doc 05 §1
 * exists to make — that an administrator adding a menu and mapping a permission
 * to it through the API changes the next caller's menu, with no deploy and no
 * restart.
 *
 *   pg_ctl start                # a local Postgres 17 (see .env)
 *   npm run migration:run
 *   npx nx test @plantops/iam-api
 *
 * **Destructive within its own fixtures only.** Every application it creates is
 * keyed `s24-…` and every client slugged `s24-…`; both are removed afterwards
 * with everything hanging off them, along with the audit rows its catalog edits
 * wrote — identified by the application they name, so the suite cannot delete
 * another's.
 *
 * ## Why the catalog is seeded directly and the *edit* is not
 *
 * The fixture tree is written straight to the tables: it is a precondition, and
 * a suite about pruning should not fail because Session 13's request shape moved.
 * The one case that does go through `POST /iam/applications/:id/nav` and
 * `…/nav-permissions` is the case whose whole subject is that route — Doc 05 §1's
 * "add a menu in the admin UI, map a permission to it, and it appears for exactly
 * the users who hold that permission". That case also primes the cache *before*
 * the edit, so wherever Redis is up a missing `app_nav_version` bump (Doc 05 §6)
 * fails it rather than passing quietly — and `the nav-catalog version` block
 * below closes the gap on a machine without Redis, by spying on the bump instead
 * of on its effect.
 *
 * ## Deliberate deviations from the shipped configuration
 *
 * - **Rate limiting is off.** These cases make dozens of calls.
 * - **The grants cache is cleared between cases**, through `GrantsCacheService`,
 *   for the reason `authz.integration.spec.ts` gives: the bindings here are
 *   written directly, so no service runs and no invalidation fires.
 * - **Where Redis is not running, every cache read is a miss and every bump a
 *   no-op.** Every assertion below holds either way — that is the point of
 *   reading through to Postgres on a miss. The counter *protocol* is therefore
 *   not asserted here at all but in `nav-catalog-cache.service.spec.ts`, where an
 *   expired counter and an entry written before an edit can be constructed rather
 *   than waited for; what this suite asserts is that the right call is made, with
 *   the right argument, at the right moment.
 * - **Nothing else.** The auth guard, the permission guard, the RLS context, the
 *   validation pipe and the error envelope are the shipped ones.
 */

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { loadEnv } from '@plantops/config';
import {
  NavNodeKind,
  SubjectType,
  type AccessTokenResponse,
  type NavNodeDTO,
  type NavigationResponse,
  type TokenPairResponse,
} from '@plantops/contracts';
import {
  IAM_SCHEMA,
  IAM_SCHEMA_TEST_LOCK_ID,
  PLATFORM_SERVICE_ACCOUNT_KEY,
  createMigrationDataSource,
  hashSecret,
  scopePathLabel,
} from '@plantops/db';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { DataSource } from 'typeorm';
import { AppModule } from '../app/app.module';
import { GrantsCacheService } from '../authz/grants-cache.service';
import type { SubjectRef } from '../authz/resolver.service';
import { ENV } from '../config/env.token';
import { createTestApplication } from '../testing/app-harness';
import { NavCatalogCacheService } from './nav-catalog-cache.service';

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
const PREFIX = 's24-';

/**
 * The two applications every tenant shares, and the permissions behind them.
 *
 * Two, because half of what is under test is the *shell*: one application per
 * top-level node, and an application dropped when the subject can see nothing in
 * it. `gatepass` carries a public leaf and `visitor` deliberately does not, which
 * is what makes "an application with nothing visible disappears" observable.
 */
interface Catalog {
  gatepassId: string;
  gatepassKey: string;
  gatepassName: string;
  visitorId: string;
  visitorKey: string;
  visitorName: string;
  /** Permission ids, for the role mappings. */
  dcReadId: string;
  dcApproveId: string;
  manageId: string;
  visitorReadId: string;
  /** The keys those ids stand for. */
  dcRead: string;
  dcApprove: string;
  manage: string;
  visitorRead: string;
}

/** One tenant: a three-deep tree, four roles, a person and a machine. */
interface Tenant {
  clientId: string;
  slug: string;
  memberEmail: string;
  memberUserId: string;
  serviceAccountId: string;
  serviceAccountKey: string;
  rootId: string;
  gateId: string;
  readerRoleId: string;
  approverRoleId: string;
  managerRoleId: string;
  visitorRoleId: string;
}

interface Fixture {
  catalog: Catalog;
  acme: Tenant;
  /** Has only the `visitor` application enabled — enablement is per tenant. */
  other: Tenant;
}

describeWithDb(
  `dynamic navigation (${configured ? 'live' : 'skipped: no DATABASE_URL'})`,
  () => {
    let app: INestApplication;
    let baseUrl: string;
    let admin: DataSource;
    let fixture: Fixture;
    let bootstrapSecret: string;
    let grants: GrantsCacheService;
    let navCache: NavCatalogCacheService;

    jest.setTimeout(180_000);

    beforeAll(async () => {
      const env = loadEnv();
      bootstrapSecret = env.PLATFORM_BOOTSTRAP_SECRET;

      admin = createMigrationDataSource(env);
      await admin.initialize();
      await admin.query('select pg_advisory_lock($1)', [IAM_SCHEMA_TEST_LOCK_ID]);
      await purge(admin);

      const secretHash = await hashSecret(PASSWORD);
      const catalog = await seedCatalog(admin);
      fixture = {
        catalog,
        acme: await seedTenant(admin, 'acme', secretHash, catalog, [
          catalog.gatepassId,
          catalog.visitorId,
        ]),
        other: await seedTenant(admin, 'other', secretHash, catalog, [
          catalog.visitorId,
        ]),
      };

      const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(ENV)
        .useValue({ ...env, RATE_LIMIT_ENABLED: false })
        .compile();

      app = createTestApplication(moduleRef);
      await app.init();
      await app.listen(0);
      baseUrl = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
      grants = app.get(GrantsCacheService);
      navCache = app.get(NavCatalogCacheService);
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
        await reset(admin, tenant, fixture.catalog);
        for (const subject of subjectsOf(tenant)) await grants.bump(subject);
      }
      await reactivateCatalog(admin, fixture.catalog);
      await resetNavCatalog(admin, navCache, fixture.catalog);
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

    const asMember = async (tenant: Tenant = fixture.acme): Promise<string> => {
      const response = await fetch(`${baseUrl}/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          email: tenant.memberEmail,
          password: PASSWORD,
          client_slug: tenant.slug,
        }),
      });
      expect(response.status).toBe(200);
      return ((await response.json()) as TokenPairResponse).access_token;
    };

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

    /** The bootstrap identity — the platform subject that seeds every catalog. */
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

    const navigation = async (
      token: string,
      applicationId?: string,
    ): Promise<NavigationResponse> => {
      const query =
        applicationId === undefined ? '' : `?applicationId=${applicationId}`;
      const response = await call(token, 'GET', `/iam/navigation${query}`);
      expect(response.status).toBe(200);
      return (await response.json()) as NavigationResponse;
    };

    /** Grants a role at a node, straight to the table — the precondition. */
    const grant = (
      roleId: string,
      options: { tenant?: Tenant; nodeId?: string; serviceAccount?: boolean } = {},
    ): Promise<void> =>
      insertBinding(admin, options.tenant ?? fixture.acme, {
        roleId,
        nodeId: options.nodeId,
        serviceAccount: options.serviceAccount ?? false,
      });

    /** `[key, [childKey, …]]` per visible node — the shape of an answer. */
    const shape = (tree: readonly NavNodeDTO[]): unknown[] =>
      tree.map((node) =>
        node.children.length === 0 ? node.key : [node.key, shape(node.children)],
      );

    /** Every key anywhere in the tree, for "this never appears" assertions. */
    const keysOf = (tree: readonly NavNodeDTO[]): string[] =>
      tree.flatMap((node) => [node.key, ...keysOf(node.children)]);

    // ── one application (Doc 05 §4, §5) ───────────────────────────────────

    describe('one application’s tree', () => {
      const gatepass = (token: string) =>
        navigation(token, fixture.catalog.gatepassId);

      it('names the application and shows a subject with no grants only its public leaf', async () => {
        const response = await gatepass(await asMember());

        // Doc 05 §3 rule 1's opt-in, and rule 2 keeping the container that holds
        // it. Everything else in the catalog is either gated on a permission this
        // subject does not have or unmapped and not public.
        expect(response.application).toEqual({
          id: fixture.catalog.gatepassId,
          key: fixture.catalog.gatepassKey,
          name: fixture.catalog.gatepassName,
        });
        expect(shape(response.tree)).toEqual([['ops', ['ops.help']]]);
      });

      it('reveals a leaf when one of its mapped permissions is held', async () => {
        // `ops.dc` requires `dc.read` OR `dc.approve`; `ops.board` requires
        // `dc.approve` alone. The reader therefore gets one and not the other,
        // which is the OR of Doc 05 §3 rule 1 and its limit in one assertion.
        await grant(fixture.acme.readerRoleId);

        expect(shape((await gatepass(await asMember())).tree)).toEqual([
          ['ops', ['ops.dc', 'ops.help']],
        ]);
      });

      it('reveals both leaves for the permission that gates both', async () => {
        await grant(fixture.acme.approverRoleId);

        expect(shape((await gatepass(await asMember())).tree)).toEqual([
          ['ops', ['ops.dc', 'ops.board', 'ops.help']],
        ]);
      });

      it('never returns an unmapped, non-public leaf — however much is held', async () => {
        // Invariant I3. Three roles, every permission in the application, and
        // `ops.hidden` is still absent: it is a configuration gap, and Doc 05 §3
        // rule 1 hides a gap rather than opening it.
        await grant(fixture.acme.readerRoleId);
        await grant(fixture.acme.approverRoleId);
        await grant(fixture.acme.managerRoleId);

        const keys = keysOf((await gatepass(await asMember())).tree);

        expect(keys).not.toContain('ops.hidden');
        expect(keys).toContain('ops.dc');
      });

      it('excludes an inactive node although its gate is held', async () => {
        // Doc 05 §3 rule 4. `ops.retired` maps `dc.read`, which the reader holds.
        await grant(fixture.acme.readerRoleId);

        expect(keysOf((await gatepass(await asMember())).tree)).not.toContain(
          'ops.retired',
        );
      });

      it('drops the subtree of a deactivated container rather than promoting it', async () => {
        // Deactivating the `ops` module leaves `ops.dc` active with a parent that
        // no longer reaches the catalog. It must vanish with its module, not
        // reappear at the top of the sidebar.
        await grant(fixture.acme.readerRoleId);
        await setNavNodeActive(admin, navCache, fixture.catalog.gatepassId, 'ops', false);

        expect((await gatepass(await asMember())).tree).toEqual([]);
      });

      it('prunes a container with no visible descendant, and keeps it once there is one', async () => {
        // The `admin` module holds exactly one gated leaf.
        await grant(fixture.acme.readerRoleId);
        expect(keysOf((await gatepass(await asMember())).tree)).not.toContain('admin');

        await grant(fixture.acme.managerRoleId);
        for (const subject of subjectsOf(fixture.acme)) await grants.bump(subject);

        expect(shape((await gatepass(await asMember())).tree)).toEqual([
          ['ops', ['ops.dc', 'ops.help']],
          ['admin', ['admin.settings']],
        ]);
      });

      it('orders siblings by sort_order and not by key', async () => {
        // `ops.board` sorts alphabetically before `ops.dc` and is given the higher
        // `sort_order`, so an implementation that fell back to key order would
        // return them the other way round.
        await grant(fixture.acme.approverRoleId);

        const [ops] = (await gatepass(await asMember())).tree;

        expect(ops.children.map((child) => child.key)).toEqual([
          'ops.dc',
          'ops.board',
          'ops.help',
        ]);
      });

      it('is decided by permissions and not by scope', async () => {
        // Doc 05 §3's closing note: "a guard who has `visitor.checkin` at any gate
        // sees the Visitor menu; the screen then shows only their gate's data".
        // Binding the same role at the deepest node of the tree instead of the
        // root must produce the identical menu — nav resolution asks the WHAT and
        // never the WHERE.
        await grant(fixture.acme.readerRoleId, { nodeId: fixture.acme.gateId });
        const atGate = shape((await gatepass(await asMember())).tree);

        await deleteBindings(admin, fixture.acme);
        await grant(fixture.acme.readerRoleId, { nodeId: fixture.acme.rootId });
        for (const subject of subjectsOf(fixture.acme)) await grants.bump(subject);
        const atRoot = shape((await gatepass(await asMember())).tree);

        expect(atGate).toEqual([['ops', ['ops.dc', 'ops.help']]]);
        expect(atRoot).toEqual(atGate);
      });

      it('resolves a service account’s menu exactly like a person’s', async () => {
        await grant(fixture.acme.approverRoleId, { serviceAccount: true });

        expect(shape((await gatepass(await asMachine())).tree)).toEqual([
          ['ops', ['ops.dc', 'ops.board', 'ops.help']],
        ]);
        // …and the person, bound to nothing, still sees only the public leaf.
        expect(shape((await gatepass(await asMember())).tree)).toEqual([
          ['ops', ['ops.help']],
        ]);
      });

      it('reports the node fields the frontend renders, and no gates', async () => {
        await grant(fixture.acme.readerRoleId);

        const [ops] = (await gatepass(await asMember())).tree;
        const [dc] = ops.children;

        // `NavNodeDTO` and not `NavNodeCatalogDTO`: no `requires`, no `is_public`,
        // no `sort_order`. A client holding the gates could enumerate the
        // permissions it does not have from the items it cannot see.
        expect(dc).toEqual({
          id: expect.any(String),
          kind: NavNodeKind.MENU,
          key: 'ops.dc',
          label: 'Delivery Challans',
          route: '/dc',
          icon: 'truck',
          children: [],
        });
        // A container carries no route, and says so rather than omitting it.
        expect(ops.route).toBeNull();
        expect(ops.kind).toBe(NavNodeKind.MODULE);
      });
    });

    // ── the four ways an application is not visible ───────────────────────

    describe('an application the caller may not see', () => {
      /**
       * All four collapse to the same empty answer. Distinguishing them would
       * make an ungated route an oracle over the platform catalog (Doc 06 §2),
       * and Doc 05 §5's first line says "return empty" rather than "refuse".
       */
      const expectEmpty = (response: NavigationResponse): void => {
        expect(response).toEqual({ application: null, tree: [] });
      };

      it('is empty when the tenant’s enablement is switched off', async () => {
        await grant(fixture.acme.approverRoleId);
        await setEnabled(admin, fixture.acme, fixture.catalog.gatepassId, false);

        expectEmpty(await navigation(await asMember(), fixture.catalog.gatepassId));
      });

      it('is empty when the application is deactivated platform-wide', async () => {
        // Doc 02 §7: `is_active = false` is "hidden everywhere". A different
        // switch, a different owner, the same answer.
        await grant(fixture.acme.approverRoleId);
        await setApplicationActive(admin, fixture.catalog.gatepassId, false);

        expectEmpty(await navigation(await asMember(), fixture.catalog.gatepassId));
      });

      it('is empty for an application id that does not exist', async () => {
        expectEmpty(await navigation(await asMember(), randomUUID()));
      });

      it('is empty for an application enabled only for another tenant', async () => {
        // `nav_node` is globally readable (migration 0008) and `client_application`
        // is not (migration 0009). This is the case that proves the second table is
        // what decides, rather than the first.
        expectEmpty(
          await navigation(await asMember(fixture.other), fixture.catalog.gatepassId),
        );
      });
    });

    // ── the cross-application shell (Doc 05 §4) ───────────────────────────

    describe('the cross-application shell', () => {
      it('returns one top-level node per enabled application, carrying its tree', async () => {
        await grant(fixture.acme.approverRoleId);
        await grant(fixture.acme.visitorRoleId);

        const response = await navigation(await asMember());

        // `application: null` is how the shell says it is the shell; the top level
        // *is* the applications, and each is a container over its own pruned tree.
        expect(response.application).toBeNull();
        expect(shape(response.tree)).toEqual([
          [fixture.catalog.gatepassKey, [['ops', ['ops.dc', 'ops.board', 'ops.help']]]],
          [fixture.catalog.visitorKey, [['log', ['log.list']]]],
        ]);
      });

      it('labels the synthetic node with the application’s name', async () => {
        await grant(fixture.acme.visitorRoleId);

        // Picked by key rather than by position: `gatepass` is in this shell too,
        // because its public leaf survives with no gatepass grant at all.
        const visitor = (await navigation(await asMember())).tree.find(
          (node) => node.key === fixture.catalog.visitorKey,
        );

        // An application is not a `nav_node`, so the node standing for it is built
        // from the application row: its own id and key, its name as the label, and
        // no route — a shell entry expands rather than navigates.
        expect(visitor).toMatchObject({
          id: fixture.catalog.visitorId,
          key: fixture.catalog.visitorKey,
          label: fixture.catalog.visitorName,
          kind: NavNodeKind.MODULE,
          route: null,
        });
      });

      it('drops an enabled application in which nothing is visible', async () => {
        // Both applications are enabled for this tenant. `visitor` has no public
        // leaf, so with no visitor grant its whole tree prunes — and the app node
        // is a container, which Doc 05 §3 rule 2 prunes with it. Showing it would
        // put a dead end in the sidebar.
        await grant(fixture.acme.readerRoleId);

        expect(shape((await navigation(await asMember())).tree)).toEqual([
          [fixture.catalog.gatepassKey, [['ops', ['ops.dc', 'ops.help']]]],
        ]);
      });

      it('removes an application from the shell when it is disabled', async () => {
        await grant(fixture.acme.approverRoleId);
        await grant(fixture.acme.visitorRoleId);
        await setEnabled(admin, fixture.acme, fixture.catalog.visitorId, false);

        expect(
          (await navigation(await asMember())).tree.map((node) => node.key),
        ).toEqual([fixture.catalog.gatepassKey]);
      });

      it('shows each tenant only the applications enabled for it', async () => {
        await grant(fixture.acme.visitorRoleId);
        await grant(fixture.other.visitorRoleId, { tenant: fixture.other });

        // The same permission key, the same catalog, two tenants — and `acme` has
        // both applications enabled while `other` has one. `gatepass`'s public leaf
        // is what makes the difference visible without a second grant.
        expect(
          (await navigation(await asMember(fixture.acme))).tree.map((node) => node.key),
        ).toEqual([fixture.catalog.gatepassKey, fixture.catalog.visitorKey]);
        expect(
          (await navigation(await asMember(fixture.other))).tree.map((node) => node.key),
        ).toEqual([fixture.catalog.visitorKey]);
      });

      it('is empty for a subject who can see nothing anywhere', async () => {
        // `other` has only `visitor` enabled, which has no public leaf — so a
        // subject with no bindings gets no menu at all rather than a list of
        // applications they cannot enter.
        expect(await navigation(await asMember(fixture.other))).toEqual({
          application: null,
          tree: [],
        });
      });
    });

    // ── the Definition of Done: a live catalog edit ────────────────────────

    describe('a menu added through the API', () => {
      it('appears on the target subject’s next call — no deploy, no restart', async () => {
        // Doc 05 §1, and Doc 02 §8's "always an API call, never a migration".
        await grant(fixture.acme.readerRoleId);
        const platform = await asPlatform();
        const member = await asMember();

        // Prime first. The catalog cache now holds an entry for this application,
        // so a missing `app_nav_version` bump (Doc 05 §6) would serve the stale
        // tree below and fail this case rather than passing quietly.
        expect(
          keysOf((await navigation(member, fixture.catalog.gatepassId)).tree),
        ).not.toContain('ops.new');

        const created = await call(
          platform,
          'POST',
          `/iam/applications/${fixture.catalog.gatepassId}/nav`,
          {
            nodes: [
              {
                kind: NavNodeKind.MENU,
                key: 'ops.new',
                label: 'Brand New',
                route: '/new',
                parent_key: 'ops',
                sort_order: 15,
              },
            ],
          },
        );
        expect(created.status).toBe(201);

        // A node with no mapping is invisible to everyone (Doc 05 §3 rule 1), so
        // creating it is not yet enough — which is itself worth asserting: the
        // deny-by-default holds across the edit, not only at rest.
        expect(
          keysOf((await navigation(member, fixture.catalog.gatepassId)).tree),
        ).not.toContain('ops.new');

        const mapped = await call(
          platform,
          'POST',
          `/iam/applications/${fixture.catalog.gatepassId}/nav-permissions`,
          {
            mappings: [
              { nav_key: 'ops.new', permission_keys: [fixture.catalog.dcRead] },
            ],
          },
        );
        expect(mapped.status).toBe(200);

        // The same token, the same subject, no restart — and the menu is there, in
        // the position its `sort_order` puts it.
        const after = await navigation(member, fixture.catalog.gatepassId);
        expect(shape(after.tree)).toEqual([
          ['ops', ['ops.dc', 'ops.new', 'ops.help']],
        ]);
      });

      it('disappears again when the mapping is removed', async () => {
        await grant(fixture.acme.readerRoleId);
        const platform = await asPlatform();

        await call(platform, 'POST', `/iam/applications/${fixture.catalog.gatepassId}/nav`, {
          nodes: [
            {
              kind: NavNodeKind.MENU,
              key: 'ops.new',
              label: 'Brand New',
              route: '/new',
              parent_key: 'ops',
              sort_order: 15,
            },
          ],
        });
        await call(
          platform,
          'POST',
          `/iam/applications/${fixture.catalog.gatepassId}/nav-permissions`,
          {
            mappings: [
              { nav_key: 'ops.new', permission_keys: [fixture.catalog.dcRead] },
            ],
          },
        );
        expect(
          keysOf((await navigation(await asMember(), fixture.catalog.gatepassId)).tree),
        ).toContain('ops.new');

        const unmapped = await call(
          platform,
          'DELETE',
          `/iam/applications/${fixture.catalog.gatepassId}/nav-permissions`,
          {
            mappings: [
              { nav_key: 'ops.new', permission_keys: [fixture.catalog.dcRead] },
            ],
          },
        );
        expect(unmapped.status).toBe(200);

        // `nav.service.ts`'s unmap note, observed from the outside: an unmapped
        // leaf becomes invisible to everyone rather than visible to everyone,
        // which is the safe direction for an operator who unmapped one key too
        // many.
        expect(
          keysOf((await navigation(await asMember(), fixture.catalog.gatepassId)).tree),
        ).not.toContain('ops.new');
      });
    });

    // ── the version bump (Doc 05 §6) ──────────────────────────────────────

    /**
     * What the catalog writers announce, and when.
     *
     * Redis is not required for these: the spy records the call and does not run
     * the real bump, so the assertions are about *this application's* wiring — the
     * counter protocol itself is `nav-catalog-cache.service.spec.ts`'s, against an
     * in-memory Redis where the interesting states can be constructed rather than
     * waited for. `invalidation.integration.spec.ts` draws the same line for the
     * grants side and gives the argument in full.
     *
     * The spy is also how post-commit ordering is checked without a second
     * process: it reads the row on the admin connection at the moment it runs, so
     * "had this committed yet?" is answerable directly.
     */
    describe('the nav-catalog version', () => {
      const newNode = {
        kind: NavNodeKind.MENU,
        key: 'ops.new',
        label: 'Brand New',
        route: '/new',
        parent_key: 'ops',
        sort_order: 15,
      };

      let bumps: { applicationId: string; committed: boolean }[];

      beforeEach(() => {
        bumps = [];
        jest
          .spyOn(app.get(NavCatalogCacheService), 'bump')
          .mockImplementation(async (applicationId: string) => {
            bumps.push({
              applicationId,
              // A different connection, so only committed rows are visible.
              committed: await navNodeExists(admin, applicationId, newNode.key),
            });
          });
      });

      afterEach(() => {
        jest.restoreAllMocks();
      });

      const addNode = (token: string) =>
        call(token, 'POST', `/iam/applications/${fixture.catalog.gatepassId}/nav`, {
          nodes: [newNode],
        });

      /** A function, not a constant: `fixture` is only assigned in `beforeAll`. */
      const mapping = () => ({
        mappings: [{ nav_key: newNode.key, permission_keys: [fixture.catalog.dcRead] }],
      });

      it('is bumped for the edited application, after the rows have committed', async () => {
        expect((await addNode(await asPlatform())).status).toBe(201);

        // Doc 04 §7.1 rule 3's hazard applied one table over: bumping before the
        // commit would let a navigation call in flight repopulate the entry from
        // the pre-change rows and re-poison it, so the flush happens and then the
        // stale catalog comes back.
        expect(bumps).toEqual([
          { applicationId: fixture.catalog.gatepassId, committed: true },
        ]);
      });

      it('is bumped when a permission is mapped onto a node', async () => {
        const token = await asPlatform();
        await addNode(token);
        bumps = [];

        expect(
          (
            await call(
              token,
              'POST',
              `/iam/applications/${fixture.catalog.gatepassId}/nav-permissions`,
              mapping(),
            )
          ).status,
        ).toBe(200);

        expect(bumps.map((bump) => bump.applicationId)).toEqual([
          fixture.catalog.gatepassId,
        ]);
      });

      it('is bumped when a mapping is removed', async () => {
        const token = await asPlatform();
        await addNode(token);
        await call(
          token,
          'POST',
          `/iam/applications/${fixture.catalog.gatepassId}/nav-permissions`,
          mapping(),
        );
        bumps = [];

        await call(
          token,
          'DELETE',
          `/iam/applications/${fixture.catalog.gatepassId}/nav-permissions`,
          mapping(),
        );

        expect(bumps.map((bump) => bump.applicationId)).toEqual([
          fixture.catalog.gatepassId,
        ]);
      });

      it('is not bumped by a re-sent mapping that changed nothing', async () => {
        const token = await asPlatform();
        await addNode(token);
        await call(
          token,
          'POST',
          `/iam/applications/${fixture.catalog.gatepassId}/nav-permissions`,
          mapping(),
        );
        bumps = [];

        // The call a deployment script re-runs. It inserts nothing, audits
        // nothing, and must invalidate nothing: a catalog flush per deploy would
        // undo the point of caching it.
        const again = await call(
          token,
          'POST',
          `/iam/applications/${fixture.catalog.gatepassId}/nav-permissions`,
          mapping(),
        );

        expect(await again.json()).toEqual({ changed: 0, unchanged: 1 });
        expect(bumps).toEqual([]);
      });
    });

    // ── authorization (Doc 05 §4, `require-permission.decorator.ts`) ──────

    describe('the route itself', () => {
      it('needs a token', async () => {
        const response = await fetch(`${baseUrl}/iam/navigation`);

        expect(response.status).toBe(401);
      });

      it('needs no permission — a subject with none still gets an answer', async () => {
        // The `@NoPermissionRequired` of Doc 05's contract: gating this would
        // require a permission in order to learn that one holds none. The answer
        // for such a subject is an empty tree, which is information they already
        // had.
        const response = await call(await asMember(fixture.other), 'GET', '/iam/navigation');

        expect(response.status).toBe(200);
        expect((await response.json()) as NavigationResponse).toEqual({
          application: null,
          tree: [],
        });
      });

      it('refuses a malformed applicationId rather than ignoring it', async () => {
        const response = await call(
          await asMember(),
          'GET',
          '/iam/navigation?applicationId=not-a-uuid',
        );

        expect(response.status).toBe(400);
      });
    });
  },
);

// ── fixtures ────────────────────────────────────────────────────────────────

/** Both subjects of a tenant, for clearing their cached grants. */
function subjectsOf(tenant: Tenant): SubjectRef[] {
  return [
    { clientId: tenant.clientId, type: SubjectType.USER, id: tenant.memberUserId },
    {
      clientId: tenant.clientId,
      type: SubjectType.SERVICE,
      id: tenant.serviceAccountId,
    },
  ];
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

async function asPlatformCatalog(admin: DataSource): Promise<void> {
  await admin.query(`select set_config('app.is_platform_admin', 'true', false)`);
  await admin.query(`select set_config('app.current_client_id', '', false)`);
}

/**
 * Two applications, four permissions, and the nav trees the matrix reads.
 *
 * The gatepass tree is built to make each rule of Doc 05 §3 observable on its
 * own:
 *
 * - `ops.dc` maps **two** permissions, so OR semantics have a subject who
 *   satisfies one of them;
 * - `ops.board` maps only the second, so the same subject is refused it;
 * - `ops.help` is `is_public` with no mapping — the rule 1 opt-in, and the one
 *   node a subject with no grants at all can see;
 * - `ops.hidden` is unmapped and *not* public — the deny-by-default half;
 * - `ops.retired` is `is_active = false` although its gate is held — rule 4;
 * - `ops.board` sorts before `ops.dc` by key and after it by `sort_order`, so
 *   rule 4's ordering cannot pass by accident;
 * - `admin` is a container over a single gated leaf, so rule 2 has something to
 *   prune and something to keep.
 *
 * The visitor tree is deliberately plain and deliberately has **no** public node:
 * it is the application that disappears from the shell when the subject holds
 * nothing in it.
 */
async function seedCatalog(admin: DataSource): Promise<Catalog> {
  const suffix = randomUUID().slice(0, 8);
  await asPlatformCatalog(admin);

  const catalog: Catalog = {
    gatepassId: randomUUID(),
    gatepassKey: `${PREFIX}gatepass-${suffix}`,
    gatepassName: 'Session 24 Gatepass',
    visitorId: randomUUID(),
    visitorKey: `${PREFIX}visitor-${suffix}`,
    visitorName: 'Session 24 Visitor',
    dcReadId: randomUUID(),
    dcApproveId: randomUUID(),
    manageId: randomUUID(),
    visitorReadId: randomUUID(),
    dcRead: `s24gp${suffix}.dc.read`,
    dcApprove: `s24gp${suffix}.dc.approve`,
    manage: `s24gp${suffix}.admin.manage`,
    visitorRead: `s24vs${suffix}.log.read`,
  };

  for (const [id, key, name] of [
    [catalog.gatepassId, catalog.gatepassKey, catalog.gatepassName],
    [catalog.visitorId, catalog.visitorKey, catalog.visitorName],
  ] as const) {
    await admin.query(
      `insert into ${S}."application" (id, key, name) values ($1, $2, $3)`,
      [id, key, name],
    );
  }

  for (const [id, applicationId, key, name] of [
    [catalog.dcReadId, catalog.gatepassId, catalog.dcRead, 'Read challans'],
    [catalog.dcApproveId, catalog.gatepassId, catalog.dcApprove, 'Approve challans'],
    [catalog.manageId, catalog.gatepassId, catalog.manage, 'Manage settings'],
    [catalog.visitorReadId, catalog.visitorId, catalog.visitorRead, 'Read the log'],
  ] as const) {
    await admin.query(
      `insert into ${S}."permission" (id, application_id, key, name)
       values ($1, $2, $3, $4)`,
      [id, applicationId, key, name],
    );
  }

  await seedNav(admin, catalog);
  return catalog;
}

/** The nav nodes and their `menu_permission` rows. Re-runnable — see `resetNavCatalog`. */
async function seedNav(admin: DataSource, catalog: Catalog): Promise<void> {
  await asPlatformCatalog(admin);

  const nodes: {
    key: string;
    parent: string | null;
    kind: string;
    label: string;
    route: string | null;
    icon: string | null;
    sortOrder: number;
    isPublic?: boolean;
    isActive?: boolean;
    requires?: string[];
    applicationId: string;
  }[] = [
    {
      applicationId: catalog.gatepassId,
      key: 'ops',
      parent: null,
      kind: 'module',
      label: 'Operations',
      route: null,
      icon: 'gear',
      sortOrder: 10,
    },
    {
      applicationId: catalog.gatepassId,
      key: 'ops.dc',
      parent: 'ops',
      kind: 'menu',
      label: 'Delivery Challans',
      route: '/dc',
      icon: 'truck',
      sortOrder: 10,
      requires: [catalog.dcReadId, catalog.dcApproveId],
    },
    {
      applicationId: catalog.gatepassId,
      key: 'ops.board',
      parent: 'ops',
      kind: 'menu',
      label: 'Approval Board',
      route: '/board',
      icon: null,
      sortOrder: 20,
      requires: [catalog.dcApproveId],
    },
    {
      applicationId: catalog.gatepassId,
      key: 'ops.help',
      parent: 'ops',
      kind: 'menu',
      label: 'Help',
      route: '/help',
      icon: null,
      sortOrder: 30,
      isPublic: true,
    },
    {
      applicationId: catalog.gatepassId,
      key: 'ops.hidden',
      parent: 'ops',
      kind: 'menu',
      label: 'Ungated',
      route: '/hidden',
      icon: null,
      sortOrder: 40,
    },
    {
      applicationId: catalog.gatepassId,
      key: 'ops.retired',
      parent: 'ops',
      kind: 'menu',
      label: 'Retired',
      route: '/retired',
      icon: null,
      sortOrder: 50,
      isActive: false,
      requires: [catalog.dcReadId],
    },
    {
      applicationId: catalog.gatepassId,
      key: 'admin',
      parent: null,
      kind: 'module',
      label: 'Administration',
      route: null,
      icon: null,
      sortOrder: 20,
    },
    {
      applicationId: catalog.gatepassId,
      key: 'admin.settings',
      parent: 'admin',
      kind: 'menu',
      label: 'Settings',
      route: '/settings',
      icon: null,
      sortOrder: 10,
      requires: [catalog.manageId],
    },
    {
      applicationId: catalog.visitorId,
      key: 'log',
      parent: null,
      kind: 'module',
      label: 'Visitor Log',
      route: null,
      icon: null,
      sortOrder: 10,
    },
    {
      applicationId: catalog.visitorId,
      key: 'log.list',
      parent: 'log',
      kind: 'menu',
      label: 'All Visits',
      route: '/list',
      icon: null,
      sortOrder: 10,
      requires: [catalog.visitorReadId],
    },
  ];

  const idByKey = new Map<string, string>();

  for (const node of nodes) {
    const id = randomUUID();
    idByKey.set(`${node.applicationId}:${node.key}`, id);

    await admin.query(
      `insert into ${S}."nav_node"
         (id, application_id, parent_id, kind, key, label, route, icon,
          sort_order, is_public, is_active)
       values ($1, $2, $3, $4::${S}."nav_node_kind", $5, $6, $7, $8, $9, $10, $11)`,
      [
        id,
        node.applicationId,
        node.parent === null
          ? null
          : (idByKey.get(`${node.applicationId}:${node.parent}`) as string),
        node.kind,
        node.key,
        node.label,
        node.route,
        node.icon,
        node.sortOrder,
        node.isPublic ?? false,
        node.isActive ?? true,
      ],
    );

    for (const permissionId of node.requires ?? []) {
      await admin.query(
        `insert into ${S}."menu_permission" (nav_node_id, permission_id) values ($1, $2)`,
        [id, permissionId],
      );
    }
  }
}

/**
 * One tenant: a two-level tree, four roles mapped to the shared catalog, a person
 * and a machine identity.
 *
 * Seeded directly rather than through the APIs that create them, so this suite
 * does not depend on Sessions 13–20 — the choice every other live suite makes.
 *
 * @param enabled which applications this tenant may run, which is the whole
 * reason `other` exists.
 */
async function seedTenant(
  admin: DataSource,
  label: string,
  secretHash: string,
  catalog: Catalog,
  enabled: readonly string[],
): Promise<Tenant> {
  const suffix = randomUUID().slice(0, 8);
  const rootId = randomUUID();
  const gateId = randomUUID();

  const tenant: Tenant = {
    clientId: randomUUID(),
    slug: `${PREFIX}${label}-${suffix}`,
    memberEmail: `member-${label}-${suffix}@example.test`,
    memberUserId: randomUUID(),
    serviceAccountId: randomUUID(),
    serviceAccountKey: `${PREFIX}${label}-${suffix}`,
    rootId,
    gateId,
    readerRoleId: randomUUID(),
    approverRoleId: randomUUID(),
    managerRoleId: randomUUID(),
    visitorRoleId: randomUUID(),
  };

  await elevate(admin, tenant.clientId);

  await admin.query(
    `insert into ${S}."client" (id, name, slug, status) values ($1, $2, $3, 'active')`,
    [tenant.clientId, `Session 24 ${label} ${suffix}`, tenant.slug],
  );

  await admin.query(
    `insert into ${S}."user" (id, client_id, email, full_name, status, is_client_admin)
     values ($1, $2, $3, 'Session 24 Member', 'active', false)`,
    [tenant.memberUserId, tenant.clientId, tenant.memberEmail],
  );
  await admin.query(
    `insert into ${S}."user_identity" (client_id, user_id, provider, secret_hash)
     values ($1, $2, 'password', $3)`,
    [tenant.clientId, tenant.memberUserId, secretHash],
  );

  await admin.query(
    `insert into ${S}."service_account" (id, client_id, name, key, key_hash, status)
     values ($1, $2, 'Session 24 Integration', $3, $4, 'active')`,
    [tenant.serviceAccountId, tenant.clientId, tenant.serviceAccountKey, secretHash],
  );

  const rootPath = scopePathLabel(rootId);
  for (const [id, parentId, kind, name, path] of [
    [rootId, null, 'group', `Session 24 ${label}`, rootPath],
    [gateId, rootId, 'gate', 'Gate 1', `${rootPath}.${scopePathLabel(gateId)}`],
  ] as const) {
    await admin.query(
      `insert into ${S}."scope_node" (id, client_id, parent_id, kind, name, path)
       values ($1, $2, $3, $4, $5, $6::ltree)`,
      [id, tenant.clientId, parentId, kind, name, path],
    );
  }

  for (const [id, name, permissionId] of [
    [tenant.readerRoleId, 'Session 24 Reader', catalog.dcReadId],
    [tenant.approverRoleId, 'Session 24 Approver', catalog.dcApproveId],
    [tenant.managerRoleId, 'Session 24 Manager', catalog.manageId],
    [tenant.visitorRoleId, 'Session 24 Visitor', catalog.visitorReadId],
  ] as const) {
    await admin.query(
      `insert into ${S}."role" (id, client_id, name, description)
       values ($1, $2, $3, 'Session 24 fixture')`,
      [id, tenant.clientId, name],
    );
    await admin.query(
      `insert into ${S}."role_permission" (role_id, permission_id) values ($1, $2)`,
      [id, permissionId],
    );
  }

  for (const applicationId of enabled) {
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
  options: { roleId: string; nodeId?: string; serviceAccount: boolean },
): Promise<void> {
  await elevate(admin, tenant.clientId);
  await admin.query(
    `insert into ${S}."role_binding"
       (client_id, user_id, service_account_id, role_id, scope_node_id)
     values ($1, $2, $3, $4, $5)`,
    [
      tenant.clientId,
      options.serviceAccount ? null : tenant.memberUserId,
      options.serviceAccount ? tenant.serviceAccountId : null,
      options.roleId,
      options.nodeId ?? tenant.rootId,
    ],
  );
}

async function deleteBindings(admin: DataSource, tenant: Tenant): Promise<void> {
  await elevate(admin, tenant.clientId);
  await admin.query(`delete from ${S}."role_binding" where client_id = $1`, [
    tenant.clientId,
  ]);
}

async function setEnabled(
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
  await asPlatformCatalog(admin);
  await admin.query(`update ${S}."application" set is_active = $2 where id = $1`, [
    applicationId,
    isActive,
  ]);
}

/**
 * Is this nav node committed and visible to another connection?
 *
 * `nav_node` is a catalog table with `for select using (true)` (migration 0008),
 * so no RLS context is needed — which matters, because this runs from inside a
 * spy while a request's own transaction is still open.
 */
async function navNodeExists(
  admin: DataSource,
  applicationId: string,
  key: string,
): Promise<boolean> {
  const rows = (await admin.query(
    `select 1 as present from ${S}."nav_node"
      where application_id = $1 and key = $2`,
    [applicationId, key],
  )) as unknown[];

  return rows.length > 0;
}

/**
 * Toggles a catalog node's `is_active`, and evicts the cached catalog.
 *
 * The eviction is not optional. Production reaches `nav_node.is_active` only
 * through the manifest upload, which bumps the catalog from a post-commit
 * callback; a fixture writing the column with `admin.query` announces nothing,
 * so `GET /iam/navigation` keeps serving the tree from before the toggle. That
 * is invisible with Redis down, where every read goes to Postgres.
 */
async function setNavNodeActive(
  admin: DataSource,
  cache: NavCatalogCacheService,
  applicationId: string,
  key: string,
  isActive: boolean,
): Promise<void> {
  await asPlatformCatalog(admin);
  await admin.query(
    `update ${S}."nav_node" set is_active = $3 where application_id = $1 and key = $2`,
    [applicationId, key, isActive],
  );
  await cache.bump(applicationId);
}

/** Back to a tenant with no grants and no sessions, and both toggles on. */
async function reset(
  admin: DataSource,
  tenant: Tenant,
  catalog: Catalog,
): Promise<void> {
  await elevate(admin, tenant.clientId);
  await admin.query(`delete from ${S}."role_binding" where client_id = $1`, [
    tenant.clientId,
  ]);
  await admin.query(`delete from ${S}."session" where client_id = $1`, [
    tenant.clientId,
  ]);
  await admin.query(
    `update ${S}."client_application" set enabled = true
      where client_id = $1 and application_id = any($2::uuid[])`,
    [tenant.clientId, [catalog.gatepassId, catalog.visitorId]],
  );
  await admin.query(`delete from ${S}."audit_trail" where client_id = $1`, [
    tenant.clientId,
  ]);
}

/** Undoes whatever a case switched off platform-wide. */
async function reactivateCatalog(admin: DataSource, catalog: Catalog): Promise<void> {
  await asPlatformCatalog(admin);
  await admin.query(
    `update ${S}."application" set is_active = true where id = any($1::uuid[])`,
    [[catalog.gatepassId, catalog.visitorId]],
  );
}

/**
 * Rebuilds the nav trees from scratch before every case.
 *
 * Two cases mutate them — one deactivates a module, and the Definition of Done
 * adds a node and a mapping through the API — so the tree is dropped and re-seeded
 * rather than repaired. Deleting the nodes takes their `menu_permission` rows with
 * them (migration 0004 cascades), and re-seeding mints fresh node ids, which is
 * also why no assertion here names one.
 */
async function resetNavCatalog(
  admin: DataSource,
  cache: NavCatalogCacheService,
  catalog: Catalog,
): Promise<void> {
  await asPlatformCatalog(admin);
  await admin.query(
    `delete from ${S}."nav_node" where application_id = any($1::uuid[])`,
    [[catalog.gatepassId, catalog.visitorId]],
  );
  await seedNav(admin, catalog);
  // Re-seeding mints fresh node ids, so a cached tree from the previous case is
  // not merely stale — it names nodes that no longer exist.
  for (const applicationId of [catalog.gatepassId, catalog.visitorId]) {
    await cache.bump(applicationId);
  }
}

/** Every `s24-` client and application, and everything hanging off them. */
async function purge(admin: DataSource): Promise<void> {
  await asPlatformCatalog(admin);

  const clients = (await admin.query(`select id from ${S}."client" where slug like $1`, [
    `${PREFIX}%`,
  ])) as { id: string }[];

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

  await asPlatformCatalog(admin);

  // The audit rows the Definition of Done's catalog edits wrote. They belong to
  // the *platform* tenant rather than to any `s24-` client, so they survive the
  // loop above — and they are identified by the application they name rather than
  // by action, so this cannot reach another suite's rows. `audit_trail` has no
  // foreign key to what it describes, deliberately: a record must outlive its
  // target (Doc 01 §4.8).
  const applications = (await admin.query(
    `select id from ${S}."application" where key like $1`,
    [`${PREFIX}%`],
  )) as { id: string }[];

  if (applications.length > 0) {
    await admin.query(
      `delete from ${S}."audit_trail"
        where payload->>'application_id' = any($1::text[])`,
      [applications.map((row) => row.id)],
    );
  }

  // `permission`, `nav_node` and `menu_permission` all cascade from
  // `application` (migrations 0002 and 0004); the role mappings that referenced
  // those permissions went with the roles above.
  await admin.query(`delete from ${S}."application" where key like $1`, [`${PREFIX}%`]);
}

/**
 * Deletes a client's scope nodes leaf-first.
 *
 * The parent key is `on delete restrict`, which Postgres checks per row and
 * immediately, so a statement removing a parent and its child in one pass is
 * refused even though the child is going too. Deleting whatever currently has no
 * children, and repeating, terminates at the depth of the tree.
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
