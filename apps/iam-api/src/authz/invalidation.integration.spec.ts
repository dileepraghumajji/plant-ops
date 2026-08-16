/**
 * The Session 22 Definition of Done: **every row of Doc 04 §7's invalidation
 * table, driven over HTTP, against a real Postgres.**
 *
 * Session 21 proved that `resolve()` computes the right answer. This proves the
 * other half, which is the one an operator actually experiences: that when
 * somebody *changes* a grant, the change takes effect now rather than whenever a
 * cache entry happens to expire. Doc 04 §7's opening sentence is the whole
 * requirement — "must invalidate the relevant cache entries **immediately**" —
 * and its table has eight rows, each a different way for a subject's effective
 * access to move.
 *
 * ## What is asserted, and why it is asserted this way
 *
 * Two things per row, because neither alone is the property:
 *
 * 1. **The announcement.** `GrantInvalidationService.publish` is spied on, and
 *    the spy records the subjects it was handed. That is what proves the *right
 *    people* were invalidated — a role edit that announced only the editor, or a
 *    cascade that announced nobody because it looked after the rows were gone,
 *    would still leave `resolve()` correct on the next call and would still be a
 *    bug that bites every cache holder in the fleet.
 * 2. **The answer.** `GET /iam/permissions/resolve` is called afterwards and
 *    compared against the change. That is what proves the invalidation was not
 *    merely announced but is *consistent with the database* — the two halves
 *    Doc 04 §7 exists to keep in agreement.
 *
 * The spy is also how the **post-commit ordering** of §7.1 rule 3 is checked
 * without a second process: it reads the row on the admin connection at the
 * moment it runs, so "had this committed yet?" is answerable directly.
 * `scopes.integration.spec.ts` does the same for the move, which is the case the
 * spec singles out; this suite establishes that every *other* cause has the same
 * discipline, since the hazard is not peculiar to scope moves — only its worst
 * instance is.
 *
 * ## Why the assertions are not about Redis
 *
 * They deliberately stop at `publish`. What happens inside it — the version bump,
 * the pipeline, the channel prefix, the swallowed outage — is
 * `invalidation.service.spec.ts`'s and `grants-cache.service.spec.ts`'s, against
 * an in-memory Redis where the interesting states (a counter that expired, an
 * entry written before an invalidation, a server that stopped answering
 * mid-batch) can be *constructed* rather than waited for. Asserting them here
 * would need a live Redis to make the suite meaningful and would make it pass
 * vacuously without one, which is the worst of both: a green run that proves
 * nothing on the machine most likely to be missing the dependency.
 *
 * What this suite needs is Postgres, and it says so:
 *
 *   pg_ctl start                # a local Postgres 17 (see .env)
 *   npm run migration:run
 *   npx nx test @plantops/iam-api
 *
 * **Destructive within its own fixtures only.** Every client is slugged `s22-…`
 * and every application key is `s22-…`; both are removed afterwards with
 * everything hanging off them.
 *
 * ## Deliberate deviations from the shipped configuration
 *
 * - **Rate limiting is off.** These cases make dozens of calls.
 * - **The expiry sweep's timer is off** (`EXPIRY_SWEEP_INTERVAL_SECONDS: 0`),
 *   and the sweep is driven by calling `runOnce()`. A background timer firing
 *   mid-suite would claim the fixtures of whichever case was running and make
 *   the whole file order-dependent. The off switch exists for this
 *   (`env.schema.ts`), and the scheduling itself is unit-tested with fake timers.
 * - **Nothing else.** The validation pipe, the RLS context, the auth guard, the
 *   interim permission rules and the error envelope are the shipped ones.
 */

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { loadEnv } from '@plantops/config';
import {
  SubjectType,
  type AccessTokenResponse,
  type Paginated,
  type ResolvedGrants,
  type RoleBindingDTO,
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
import { AUDIT_ACTIONS } from '../audit/audit-actions';
import { ENV } from '../config/config.module';
import { createTestApplication } from '../testing/app-harness';
import { ExpirySweepJob } from './expiry-sweep.job';
import {
  GrantInvalidationService,
  type AffectedSubject,
  type InvalidationReason,
} from './invalidation.service';

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
const PREFIX = 's22-';

const TOMORROW = () => new Date(Date.now() + 86_400_000);
const A_MOMENT_AGO = () => new Date(Date.now() - 1_000);

interface Node {
  id: string;
  path: string;
}

interface Catalog {
  applicationId: string;
  applicationKey: string;
  approveId: string;
  createId: string;
  approve: string;
  create: string;
}

interface Tenant {
  clientId: string;
  slug: string;
  adminEmail: string;
  adminUserId: string;
  memberEmail: string;
  memberUserId: string;
  serviceAccountId: string;
  root: Node;
  plant: Node;
  gate: Node;
  /** A second child of the root, so the move case has somewhere to move to. */
  spare: Node;
  /** Maps both permissions — the role every case edits or deletes. */
  roleId: string;
}

interface Fixture {
  catalog: Catalog;
  acme: Tenant;
  platformClientId: string;
}

/** What the spy saw: who was announced, why, and whether it had committed. */
interface Announcement {
  subjects: AffectedSubject[];
  reason: InvalidationReason;
}

describeWithDb(
  `grant invalidation (${configured ? 'live' : 'skipped: no DATABASE_URL'})`,
  () => {
    let app: INestApplication;
    let baseUrl: string;
    let admin: DataSource;
    let fixture: Fixture;
    let invalidation: GrantInvalidationService;
    let sweep: ExpirySweepJob;
    let bootstrapSecret: string;
    let announced: Announcement[];

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
        acme: await seedTenant(admin, secretHash, catalog),
        platformClientId: await platformClientId(admin),
      };

      const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(ENV)
        .useValue({ ...env, RATE_LIMIT_ENABLED: false, EXPIRY_SWEEP_INTERVAL_SECONDS: 0 })
        .compile();

      app = createTestApplication(moduleRef);
      await app.init();
      await app.listen(0);
      baseUrl = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
      invalidation = app.get(GrantInvalidationService);
      sweep = app.get(ExpirySweepJob);
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
      await resetTenant(admin, fixture.acme, fixture.catalog);
      await reactivateCatalog(admin, fixture.catalog);

      announced = [];
      // Spying rather than mocking the body away: the real publish still runs,
      // so a Redis that happens to be up is exercised, and a Redis that is down
      // is swallowed exactly as it would be in production. The recording is the
      // assertion; the publish's own behaviour is unit-tested elsewhere.
      jest
        .spyOn(invalidation, 'publish')
        .mockImplementation(async (clientId, subjects, reason) => {
          announced.push({ subjects: [...subjects], reason });
          void clientId;
        });
      jest
        .spyOn(invalidation, 'publishAcrossTenants')
        .mockImplementation(async (subjects, reason) => {
          announced.push({
            subjects: subjects.map(({ type, id }) => ({ type, id })),
            reason,
          });
        });
    });

    afterEach(() => {
      jest.restoreAllMocks();
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

    const asAdmin = async (): Promise<string> => {
      const response = await fetch(`${baseUrl}/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          email: fixture.acme.adminEmail,
          password: PASSWORD,
          client_slug: fixture.acme.slug,
        }),
      });
      expect(response.status).toBe(200);
      return ((await response.json()) as TokenPairResponse).access_token;
    };

    const asMember = async (): Promise<string> => {
      const response = await fetch(`${baseUrl}/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          email: fixture.acme.memberEmail,
          password: PASSWORD,
          client_slug: fixture.acme.slug,
        }),
      });
      expect(response.status).toBe(200);
      return ((await response.json()) as TokenPairResponse).access_token;
    };

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

    /** What the member's own token says they can do, right now. */
    const memberGrants = async (): Promise<ResolvedGrants> => {
      const token = await asMember();
      const response = await call(token, 'GET', '/iam/permissions/resolve');
      expect(response.status).toBe(200);
      return (await response.json()) as ResolvedGrants;
    };

    /** Binds the member to the fixture role at the plant, over HTTP. */
    const bindMember = async (
      token: string,
      expiresAt?: Date,
    ): Promise<RoleBindingDTO> => {
      const response = await call(token, 'POST', '/iam/role-bindings', {
        user_id: fixture.acme.memberUserId,
        role_id: fixture.acme.roleId,
        scope_node_id: fixture.acme.plant.id,
        ...(expiresAt === undefined ? {} : { expires_at: expiresAt.toISOString() }),
      });
      expect(response.status).toBe(201);
      return (await response.json()) as RoleBindingDTO;
    };

    // ── Doc 04 §7, row by row ─────────────────────────────────────────────

    describe('role_binding created / deleted → that subject', () => {
      it('announces the bound subject and grants the permission immediately', async () => {
        const token = await asAdmin();

        await expect(memberGrants()).resolves.toEqual({ permissions: [], scopes: {} });

        const binding = await bindMember(token);

        expect(announced).toEqual([
          {
            subjects: [{ type: SubjectType.USER, id: fixture.acme.memberUserId }],
            reason: { cause: 'role_binding.created', bindingId: binding.id },
          },
        ]);

        // The point of the whole session: no waiting for a TTL.
        const grants = await memberGrants();
        expect(grants.permissions.sort()).toEqual(
          [fixture.catalog.approve, fixture.catalog.create].sort(),
        );
        expect(grants.scopes[fixture.catalog.approve]).toEqual([fixture.acme.plant.path]);
      });

      it('announces the subject again on unbind and revokes the permission', async () => {
        const token = await asAdmin();
        const binding = await bindMember(token);
        announced = [];

        const response = await call(token, 'DELETE', `/iam/role-bindings/${binding.id}`);
        expect(response.status).toBe(204);

        expect(announced).toEqual([
          {
            subjects: [{ type: SubjectType.USER, id: fixture.acme.memberUserId }],
            reason: { cause: 'role_binding.deleted', bindingId: binding.id },
          },
        ]);
        await expect(memberGrants()).resolves.toEqual({ permissions: [], scopes: {} });
      });
    });

    describe('role_permission changed → all subjects bound to that role', () => {
      it('announces every holder of the role, not just the editor', async () => {
        const token = await asAdmin();
        await bindMember(token);
        announced = [];

        // Narrow the role to one permission. The editor is the admin; the person
        // whose access moved is the member, and announcing only the former is
        // the bug this assertion exists for.
        const response = await call(
          token,
          'PUT',
          `/iam/roles/${fixture.acme.roleId}/permissions`,
          { permission_ids: [fixture.catalog.approveId] },
        );
        expect(response.status).toBe(200);

        expect(announced).toHaveLength(1);
        expect(announced[0].reason).toEqual({
          cause: 'role_permission.changed',
          roleId: fixture.acme.roleId,
        });
        expect(announced[0].subjects).toEqual([
          { type: SubjectType.USER, id: fixture.acme.memberUserId },
        ]);

        const grants = await memberGrants();
        expect(grants.permissions).toEqual([fixture.catalog.approve]);
      });

      it('announces nothing when the submitted set is the one already held', async () => {
        const token = await asAdmin();
        await bindMember(token);
        announced = [];

        // Idempotent re-submission — the Doc 09 §3.2 picker's save button on an
        // unchanged form. Flushing every holder's cache here would make that
        // button a denial of service on the tenant's own hot path.
        const response = await call(
          token,
          'PUT',
          `/iam/roles/${fixture.acme.roleId}/permissions`,
          { permission_ids: [fixture.catalog.approveId, fixture.catalog.createId] },
        );
        expect(response.status).toBe(200);

        expect(announced).toEqual([]);
      });
    });

    describe('role deleted → all subjects bound to that role', () => {
      it('announces the subjects captured before the cascade removed them', async () => {
        const token = await asAdmin();
        await bindMember(token);
        announced = [];

        const response = await call(token, 'DELETE', `/iam/roles/${fixture.acme.roleId}`);
        expect(response.status).toBe(204);

        // `role_binding` cascades on the role's foreign key (migration 0004), so
        // a lookup after the DELETE finds nothing. This is the assertion that
        // the capture happens first — without it the member would keep the
        // deleted role's permissions until their entry expired.
        expect(announced).toEqual([
          {
            subjects: [{ type: SubjectType.USER, id: fixture.acme.memberUserId }],
            reason: { cause: 'role.deleted', roleId: fixture.acme.roleId },
          },
        ]);
        await expect(memberGrants()).resolves.toEqual({ permissions: [], scopes: {} });
      });
    });

    describe('scope_node moved → subjects with bindings in that subtree', () => {
      it('announces after the rewrite has committed, and resolve follows the new path', async () => {
        const token = await asAdmin();
        // Bound at the *gate*, so the subject is a descendant of the node that
        // moves — the case §7.1's affected-subject lookup is written for, and
        // the one a naive "bindings on the moved node" query would miss.
        const response = await call(token, 'POST', '/iam/role-bindings', {
          user_id: fixture.acme.memberUserId,
          role_id: fixture.acme.roleId,
          scope_node_id: fixture.acme.gate.id,
        });
        expect(response.status).toBe(201);
        announced = [];

        // What a *different* connection could see when the hook ran (Doc 04
        // §7.1 rule 3). Before the commit it would still read the pre-move path,
        // and a reader repopulating its cache then would re-poison it with a
        // path that no longer exists.
        const visibleAtPublish: (string | null)[] = [];
        (invalidation.publish as jest.Mock).mockImplementation(
          async (_clientId: string, subjects: AffectedSubject[], reason: InvalidationReason) => {
            visibleAtPublish.push(await pathOf(admin, fixture.acme, fixture.acme.gate.id));
            announced.push({ subjects: [...subjects], reason });
          },
        );

        const moved = await call(token, 'PATCH', `/iam/scopes/${fixture.acme.plant.id}`, {
          parent_id: fixture.acme.spare.id,
        });
        expect(moved.status).toBe(200);

        expect(announced).toHaveLength(1);
        expect(announced[0].reason).toEqual({
          cause: 'scope_node.moved',
          scopeNodeId: fixture.acme.plant.id,
        });
        // Captured from the pre-move subtree — the gate's binding, not the
        // plant's, which has none.
        expect(announced[0].subjects).toEqual([
          { type: SubjectType.USER, id: fixture.acme.memberUserId },
        ]);

        // The ordering assertion: by the time the hook ran, another connection
        // already saw the rewritten path.
        expect(visibleAtPublish).toHaveLength(1);
        expect(visibleAtPublish[0]).toContain(scopePathLabel(fixture.acme.spare.id));
        expect(visibleAtPublish[0]).not.toBe(fixture.acme.gate.path);

        // And resolution now covers the gate at its new address, with no trace
        // of the old one.
        const grants = await memberGrants();
        expect(grants.scopes[fixture.catalog.approve]).toEqual([visibleAtPublish[0]]);
      });

      it('announces nothing for a rename, which changes no path', async () => {
        const token = await asAdmin();
        await bindMember(token);
        announced = [];

        // Doc 04 §7's row is "moved/renamed (**path change**)", and the
        // parenthetical is the whole condition: labels are `n_` + the node's
        // uuid (Doc 01 §3.5), so a display name never appears in a path and
        // renaming one cannot move anybody's coverage.
        const response = await call(
          token,
          'PATCH',
          `/iam/scopes/${fixture.acme.plant.id}`,
          { name: 'Plant A (renamed)' },
        );
        expect(response.status).toBe(200);

        expect(announced).toEqual([]);
      });
    });

    describe('user locked / disabled → that subject', () => {
      it.each([
        ['locked', 'locked'],
        ['disabled', 'disabled'],
      ])('announces the %s user and empties their grants', async (_label, status) => {
        const token = await asAdmin();
        await bindMember(token);
        await expect(memberGrants()).resolves.not.toEqual({ permissions: [], scopes: {} });
        announced = [];

        const response = await call(
          token,
          'PATCH',
          `/iam/users/${fixture.acme.memberUserId}`,
          { status },
        );
        expect(response.status).toBe(200);

        expect(announced).toHaveLength(1);
        expect(announced[0].subjects).toEqual([
          { type: SubjectType.USER, id: fixture.acme.memberUserId },
        ]);
        expect(announced[0].reason).toEqual({
          cause: status === 'locked' ? 'user.locked' : 'user.disabled',
          userId: fixture.acme.memberUserId,
        });
      });
    });

    describe('service_account revoked → that subject', () => {
      it('announces the machine identity on revoke and not on reactivate', async () => {
        const token = await asAdmin();

        const revoked = await call(
          token,
          'PATCH',
          `/iam/service-accounts/${fixture.acme.serviceAccountId}`,
          { status: 'revoked' },
        );
        expect(revoked.status).toBe(200);

        expect(announced).toEqual([
          {
            subjects: [
              { type: SubjectType.SERVICE, id: fixture.acme.serviceAccountId },
            ],
            reason: {
              cause: 'service_account.revoked',
              serviceAccountId: fixture.acme.serviceAccountId,
            },
          },
        ]);

        announced = [];
        const restored = await call(
          token,
          'PATCH',
          `/iam/service-accounts/${fixture.acme.serviceAccountId}`,
          { status: 'active' },
        );
        expect(restored.status).toBe(200);

        // Reactivating cannot grant anything from cache: the bindings never went
        // away, so the cached grants are the ones it had and they are correct.
        // See `setStatus`'s header for the argument.
        expect(announced).toEqual([]);
      });
    });

    describe('client_application disabled or re-enabled → subjects of that client', () => {
      it('announces on both directions and moves the permissions with the toggle', async () => {
        const adminToken = await asAdmin();
        await bindMember(adminToken);
        announced = [];

        const platform = await asPlatform();
        const path = `/iam/clients/${fixture.acme.clientId}/applications/${fixture.catalog.applicationId}`;

        const disabled = await call(platform, 'PATCH', path, { enabled: false });
        expect(disabled.status).toBe(200);

        expect(announced).toHaveLength(1);
        expect(announced[0].reason).toEqual({
          cause: 'client_application.toggled',
          applicationId: fixture.catalog.applicationId,
        });
        expect(announced[0].subjects).toEqual([
          { type: SubjectType.USER, id: fixture.acme.memberUserId },
        ]);

        // Doc 04 §4: a disabled app's permissions are simply absent, with no
        // `role_permission` row touched.
        await expect(memberGrants()).resolves.toEqual({ permissions: [], scopes: {} });

        announced = [];
        const reEnabled = await call(platform, 'PATCH', path, { enabled: true });
        expect(reEnabled.status).toBe(200);

        // The direction Doc 04 §7 spells out explicitly because it is the less
        // obvious one: every preserved mapping goes live again in the same
        // instant, and a cache written while the app was off is missing them.
        expect(announced).toHaveLength(1);
        expect(announced[0].reason).toEqual({
          cause: 'client_application.toggled',
          applicationId: fixture.catalog.applicationId,
        });

        const grants = await memberGrants();
        expect(grants.permissions.sort()).toEqual(
          [fixture.catalog.approve, fixture.catalog.create].sort(),
        );
      });

      it('announces nothing when the toggle is set to the state it already had', async () => {
        const adminToken = await asAdmin();
        await bindMember(adminToken);
        announced = [];

        const platform = await asPlatform();
        const response = await call(
          platform,
          'PATCH',
          `/iam/clients/${fixture.acme.clientId}/applications/${fixture.catalog.applicationId}`,
          { enabled: true },
        );
        expect(response.status).toBe(200);

        expect(announced).toEqual([]);
      });
    });

    describe('permission soft-deactivated via manifest → subjects bound to a role mapping it', () => {
      it('announces the holders across tenants and retires the key immediately', async () => {
        const adminToken = await asAdmin();
        await bindMember(adminToken);
        announced = [];

        // A manifest that keeps `dc.approve` and drops `dc.create`. Doc 02 §7
        // soft-deactivates the absent key and leaves every `role_permission` row
        // in place — so no other row of §7's table fires, and without this one
        // the retired key would keep working for up to a TTL.
        const platform = await asPlatform();
        const response = await call(
          platform,
          'POST',
          `/iam/applications/${fixture.catalog.applicationId}/manifest`,
          {
            key: fixture.catalog.applicationKey,
            name: 'Session 22 Gatepass',
            permissions: [
              { key: fixture.catalog.approve, name: 'Approve a delivery challan' },
            ],
            nav: [],
          },
        );
        expect(response.status).toBe(200);

        expect(announced).toHaveLength(1);
        expect(announced[0].reason).toMatchObject({
          cause: 'permission.deactivated',
          applicationId: fixture.catalog.applicationId,
        });
        expect(announced[0].subjects).toEqual([
          { type: SubjectType.USER, id: fixture.acme.memberUserId },
        ]);

        const grants = await memberGrants();
        expect(grants.permissions).toEqual([fixture.catalog.approve]);
      });
    });

    // ── the row with no writer: the expiry sweep ──────────────────────────

    describe('role_binding expires_at reached → the periodic sweep', () => {
      it('claims a lapsed binding, audits it, and announces its subject', async () => {
        const token = await asAdmin();
        const binding = await bindMember(token, TOMORROW());
        announced = [];

        // Backdated on the admin connection rather than by waiting: the API
        // refuses an `expires_at` in the past, and the state under test is a
        // grant that *has* lapsed.
        await expire(admin, fixture.acme, binding.id, A_MOMENT_AGO());

        await expect(sweep.runOnce()).resolves.toEqual({ bindings: 1, subjects: 1 });

        expect(announced).toEqual([
          {
            subjects: [{ type: SubjectType.USER, id: fixture.acme.memberUserId }],
            reason: { cause: 'role_binding.expired', bindingId: binding.id },
          },
        ]);

        // Doc 10 §4's action, written by the definer function in the binding's
        // own tenant — the sweep runs with no request context at all, so this is
        // also the proof that migration 0016's per-tenant switch works.
        const records = await auditFor(
          admin,
          fixture.acme,
          AUDIT_ACTIONS.ROLE_BINDING_EXPIRED,
        );
        expect(records).toHaveLength(1);
        expect(records[0].payload).toMatchObject({
          user_id: fixture.acme.memberUserId,
          role_id: fixture.acme.roleId,
        });
        // A timer caused this, so no user is credited with it.
        expect(records[0].actor_type).toBe('platform');
        expect(records[0].actor_id).toBeNull();
      });

      it('claims each binding exactly once, however often it runs', async () => {
        const token = await asAdmin();
        const binding = await bindMember(token, TOMORROW());
        await expire(admin, fixture.acme, binding.id, A_MOMENT_AGO());

        await expect(sweep.runOnce()).resolves.toEqual({ bindings: 1, subjects: 1 });
        announced = [];

        // The property `expiry_swept_at` exists for: idempotent across restarts,
        // late runs and concurrent replicas. A second pass must not re-audit a
        // grant that already lapsed, or the trail would grow a row a minute
        // forever.
        await expect(sweep.runOnce()).resolves.toEqual({ bindings: 0, subjects: 0 });
        expect(announced).toEqual([]);

        const records = await auditFor(
          admin,
          fixture.acme,
          AUDIT_ACTIONS.ROLE_BINDING_EXPIRED,
        );
        expect(records).toHaveLength(1);
      });

      it('leaves unexpired and permanent bindings alone', async () => {
        const token = await asAdmin();
        await bindMember(token, TOMORROW());
        announced = [];

        // The steady state: a grant with a future expiry and a grant with none
        // are both invisible to the sweep, which is what keeps the partial index
        // of migration 0016 empty and the once-a-minute pass free.
        await expect(sweep.runOnce()).resolves.toEqual({ bindings: 0, subjects: 0 });
        expect(announced).toEqual([]);
      });

      it('does not make the binding disappear from the API', async () => {
        const token = await asAdmin();
        const binding = await bindMember(token, TOMORROW());
        await expire(admin, fixture.acme, binding.id, A_MOMENT_AGO());
        await sweep.runOnce();

        // Doc 06 §9: expired bindings stay listable and flagged. The sweep marks
        // housekeeping state; it is not a delayed delete, and an access history
        // that erased lapsed grants could not answer "who could do this in
        // March".
        const response = await call(token, 'GET', '/iam/role-bindings');
        expect(response.status).toBe(200);
        const listed = (await response.json()) as Paginated<RoleBindingDTO>;
        const found = listed.data.find((item) => item.id === binding.id);
        expect(found?.expired).toBe(true);

        // And it grants nothing, which `resolve()` decided from `expires_at`
        // alone — the sweep never was what made it stop working.
        await expect(memberGrants()).resolves.toEqual({ permissions: [], scopes: {} });
      });
    });
  },
);

// ── fixtures ────────────────────────────────────────────────────────────────

async function elevate(admin: DataSource, clientId: string): Promise<void> {
  await admin.query(`select set_config('app.is_platform_admin', 'true', false)`);
  await admin.query(`select set_config('app.current_client_id', $1, false)`, [clientId]);
}

async function seedCatalog(admin: DataSource): Promise<Catalog> {
  const suffix = randomUUID().slice(0, 8);
  const applicationId = randomUUID();
  const approveId = randomUUID();
  const createId = randomUUID();
  const applicationKey = `${PREFIX}gatepass-${suffix}`;

  await admin.query(`select set_config('app.is_platform_admin', 'true', false)`);
  await admin.query(`select set_config('app.current_client_id', '', false)`);

  await admin.query(
    `insert into ${S}."application" (id, key, name) values ($1, $2, $3)`,
    [applicationId, applicationKey, 'Session 22 Gatepass'],
  );

  const catalog: Catalog = {
    applicationId,
    applicationKey,
    approveId,
    createId,
    approve: `s22gatepass${suffix}.dc.approve`,
    create: `s22gatepass${suffix}.dc.create`,
  };

  for (const [id, key, name] of [
    [approveId, catalog.approve, 'Approve a delivery challan'],
    [createId, catalog.create, 'Create a delivery challan'],
  ] as const) {
    await admin.query(
      `insert into ${S}."permission" (id, application_id, key, name)
       values ($1, $2, $3, $4)`,
      [id, applicationId, key, name],
    );
  }

  return catalog;
}

async function seedTenant(
  admin: DataSource,
  secretHash: string,
  catalog: Catalog,
): Promise<Tenant> {
  const suffix = randomUUID().slice(0, 8);

  const node = (id: string, parentPath?: string): Node => ({
    id,
    path:
      parentPath === undefined ? scopePathLabel(id) : `${parentPath}.${scopePathLabel(id)}`,
  });

  const root = node(randomUUID());
  const plant = node(randomUUID(), root.path);
  const gate = node(randomUUID(), plant.path);
  const spare = node(randomUUID(), root.path);

  const tenant: Tenant = {
    clientId: randomUUID(),
    slug: `${PREFIX}acme-${suffix}`,
    adminEmail: `admin-${suffix}@example.test`,
    adminUserId: randomUUID(),
    memberEmail: `member-${suffix}@example.test`,
    memberUserId: randomUUID(),
    serviceAccountId: randomUUID(),
    root,
    plant,
    gate,
    spare,
    roleId: randomUUID(),
  };

  await elevate(admin, tenant.clientId);
  await admin.query(
    `insert into ${S}."client" (id, name, slug, status) values ($1, $2, $3, 'active')`,
    [tenant.clientId, `Session 22 Acme ${suffix}`, tenant.slug],
  );

  for (const [id, email, name, isAdmin] of [
    [tenant.adminUserId, tenant.adminEmail, 'Session 22 Admin', true],
    [tenant.memberUserId, tenant.memberEmail, 'Session 22 Member', false],
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
     values ($1, $2, 'Session 22 Integration', $3, $4, 'active')`,
    [tenant.serviceAccountId, tenant.clientId, `${PREFIX}svc-${suffix}`, secretHash],
  );

  for (const [current, parentId, kind, name] of [
    [root, null, 'group', 'Session 22 Acme'],
    [plant, root.id, 'plant', 'Plant A'],
    [gate, plant.id, 'gate', 'Gate 1'],
    [spare, root.id, 'group', 'Session 22 Spare'],
  ] as const) {
    await admin.query(
      `insert into ${S}."scope_node" (id, client_id, parent_id, kind, name, path)
       values ($1, $2, $3, $4, $5, $6::ltree)`,
      [current.id, tenant.clientId, parentId, kind, name, current.path],
    );
  }

  await admin.query(
    `insert into ${S}."role" (id, client_id, name, description)
     values ($1, $2, 'Session 22 Approver', 'Session 22 fixture')`,
    [tenant.roleId, tenant.clientId],
  );
  for (const permissionId of [catalog.approveId, catalog.createId]) {
    await admin.query(
      `insert into ${S}."role_permission" (role_id, permission_id) values ($1, $2)`,
      [tenant.roleId, permissionId],
    );
  }

  await admin.query(
    `insert into ${S}."client_application" (client_id, application_id, enabled)
     values ($1, $2, true)`,
    [tenant.clientId, catalog.applicationId],
  );

  return tenant;
}

/**
 * Back to the state every case starts from.
 *
 * Recreates whatever the previous case deleted — the role and its mappings, the
 * member's account status, the service account's — rather than reseeding the
 * whole tenant, which would invalidate the ids the fixture holds.
 */
async function resetTenant(
  admin: DataSource,
  tenant: Tenant,
  catalog: Catalog,
): Promise<void> {
  await elevate(admin, tenant.clientId);

  await admin.query(`delete from ${S}."role_binding" where client_id = $1`, [
    tenant.clientId,
  ]);
  await admin.query(`delete from ${S}."audit_trail" where client_id = $1`, [
    tenant.clientId,
  ]);

  await admin.query(
    `insert into ${S}."role" (id, client_id, name, description)
     values ($1, $2, 'Session 22 Approver', 'Session 22 fixture')
     on conflict (id) do nothing`,
    [tenant.roleId, tenant.clientId],
  );
  await admin.query(`delete from ${S}."role_permission" where role_id = $1`, [
    tenant.roleId,
  ]);
  for (const permissionId of [catalog.approveId, catalog.createId]) {
    await admin.query(
      `insert into ${S}."role_permission" (role_id, permission_id) values ($1, $2)`,
      [tenant.roleId, permissionId],
    );
  }

  await admin.query(
    `update ${S}."user" set status = 'active' where client_id = $1`,
    [tenant.clientId],
  );
  await admin.query(
    `update ${S}."service_account" set status = 'active' where client_id = $1`,
    [tenant.clientId],
  );
  await admin.query(
    `update ${S}."client_application" set enabled = true where client_id = $1`,
    [tenant.clientId],
  );
  await admin.query(`delete from ${S}."session" where client_id = $1`, [tenant.clientId]);

  // The move case rewrites `plant`'s subtree and leaves it there, so the paths
  // the fixture holds would be stale for every case after it. Restored by id
  // rather than by rebuilding the tree, because the ids are what the bindings
  // and the assertions name.
  for (const [current, parentId, name] of [
    [tenant.root, null, 'Session 22 Acme'],
    [tenant.plant, tenant.root.id, 'Plant A'],
    [tenant.gate, tenant.plant.id, 'Gate 1'],
    [tenant.spare, tenant.root.id, 'Session 22 Spare'],
  ] as const) {
    await admin.query(
      `update ${S}."scope_node"
          set parent_id = $3, path = $4::ltree, name = $5
        where client_id = $1 and id = $2`,
      [tenant.clientId, current.id, parentId, current.path, name],
    );
  }
}

/** Undoes a manifest deactivation from the previous case. */
async function reactivateCatalog(admin: DataSource, catalog: Catalog): Promise<void> {
  await admin.query(`select set_config('app.is_platform_admin', 'true', false)`);
  await admin.query(`select set_config('app.current_client_id', '', false)`);
  await admin.query(
    `update ${S}."permission" set is_active = true where application_id = $1`,
    [catalog.applicationId],
  );
  await admin.query(`update ${S}."application" set is_active = true where id = $1`, [
    catalog.applicationId,
  ]);
}

async function platformClientId(admin: DataSource): Promise<string> {
  await admin.query(`select set_config('app.is_platform_admin', 'true', false)`);
  await admin.query(`select set_config('app.current_client_id', '', false)`);
  const [row] = (await admin.query(
    `select client_id from ${S}."service_account" where key = $1`,
    [PLATFORM_SERVICE_ACCOUNT_KEY],
  )) as { client_id: string | null }[];
  return row?.client_id ?? '';
}

/** Backdates a binding's expiry — a state the API refuses to create. */
async function expire(
  admin: DataSource,
  tenant: Tenant,
  bindingId: string,
  at: Date,
): Promise<void> {
  await elevate(admin, tenant.clientId);
  await admin.query(
    `update ${S}."role_binding"
        set expires_at = $2, expiry_swept_at = null
      where client_id = $1 and id = $3`,
    [tenant.clientId, at, bindingId],
  );
}

async function pathOf(
  admin: DataSource,
  tenant: Tenant,
  nodeId: string,
): Promise<string | null> {
  await elevate(admin, tenant.clientId);
  const [row] = (await admin.query(
    `select path::text as path from ${S}."scope_node" where client_id = $1 and id = $2`,
    [tenant.clientId, nodeId],
  )) as { path: string }[];
  return row?.path ?? null;
}

async function auditFor(
  admin: DataSource,
  tenant: Tenant,
  action: string,
): Promise<{ payload: Record<string, unknown>; actor_type: string; actor_id: string | null }[]> {
  await elevate(admin, tenant.clientId);
  return (await admin.query(
    `select payload, actor_type, actor_id from ${S}."audit_trail"
      where client_id = $1 and action = $2
      order by created_at asc`,
    [tenant.clientId, action],
  )) as {
    payload: Record<string, unknown>;
    actor_type: string;
    actor_id: string | null;
  }[];
}

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
  await admin.query(`delete from ${S}."application" where key like $1`, [`${PREFIX}%`]);
}

/** Deepest first, so the self-referencing parent FK never blocks a delete. */
async function deleteScopeNodes(admin: DataSource, clientId: string): Promise<void> {
  await admin.query(
    `delete from ${S}."scope_node" sn
      where sn.client_id = $1
        and not exists (
          select 1 from ${S}."scope_node" child
           where child.parent_id = sn.id
        )`,
    [clientId],
  );
  const [{ remaining }] = (await admin.query(
    `select count(*)::int as remaining from ${S}."scope_node" where client_id = $1`,
    [clientId],
  )) as { remaining: number }[];
  if (remaining > 0) await deleteScopeNodes(admin, clientId);
}
