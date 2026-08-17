/**
 * The Session 18 Definition of Done: **the user lifecycle over HTTP, including
 * every status transition and what each one does to a live session**
 * (Doc 06 §8, Doc 03 §8, Doc 09 §3.3).
 *
 * Every claim this session makes is a claim about Postgres or about a running
 * request. That `unique (client_id, email)` lets the same address be two
 * different people in two tenants; that locking somebody logs them out of a
 * device they are holding *now*, which no assertion about a row can show; that a
 * user created through this API has no credential and reaches one through the
 * reset flow; that a disabled account does not walk back through the unlock
 * button; and that another tenant's user is a 404 rather than a 403. A fake
 * database can express none of them, so this suite runs against a real one:
 *
 *   pg_ctl start                # a local Postgres 17 (see .env)
 *   npm run migration:run
 *   npx nx test @plantops/iam-api
 *
 * **Destructive within its own fixtures only.** Every client it creates is
 * slugged `s18-…`, and it is removed afterwards with the rows that hang off it.
 *
 * ## The caller is a tenant's own client admin
 *
 * A client-tier surface (Doc 06 §8): the subject is a user of the tenant, logged
 * in at `POST /auth/login`, and the tenant comes from that token's `cid`. The
 * second tenant exists precisely so "another client's user is invisible" and
 * "the same address is two people" are tested rather than assumed.
 *
 * ## Deliberate deviations from the shipped configuration
 *
 * - **Rate limiting is off.** These cases make dozens of calls against a surface
 *   bounded at sixty a minute.
 * - **The reset-token transport is an array**, which is what the delivery port
 *   exists for (`password-reset.delivery.ts`). It is how the invite round-trip
 *   below can assert that a credential-less user becomes one who can log in.
 * - **`GrantInvalidationService.publish` is spied on** where the Doc 04 §7 hook
 *   is under test, and the spy reads the database *on another connection* to see
 *   whether the transition had committed by the time it ran. That is the
 *   assertion; the stub's own body is a log line and has nothing to prove.
 * - **Nothing else.** The interim permission rule, the validation pipe, the RLS
 *   context, the session revocation and the audit path are the shipped ones.
 */

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { loadEnv } from '@plantops/config';
import {
  IamErrorCode,
  type IamErrorResponse,
  type Paginated,
  type TokenPairResponse,
  type UserDTO,
  type UserDetailDTO,
  type UserStatus,
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
import {
  PASSWORD_RESET_DELIVERY,
  type PasswordResetDelivery,
  type PasswordResetMessage,
} from '../auth/password-reset.delivery';
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
const PREFIX = 's18-';

/** The address both tenants use, to prove it names two different people. */
const SHARED_EMAIL = 'shared.supervisor@example.test';

/** The mail transport, held in an array (`password-reset.delivery.ts`). */
class CapturingDelivery implements PasswordResetDelivery {
  readonly sent: PasswordResetMessage[] = [];

  async deliver(message: PasswordResetMessage): Promise<void> {
    this.sent.push(message);
  }

  latest(): PasswordResetMessage {
    const message = this.sent.at(-1);
    if (message === undefined) throw new Error('No reset token was delivered');
    return message;
  }
}

/** One tenant, with the identities and the org root the cases need. */
interface Tenant {
  clientId: string;
  slug: string;
  /** `is_client_admin` — the caller for almost every case. */
  adminEmail: string;
  adminUserId: string;
  /** An ordinary user: the interim authorization must refuse one, and the cases lock somebody. */
  memberEmail: string;
  memberUserId: string;
  /** The org root, so a binding has somewhere to hang. */
  scopeNodeId: string;
  scopeNodePath: string;
  /** A role to bind, so the detail panel has grants to render. */
  roleId: string;
}

interface Fixture {
  acme: Tenant;
  other: Tenant;
}

describeWithDb(
  `user APIs (${configured ? 'live' : 'skipped: no DATABASE_URL'})`,
  () => {
    let app: INestApplication;
    let baseUrl: string;
    let admin: DataSource;
    let fixture: Fixture;
    let delivery: CapturingDelivery;
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
      };

      const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(ENV)
        .useValue({ ...env, RATE_LIMIT_ENABLED: false })
        .overrideProvider(PASSWORD_RESET_DELIVERY)
        .useValue((delivery = new CapturingDelivery()))
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
      // Back to two active users, no sessions, no bindings and no audit history.
      // Every case here mutates accounts it shares with the next one, so the
      // state is restored rather than assumed — a lockout leaking forward would
      // make an unrelated assertion fail for a reason it does not name.
      for (const tenant of [fixture.acme, fixture.other]) {
        await resetTenant(admin, tenant);
      }
      delivery.sent.length = 0;
      jest.restoreAllMocks();
    });

    // ── the wire ──────────────────────────────────────────────────────────

    const login = (email: string, slug: string): Promise<Response> =>
      fetch(`${baseUrl}/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, password: PASSWORD, client_slug: slug }),
      });

    const loginOk = async (email: string, slug: string): Promise<TokenPairResponse> => {
      const response = await login(email, slug);
      expect(response.status).toBe(200);
      return (await response.json()) as TokenPairResponse;
    };

    const asAdmin = async (tenant: Tenant = fixture.acme): Promise<string> =>
      (await loginOk(tenant.adminEmail, tenant.slug)).access_token;

    const asMember = async (tenant: Tenant = fixture.acme): Promise<TokenPairResponse> =>
      loginOk(tenant.memberEmail, tenant.slug);

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

    const whoami = (accessToken: string): Promise<Response> =>
      fetch(`${baseUrl}/iam/whoami`, {
        headers: { authorization: `Bearer ${accessToken}` },
      });

    const errorOf = async (response: Response) =>
      ((await response.json()) as IamErrorResponse).error;

    /** Creates a user and asserts the 201, returning the DTO. */
    const createUser = async (
      token: string,
      body: Record<string, unknown>,
    ): Promise<UserDTO> => {
      const response = await call(token, 'POST', '/iam/users', body);
      expect(response.status).toBe(201);
      return (await response.json()) as UserDTO;
    };

    /** Patches a user and asserts the 200, returning the detail shape. */
    const patchUser = async (
      token: string,
      id: string,
      body: Record<string, unknown>,
    ): Promise<UserDetailDTO> => {
      const response = await call(token, 'PATCH', `/iam/users/${id}`, body);
      expect(response.status).toBe(200);
      return (await response.json()) as UserDetailDTO;
    };

    const listUsers = async (token: string, query = ''): Promise<Paginated<UserDTO>> => {
      const response = await call(token, 'GET', `/iam/users${query}`);
      expect(response.status).toBe(200);
      return (await response.json()) as Paginated<UserDTO>;
    };

    // ── inspection, through the owner connection ──────────────────────────

    const statusOf = async (tenant: Tenant, userId: string): Promise<UserStatus> => {
      await elevate(admin, tenant.clientId);
      const [row] = (await admin.query(
        `select status from ${S}."user" where client_id = $1 and id = $2`,
        [tenant.clientId, userId],
      )) as { status: UserStatus }[];
      return row.status;
    };

    const identityCount = async (tenant: Tenant, userId: string): Promise<number> => {
      await elevate(admin, tenant.clientId);
      const [row] = (await admin.query(
        `select count(*)::int as total from ${S}."user_identity"
          where client_id = $1 and user_id = $2`,
        [tenant.clientId, userId],
      )) as { total: number }[];
      return row.total;
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

    // ── creating ─────────────────────────────────────────────────────────

    describe('creating', () => {
      it('creates a user in the caller`s own tenant and audits it', async () => {
        const token = await asAdmin();

        const user = await createUser(token, {
          email: '  Gate.Supervisor@ACME.test ',
          full_name: 'Gita Rao',
          phone: '+91 98765 43210',
        });

        // The tenant is the token's, never a field of the request; the address
        // is normalized, because that is what makes `unique (client_id, email)`
        // a genuinely case-insensitive identity constraint.
        expect(user.client_id).toBe(fixture.acme.clientId);
        expect(user.email).toBe('gate.supervisor@acme.test');
        expect(user.full_name).toBe('Gita Rao');
        expect(user.phone).toBe('+91 98765 43210');
        expect(user.status).toBe('active');
        // Not settable through this surface: it is the flag the interim
        // authorization reads, and promoting somebody is a binding (Session 20).
        expect(user.is_client_admin).toBe(false);

        const [record] = await auditFor(fixture.acme, AUDIT_ACTIONS.USER_CREATED);
        expect(record).toMatchObject({
          email: 'gate.supervisor@acme.test',
          full_name: 'Gita Rao',
          status: 'active',
          is_client_admin: false,
        });
      });

      it('honours the initial status Doc 09 §3.3 puts on the form', async () => {
        const token = await asAdmin();

        const user = await createUser(token, {
          email: 'not.started@acme.test',
          full_name: 'Nita Shah',
          status: 'disabled',
        });

        expect(user.status).toBe('disabled');
        expect(await statusOf(fixture.acme, user.id)).toBe('disabled');
      });

      it('refuses a duplicate address inside one client, and permits it across two', async () => {
        const token = await asAdmin();
        await createUser(token, { email: SHARED_EMAIL, full_name: 'Gita Rao' });

        const duplicate = await call(token, 'POST', '/iam/users', {
          email: SHARED_EMAIL,
          full_name: 'Someone Else',
        });
        expect(duplicate.status).toBe(409);
        const error = await errorOf(duplicate);
        expect(error.code).toBe(IamErrorCode.CONFLICT);
        expect(error.message).toContain(SHARED_EMAIL);

        // `unique (client_id, email)`, not `unique (email)`: the same address is
        // a distinct person in another tenant, and neither learns of the other
        // (Doc 01 §3.6). Login is by `(client_slug, email)`, which is what makes
        // that safe.
        const theirs = await createUser(await asAdmin(fixture.other), {
          email: SHARED_EMAIL,
          full_name: 'A Different Person',
        });
        expect(theirs.client_id).toBe(fixture.other.clientId);
        expect(theirs.id).not.toBe(fixture.acme.adminUserId);
      });

      it('creates no credential — the reset flow is how one is set', async () => {
        const token = await asAdmin();
        const user = await createUser(token, {
          email: 'new.joiner@acme.test',
          full_name: 'Nikhil Joshi',
        });

        // Nothing on `user_identity` yet, so there is no password to log in
        // with and none for an operator to have handled.
        expect(await identityCount(fixture.acme, user.id)).toBe(0);
        expect((await login('new.joiner@acme.test', fixture.acme.slug)).status).toBe(401);

        // Doc 03 §7's tokenized flow works for any active user of an active
        // client, credential or not — which is what makes creation and
        // invitation one act.
        const requested = await fetch(`${baseUrl}/auth/password/reset-request`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            email: 'new.joiner@acme.test',
            client_slug: fixture.acme.slug,
          }),
        });
        expect(requested.status).toBe(202);

        const completed = await fetch(`${baseUrl}/auth/password/reset`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            token: delivery.latest().token,
            new_password: PASSWORD,
          }),
        });
        expect(completed.status).toBe(204);

        expect((await login('new.joiner@acme.test', fixture.acme.slug)).status).toBe(200);
      });
    });

    // ── listing, searching, filtering (Doc 06 §8, Doc 09 §3.3) ───────────

    describe('listing', () => {
      it('returns the pagination envelope, ordered by name', async () => {
        const token = await asAdmin();
        await createUser(token, { email: 'zara@acme.test', full_name: 'Zara Ali' });
        await createUser(token, { email: 'abhay@acme.test', full_name: 'Abhay Kumar' });

        const body = await listUsers(token);

        expect(body).toMatchObject({ page: 1, limit: 25, total: 4 });
        // Alphabetical: an operator scans this for somebody whose name they
        // already know. The two seeded fixtures are named for their roles.
        expect(body.data.map((entry) => entry.full_name)).toEqual([
          'Abhay Kumar',
          'Session 18 Admin',
          'Session 18 Member',
          'Zara Ali',
        ]);
      });

      it('pages, and reports the total rather than the page length', async () => {
        const token = await asAdmin();
        await createUser(token, { email: 'zara@acme.test', full_name: 'Zara Ali' });

        const body = await listUsers(token, '?page=2&limit=2');

        expect(body).toMatchObject({ page: 2, limit: 2, total: 3 });
        expect(body.data).toHaveLength(1);
      });

      it('filters by status — the "Account Locked Users" screen', async () => {
        const token = await asAdmin();
        const locked = await createUser(token, {
          email: 'locked.out@acme.test',
          full_name: 'Locked Out',
        });
        await patchUser(token, locked.id, { status: 'locked' });

        const body = await listUsers(token, '?status=locked');

        expect(body.data.map((entry) => entry.id)).toEqual([locked.id]);
        expect(body.total).toBe(1);
      });

      it('searches the address and the name, and treats `_` literally', async () => {
        const token = await asAdmin();
        const found = await createUser(token, {
          email: 'gita.rao@acme.test',
          full_name: 'Gita Rao',
        });
        await createUser(token, { email: 'other@acme.test', full_name: 'Someone Else' });

        expect((await listUsers(token, '?q=gita.rao')).data.map((e) => e.id)).toEqual([
          found.id,
        ]);
        expect((await listUsers(token, '?q=RAO')).data.map((e) => e.id)).toEqual([
          found.id,
        ]);

        // `_` is `ilike`'s single-character wildcard, and a search box is not a
        // pattern language — "g_ta" must find nothing rather than "Gita".
        expect((await listUsers(token, '?q=g_ta')).data).toEqual([]);
      });

      it('shows the caller only their own tenant`s users', async () => {
        const token = await asAdmin();
        await createUser(await asAdmin(fixture.other), {
          email: 'theirs@other.test',
          full_name: 'Their Person',
        });

        const body = await listUsers(token);

        expect(
          body.data.every((entry) => entry.client_id === fixture.acme.clientId),
        ).toBe(true);
      });
    });

    // ── detail, with the bindings sub-panel (Doc 09 §3.3) ────────────────

    describe('detail', () => {
      it('includes the grants the user holds, expired ones flagged', async () => {
        const token = await asAdmin();
        const child = await insertScopeNode(admin, fixture.acme, 'Plant B');
        await insertBinding(admin, fixture.acme, fixture.acme.memberUserId, {
          scopeNodeId: fixture.acme.scopeNodeId,
        });
        await insertBinding(admin, fixture.acme, fixture.acme.memberUserId, {
          scopeNodeId: child,
          // Yesterday: lapsed, and therefore listed rather than hidden — a grant
          // that stopped working is the answer to "why did this stop working".
          expiresAt: new Date(Date.now() - 86_400_000),
        });

        const response = await call(
          token,
          'GET',
          `/iam/users/${fixture.acme.memberUserId}`,
        );
        expect(response.status).toBe(200);
        const user = (await response.json()) as UserDetailDTO;

        expect(user.bindings).toHaveLength(2);
        expect(user.bindings[0]).toMatchObject({
          role_id: fixture.acme.roleId,
          role_name: 'Session 18 Role',
          scope_node_id: fixture.acme.scopeNodeId,
          scope_node_path: fixture.acme.scopeNodePath,
          expires_at: null,
          expired: false,
        });
        // Ordered by path, so the panel groups a person's access by where it
        // applies — the root before the plant beneath it.
        expect(user.bindings[1]).toMatchObject({
          scope_node_id: child,
          expired: true,
        });
        expect(user.bindings[1].expires_at).not.toBeNull();
      });

      it('gives another tenant`s user the same answer as a nonexistent id', async () => {
        const token = await asAdmin();

        const bodyOf = async (response: Response) => {
          const { code, message } = await errorOf(response);
          return { code, message };
        };

        const foreign = await call(
          token,
          'GET',
          `/iam/users/${fixture.other.memberUserId}`,
        );
        const missing = await call(token, 'GET', `/iam/users/${randomUUID()}`);

        expect(foreign.status).toBe(404);
        expect(missing.status).toBe(404);
        // Identical down to the wording — only the `requestId` differs, which is
        // per-request by construction and carries nothing about the target. The
        // response cannot be used to discover that an address exists elsewhere.
        expect(await bodyOf(foreign)).toEqual(await bodyOf(missing));
      });
    });

    // ── the profile half of PATCH ────────────────────────────────────────

    describe('updating the profile', () => {
      it('edits the columns and audits the before and after', async () => {
        const token = await asAdmin();
        const user = await createUser(token, {
          email: 'gita.rao@acme.test',
          full_name: 'Gita Rao',
        });

        const updated = await patchUser(token, user.id, {
          full_name: 'Gita Rao-Mehta',
          phone: '+91 90000 00000',
        });

        expect(updated.full_name).toBe('Gita Rao-Mehta');
        expect(updated.phone).toBe('+91 90000 00000');
        // The detail shape, so the screen that saved it can re-render without a
        // second round-trip.
        expect(updated.bindings).toEqual([]);

        const [record] = await auditFor(fixture.acme, AUDIT_ACTIONS.USER_UPDATED);
        expect(record).toMatchObject({
          changed: ['full_name', 'phone'],
          before: { full_name: 'Gita Rao', phone: null },
          after: { full_name: 'Gita Rao-Mehta', phone: '+91 90000 00000' },
        });
      });

      it('corrects a mistyped address, which is half the login credential', async () => {
        const token = await asAdmin();
        const user = await createUser(token, {
          email: 'gita.roa@acme.test',
          full_name: 'Gita Rao',
        });

        const updated = await patchUser(token, user.id, {
          email: 'Gita.Rao@ACME.test',
        });

        expect(updated.email).toBe('gita.rao@acme.test');
        const [record] = await auditFor(fixture.acme, AUDIT_ACTIONS.USER_UPDATED);
        expect(record).toMatchObject({
          changed: ['email'],
          before: { email: 'gita.roa@acme.test' },
          after: { email: 'gita.rao@acme.test' },
        });
      });

      it('audits nothing when the body is resubmitted unchanged', async () => {
        const token = await asAdmin();
        const user = await createUser(token, {
          email: 'gita.rao@acme.test',
          full_name: 'Gita Rao',
        });

        await patchUser(token, user.id, {
          email: 'gita.rao@acme.test',
          full_name: 'Gita Rao',
          status: 'active',
        });

        expect(await auditFor(fixture.acme, AUDIT_ACTIONS.USER_UPDATED)).toEqual([]);
        expect(await auditFor(fixture.acme, AUDIT_ACTIONS.ACCOUNT_LOCKED)).toEqual([]);
      });

      it('refuses an address another user of the same client holds', async () => {
        const token = await asAdmin();
        await createUser(token, { email: 'taken@acme.test', full_name: 'Taken' });
        const other = await createUser(token, {
          email: 'free@acme.test',
          full_name: 'Free',
        });

        const response = await call(token, 'PATCH', `/iam/users/${other.id}`, {
          email: 'taken@acme.test',
        });

        expect(response.status).toBe(409);
        expect(await statusOf(fixture.acme, other.id)).toBe('active');
      });
    });

    // ── the state machine half of PATCH (Doc 03 §8) ──────────────────────

    describe('status transitions', () => {
      it('locks: sessions die immediately and login is refused with 423', async () => {
        const token = await asAdmin();
        const member = await asMember();
        expect((await whoami(member.access_token)).status).toBe(200);

        const updated = await patchUser(token, fixture.acme.memberUserId, {
          status: 'locked',
        });

        expect(updated.status).toBe('locked');
        // "Immediately" is the point: the token is still signed, still
        // unexpired, and still refused — the revoked-`sid` cache is what makes
        // that true before the access token's own expiry (Doc 03 §6).
        expect((await whoami(member.access_token)).status).toBe(401);
        expect((await login(fixture.acme.memberEmail, fixture.acme.slug)).status).toBe(
          423,
        );

        // The auth vocabulary, not `user.updated`: the failed-attempt policy
        // writes the same event from the login path, and one event must not have
        // two spellings depending on who tripped it (migration 0014).
        expect(await auditFor(fixture.acme, AUDIT_ACTIONS.ACCOUNT_LOCKED)).toHaveLength(
          1,
        );
        expect(await auditFor(fixture.acme, AUDIT_ACTIONS.SESSION_REVOKED)).toHaveLength(
          1,
        );
      });

      it('unlocks back to active, without restoring the sessions it killed', async () => {
        const token = await asAdmin();
        const member = await asMember();
        await patchUser(token, fixture.acme.memberUserId, { status: 'locked' });

        const updated = await patchUser(token, fixture.acme.memberUserId, {
          status: 'active',
        });

        expect(updated.status).toBe('active');
        expect((await login(fixture.acme.memberEmail, fixture.acme.slug)).status).toBe(
          200,
        );
        // A revocation is a fact about a moment. Unlock restores the account,
        // not the sessions it had.
        expect((await whoami(member.access_token)).status).toBe(401);
        expect(await auditFor(fixture.acme, AUDIT_ACTIONS.ACCOUNT_UNLOCKED)).toHaveLength(
          1,
        );
      });

      it('disables: every session revoked, under its own action', async () => {
        const token = await asAdmin();
        const first = await asMember();
        const second = await asMember();

        await patchUser(token, fixture.acme.memberUserId, { status: 'disabled' });

        expect((await whoami(first.access_token)).status).toBe(401);
        expect((await whoami(second.access_token)).status).toBe(401);
        expect(await auditFor(fixture.acme, AUDIT_ACTIONS.USER_DISABLED)).toHaveLength(1);
        expect(await auditFor(fixture.acme, AUDIT_ACTIONS.SESSION_REVOKED)).toHaveLength(
          2,
        );
      });

      it('refuses to walk a disabled account back to active', async () => {
        const token = await asAdmin();
        await patchUser(token, fixture.acme.memberUserId, { status: 'disabled' });

        const response = await call(
          token,
          'PATCH',
          `/iam/users/${fixture.acme.memberUserId}`,
          { status: 'active' },
        );

        // A 409, not a 403: the caller may administer users — this change simply
        // contradicts the state the row is in. Offboarding is one-way (Doc 03 §8).
        expect(response.status).toBe(409);
        expect((await errorOf(response)).code).toBe(IamErrorCode.CONFLICT);
        expect(await statusOf(fixture.acme, fixture.acme.memberUserId)).toBe('disabled');
      });

      it('refuses to change the caller`s own status', async () => {
        const token = await asAdmin();

        const response = await call(
          token,
          'PATCH',
          `/iam/users/${fixture.acme.adminUserId}`,
          { status: 'disabled' },
        );

        // Every transition out of `active` revokes the actor's own sessions, and
        // `disabled` cannot be undone through this API — a tenant whose only
        // administrator disabled themselves would need a platform operator.
        expect(response.status).toBe(409);
        expect(await statusOf(fixture.acme, fixture.acme.adminUserId)).toBe('active');
      });

      it('takes the profile edit back with a refused transition', async () => {
        const token = await asAdmin();
        await patchUser(token, fixture.acme.memberUserId, { status: 'disabled' });

        const response = await call(
          token,
          'PATCH',
          `/iam/users/${fixture.acme.memberUserId}`,
          { full_name: 'Renamed Anyway', status: 'active' },
        );
        expect(response.status).toBe(409);

        // Both halves are in the request transaction, so a `PATCH` that renamed
        // somebody and then declined to re-enable them is not half-applied.
        const detail = await call(
          token,
          'GET',
          `/iam/users/${fixture.acme.memberUserId}`,
        );
        expect(((await detail.json()) as UserDetailDTO).full_name).toBe(
          'Session 18 Member',
        );
      });

      it('re-applying a state changes and audits nothing', async () => {
        const token = await asAdmin();
        await patchUser(token, fixture.acme.memberUserId, { status: 'locked' });

        await patchUser(token, fixture.acme.memberUserId, { status: 'locked' });

        // An audit trail that logs "locked" twice because a screen was
        // double-clicked is one nobody can read.
        expect(await auditFor(fixture.acme, AUDIT_ACTIONS.ACCOUNT_LOCKED)).toHaveLength(
          1,
        );
      });
    });

    // ── the Doc 04 §7 invalidation hook ──────────────────────────────────

    describe('grant invalidation', () => {
      it('publishes for the locked subject, and only after the commit', async () => {
        const token = await asAdmin();
        const observed: { statusVisibleElsewhere: UserStatus; subjects: unknown }[] = [];

        jest
          .spyOn(invalidation, 'publish')
          .mockImplementation(async (clientId, subjects, reason) => {
            observed.push({
              // Read on the *owner* connection, outside the request's
              // transaction: if this sees `locked`, the transition had already
              // committed when the publish ran. Invalidating before commit lets
              // a reader repopulate from pre-change state and re-poison the
              // cache (Doc 04 §7.1).
              statusVisibleElsewhere: await statusOf(
                fixture.acme,
                fixture.acme.memberUserId,
              ),
              subjects: { clientId, subjects: [...subjects], reason },
            });
          });

        await patchUser(token, fixture.acme.memberUserId, { status: 'locked' });

        expect(observed).toHaveLength(1);
        expect(observed[0].statusVisibleElsewhere).toBe('locked');
        expect(observed[0].subjects).toEqual({
          clientId: fixture.acme.clientId,
          subjects: [{ type: 'user', id: fixture.acme.memberUserId }],
          reason: { cause: 'user.locked', userId: fixture.acme.memberUserId },
        });
      });

      it('publishes for a disable and stays silent for an unlock', async () => {
        const token = await asAdmin();
        const published = jest.spyOn(invalidation, 'publish').mockResolvedValue();

        await patchUser(token, fixture.acme.memberUserId, { status: 'locked' });
        published.mockClear();

        // Unlock gives access back rather than taking it away, and a subject
        // whose cached grants are correct does not need them recomputed —
        // Doc 04 §7 lists only "user locked/disabled".
        await patchUser(token, fixture.acme.memberUserId, { status: 'active' });
        expect(published).not.toHaveBeenCalled();

        await patchUser(token, fixture.acme.memberUserId, { status: 'disabled' });
        expect(published).toHaveBeenCalledWith(
          fixture.acme.clientId,
          [{ type: 'user', id: fixture.acme.memberUserId }],
          { cause: 'user.disabled', userId: fixture.acme.memberUserId },
        );
      });
    });

    // ── the interim authorization (Doc 06 §8) ────────────────────────────

    describe('authorization', () => {
      it('refuses an ordinary user of the tenant', async () => {
        const member = await asMember();

        for (const [method, path, body] of [
          ['GET', '/iam/users', undefined],
          ['POST', '/iam/users', { email: 'x@acme.test', full_name: 'X' }],
          ['GET', `/iam/users/${fixture.acme.memberUserId}`, undefined],
          ['PATCH', `/iam/users/${fixture.acme.memberUserId}`, { full_name: 'X' }],
        ] as const) {
          const response = await call(member.access_token, method, path, body);
          // A 403 rather than a 404: no target has been named at the point the
          // check runs, so there is nothing whose existence it could reveal.
          expect(response.status).toBe(403);
          expect((await errorOf(response)).code).toBe(IamErrorCode.PERMISSION_DENIED);
        }
      });

      it('refuses an unauthenticated request', async () => {
        const response = await fetch(`${baseUrl}/iam/users`);
        expect(response.status).toBe(401);
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
 * One tenant with an admin, an ordinary member, an org root and a role.
 *
 * Seeded directly rather than through `POST /iam/clients/:id/admins`, so this
 * suite's subject does not depend on Session 15's endpoint — the same choice
 * `roles.integration.spec.ts` makes, for the same reason.
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
    scopeNodePath: scopePathLabel(scopeNodeId),
    roleId: randomUUID(),
  };

  await elevate(admin, tenant.clientId);
  await admin.query(
    `insert into ${S}."client" (id, name, slug, status) values ($1, $2, $3, 'active')`,
    [tenant.clientId, `Session 18 ${label} ${suffix}`, tenant.slug],
  );

  for (const [id, email, name, isAdmin] of [
    [tenant.adminUserId, tenant.adminEmail, 'Session 18 Admin', true],
    [tenant.memberUserId, tenant.memberEmail, 'Session 18 Member', false],
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

  // The org root, with the id-derived ltree label of Doc 01 §3.5.
  await admin.query(
    `insert into ${S}."scope_node" (id, client_id, parent_id, kind, name, path)
     values ($1, $2, null, 'group', $3, $4::ltree)`,
    [scopeNodeId, tenant.clientId, `Session 18 ${label}`, tenant.scopeNodePath],
  );

  await admin.query(
    `insert into ${S}."role" (id, client_id, name, description)
     values ($1, $2, 'Session 18 Role', 'Session 18 fixture')`,
    [tenant.roleId, tenant.clientId],
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

  await admin.query(
    `insert into ${S}."scope_node" (id, client_id, parent_id, kind, name, path)
     values ($1, $2, $3, 'plant', $4, $5::ltree)`,
    [
      id,
      tenant.clientId,
      tenant.scopeNodeId,
      name,
      `${tenant.scopeNodePath}.${scopePathLabel(id)}`,
    ],
  );

  return id;
}

/** Binds a user to the tenant's fixture role, optionally with an expiry. */
async function insertBinding(
  admin: DataSource,
  tenant: Tenant,
  userId: string,
  options: { scopeNodeId: string; expiresAt?: Date },
): Promise<void> {
  await elevate(admin, tenant.clientId);
  await admin.query(
    `insert into ${S}."role_binding" (client_id, user_id, role_id, scope_node_id, expires_at)
     values ($1, $2, $3, $4, $5)`,
    [
      tenant.clientId,
      userId,
      tenant.roleId,
      options.scopeNodeId,
      options.expiresAt ?? null,
    ],
  );
}

/**
 * Back to the two seeded users, both active, with nothing hanging off them.
 *
 * The tenants, their root node and their role are seeded once: logging in is the
 * slowest thing here (argon2id, by design), so the accounts that log in are not
 * rebuilt per case.
 */
async function resetTenant(admin: DataSource, tenant: Tenant): Promise<void> {
  await elevate(admin, tenant.clientId);

  await admin.query(
    `delete from ${S}."role_binding" where client_id = $1`,
    [tenant.clientId],
  );
  await admin.query(`delete from ${S}."session" where client_id = $1`, [tenant.clientId]);
  await admin.query(`delete from ${S}."password_reset_token" where client_id = $1`, [
    tenant.clientId,
  ]);
  await admin.query(
    `delete from ${S}."user_identity"
      where client_id = $1 and user_id <> all($2::uuid[])`,
    [tenant.clientId, [tenant.adminUserId, tenant.memberUserId]],
  );
  await admin.query(
    `delete from ${S}."user" where client_id = $1 and id <> all($2::uuid[])`,
    [tenant.clientId, [tenant.adminUserId, tenant.memberUserId]],
  );
  await admin.query(
    `update ${S}."user"
        set status = 'active', failed_login_attempts = 0, last_failed_login_at = null
      where client_id = $1`,
    [tenant.clientId],
  );
  await admin.query(
    `delete from ${S}."scope_node" where client_id = $1 and parent_id is not null`,
    [tenant.clientId],
  );
  await admin.query(`delete from ${S}."audit_trail" where client_id = $1`, [
    tenant.clientId,
  ]);
  // The administrator's own authorization, last, because the wipes above take
  // it with them: since Session 23 every route on this surface is gated on an
  // `iam.client.*` permission, held through a role bound at the tenant root
  // (`testing/authorization.fixture.ts`).
  await grantIamClientAdmin(admin, tenant.clientId, tenant.scopeNodeId, {
    userId: tenant.adminUserId,
  });
}

/** Every `s18-` tenant, and everything hanging off it. */
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
}
