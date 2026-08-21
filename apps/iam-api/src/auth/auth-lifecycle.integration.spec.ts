/**
 * The Session 8 Definition of Done, end to end: login → authenticated request
 * → force-logout → refusal (Doc 03 §3, §6, §8).
 *
 * This suite needs a real Postgres, and it is the only way to test what Session
 * 8 actually built. Login reads and writes exclusively through the migration
 * 0012 `SECURITY DEFINER` functions, because RLS leaves the app role able to
 * see nothing before a token exists — and a fake database cannot fail the way
 * that arrangement can. The interesting failures are all database-side: a
 * function that forgets to restore the context it elevated, a policy that
 * silently hides the session row a moment after creating it, an audit row
 * attributed to the wrong actor. None of them are visible from the application.
 *
 *   docker compose up -d postgres
 *   npm run migration:run
 *   npx nx test @plantops/iam-api
 *
 * **Destructive within its own fixtures only.** It creates two clients under
 * generated slugs and removes them afterwards; it touches nothing else.
 *
 * ## Two deliberate deviations from the shipped configuration
 *
 * - **Rate limiting is off.** `POST /auth/login` ships with `failOpen: false`
 *   (see `auth.controller.ts`), so with no reachable Redis every login here
 *   would answer 429 and the suite would be testing the throttle rather than
 *   authentication. The throttle has its own coverage in `rate-limit.spec.ts`.
 * - **Redis may or may not be up**, and the assertions hold either way. That is
 *   not laxity — it is the point. With Redis, revocation lands through the
 *   cache; without it, `AuthGuard` falls back to `iam.session_is_revoked`.
 *   Both paths must refuse a revoked session, and this suite proves whichever
 *   one the environment provides.
 */

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { loadEnv } from '@plantops/config';
import {
  IamErrorCode,
  type IamErrorResponse,
  type SessionDTO,
  type TokenPairResponse,
} from '@plantops/contracts';
import {
  IAM_SCHEMA,
  IAM_SCHEMA_TEST_LOCK_ID,
  createMigrationDataSource,
  hashSecret,
} from '@plantops/db';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { DataSource } from 'typeorm';
import { AppModule } from '../app/app.module';
import { ENV } from '../config/env.token';
import type { WhoAmIResponse } from '../iam/whoami.controller';
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
const WRONG_PASSWORD = 'incorrect-horse-battery-staple';

interface Fixture {
  clientId: string;
  clientSlug: string;
  activeEmail: string;
  activeUserId: string;
  lockedEmail: string;
  /** A second tenant, suspended — its users must not be able to log in. */
  suspendedClientId: string;
  suspendedSlug: string;
  suspendedEmail: string;
}

describeWithDb(
  `auth lifecycle (${configured ? 'live' : 'skipped: no DATABASE_URL'})`,
  () => {
    let app: INestApplication;
    let baseUrl: string;
    let admin: DataSource;
    let fixture: Fixture;

    // Two argon2id hashes, migrations already applied, an app boot.
    jest.setTimeout(120_000);

    beforeAll(async () => {
      const env = loadEnv();

      admin = createMigrationDataSource(env);
      await admin.initialize();
      await admin.query('select pg_advisory_lock($1)', [IAM_SCHEMA_TEST_LOCK_ID]);

      fixture = await seed(admin);

      const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(ENV)
        // See the header: the login limit fails closed by design, which without
        // a counter store would refuse every request in this file.
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

    const login = (body: Record<string, unknown>) =>
      fetch(`${baseUrl}/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });

    const loginAs = async (
      email: string = fixture.activeEmail,
      password: string = PASSWORD,
      clientSlug: string = fixture.clientSlug,
      deviceLabel?: string,
    ): Promise<TokenPairResponse> => {
      const response = await login({
        email,
        password,
        client_slug: clientSlug,
        ...(deviceLabel === undefined ? {} : { device_label: deviceLabel }),
      });
      expect(response.status).toBe(200);
      return (await response.json()) as TokenPairResponse;
    };

    const authed = (token: string, path: string, init: RequestInit = {}) =>
      fetch(`${baseUrl}${path}`, {
        ...init,
        headers: { ...init.headers, authorization: `Bearer ${token}` },
      });

    /** Audit rows for this fixture's tenant, newest first. */
    const auditFor = async (clientId: string): Promise<AuditRow[]> => {
      await admin.query(`select set_config('app.is_platform_admin', 'true', false)`);
      return (await admin.query(
        `select action, actor_type, actor_id, payload
           from ${S}."audit_trail"
          where client_id = $1
          order by created_at desc`,
        [clientId],
      )) as AuditRow[];
    };

    describe('POST /auth/login', () => {
      it('issues an access token and a refresh token for valid credentials', async () => {
        const tokens = await loginAs();

        expect(tokens.access_token).toEqual(expect.any(String));
        expect(tokens.refresh_token).toEqual(expect.any(String));
        expect(tokens.expires_in).toBeGreaterThan(0);
        // The refresh token is opaque, not a JWT: nothing about a session
        // should be readable from the string a client stores for a week.
        expect(tokens.refresh_token.split('.')).toHaveLength(1);
      });

      it('produces a token that authenticates a real request', async () => {
        const tokens = await loginAs();

        const response = await authed(tokens.access_token, '/iam/whoami');
        const body = (await response.json()) as WhoAmIResponse;

        expect(response.status).toBe(200);
        expect(body.subjectId).toBe(fixture.activeUserId);
        // Read back from `current_setting` inside the handler's transaction:
        // the token's `cid` became the tenant Postgres itself enforces.
        expect(body.clientId).toBe(fixture.clientId);
        expect(body.userId).toBe(fixture.activeUserId);
      });

      it('refuses a wrong password and an unknown user identically', async () => {
        const wrongPassword = await login({
          email: fixture.activeEmail,
          password: WRONG_PASSWORD,
          client_slug: fixture.clientSlug,
        });
        const unknownUser = await login({
          email: `nobody-${randomUUID()}@example.test`,
          password: PASSWORD,
          client_slug: fixture.clientSlug,
        });

        const first = (await wrongPassword.json()) as IamErrorResponse;
        const second = (await unknownUser.json()) as IamErrorResponse;

        expect(wrongPassword.status).toBe(401);
        expect(unknownUser.status).toBe(401);
        expect(first.error.code).toBe(IamErrorCode.INVALID_CREDENTIALS);
        // Byte-identical messages, not merely equal codes: a message that
        // differs by branch is the same enumeration leak as a status that does
        // (Doc 03 §3).
        expect(second.error.code).toBe(first.error.code);
        expect(second.error.message).toBe(first.error.message);
      });

      it('refuses an unknown client with the same generic 401', async () => {
        const response = await login({
          email: fixture.activeEmail,
          password: PASSWORD,
          client_slug: `no-such-tenant-${Date.now()}`,
        });
        const body = (await response.json()) as IamErrorResponse;

        expect(response.status).toBe(401);
        expect(body.error.code).toBe(IamErrorCode.INVALID_CREDENTIALS);
      });

      it('answers 423 ACCOUNT_LOCKED for a locked account (Doc 03 §8)', async () => {
        const response = await login({
          email: fixture.lockedEmail,
          password: PASSWORD,
          client_slug: fixture.clientSlug,
        });
        const body = (await response.json()) as IamErrorResponse;

        expect(response.status).toBe(423);
        expect(body.error.code).toBe(IamErrorCode.ACCOUNT_LOCKED);
      });

      it('does not reveal a locked account to someone without the password', async () => {
        // The status check runs *after* the password check on purpose: told
        // "locked" on a wrong password, an attacker learns the address is real.
        const response = await login({
          email: fixture.lockedEmail,
          password: WRONG_PASSWORD,
          client_slug: fixture.clientSlug,
        });
        const body = (await response.json()) as IamErrorResponse;

        expect(response.status).toBe(401);
        expect(body.error.code).toBe(IamErrorCode.INVALID_CREDENTIALS);
      });

      it('refuses a suspended client`s users (Doc 06 §5)', async () => {
        const response = await login({
          email: fixture.suspendedEmail,
          password: PASSWORD,
          client_slug: fixture.suspendedSlug,
        });
        const body = (await response.json()) as IamErrorResponse;

        expect(response.status).toBe(401);
        expect(body.error.code).toBe(IamErrorCode.INVALID_CREDENTIALS);
      });

      it('rejects a body missing client_slug before touching the database', async () => {
        const response = await login({ email: fixture.activeEmail, password: PASSWORD });
        const body = (await response.json()) as IamErrorResponse;

        expect(response.status).toBe(400);
        expect(body.error.code).toBe(IamErrorCode.VALIDATION_FAILED);
      });
    });

    describe('GET /auth/sessions', () => {
      it('lists the caller`s sessions and flags the current one', async () => {
        const tokens = await loginAs(
          fixture.activeEmail,
          PASSWORD,
          fixture.clientSlug,
          'Gate-3 Terminal',
        );

        const response = await authed(tokens.access_token, '/auth/sessions');
        const sessions = (await response.json()) as SessionDTO[];

        expect(response.status).toBe(200);
        const current = sessions.filter((session) => session.current);
        expect(current).toHaveLength(1);
        expect(current[0].device_label).toBe('Gate-3 Terminal');
        expect(current[0].revoked_at).toBeNull();
        // Nothing replayable in a response whose whole job is to be displayed.
        expect(JSON.stringify(sessions)).not.toContain(tokens.refresh_token);
      });

      it('requires a token', async () => {
        const response = await fetch(`${baseUrl}/auth/sessions`);
        const body = (await response.json()) as IamErrorResponse;

        expect(response.status).toBe(401);
        expect(body.error.code).toBe(IamErrorCode.AUTH_REQUIRED);
      });
    });

    describe('revocation (Doc 03 §6)', () => {
      it('logging out makes the same access token stop working', async () => {
        const tokens = await loginAs();
        expect((await authed(tokens.access_token, '/iam/whoami')).status).toBe(200);

        const logout = await authed(tokens.access_token, '/auth/logout', {
          method: 'POST',
        });
        expect(logout.status).toBe(204);

        // The token is still perfectly *valid* — signature good, not expired.
        // It is refused because its session is dead, which is the entire point
        // of carrying `sid` and checking it on every request.
        const after = await authed(tokens.access_token, '/iam/whoami');
        expect(after.status).toBe(401);
        expect(((await after.json()) as IamErrorResponse).error.code).toBe(
          IamErrorCode.AUTH_REQUIRED,
        );
      });

      it('force-logs-out a named session — the shared-terminal case', async () => {
        const terminal = await loginAs(
          fixture.activeEmail,
          PASSWORD,
          fixture.clientSlug,
          'Gate-3 Terminal',
        );

        const list = (await (
          await authed(terminal.access_token, '/auth/sessions')
        ).json()) as SessionDTO[];
        const target = list.find((session) => session.current);

        const revoke = await authed(
          terminal.access_token,
          `/auth/sessions/${target?.id}/revoke`,
          { method: 'POST' },
        );
        expect(revoke.status).toBe(204);
        expect((await authed(terminal.access_token, '/iam/whoami')).status).toBe(401);
      });

      it('leaves other sessions of the same user alone', async () => {
        const first = await loginAs();
        const second = await loginAs();

        expect(
          (await authed(first.access_token, '/auth/logout', { method: 'POST' })).status,
        ).toBe(204);

        // Revocation is per session, not per subject. A phone logging out must
        // not sign the gate terminal out with it.
        expect((await authed(second.access_token, '/iam/whoami')).status).toBe(200);
      });

      it('answers 404 for a session that is not the caller`s', async () => {
        const tokens = await loginAs();

        const response = await authed(
          tokens.access_token,
          `/auth/sessions/${randomUUID()}/revoke`,
          { method: 'POST' },
        );

        // Not 403: a distinct answer for "exists but not yours" would be a way
        // to discover sessions in other tenants (Doc 06 §2).
        expect(response.status).toBe(404);
        expect(((await response.json()) as IamErrorResponse).error.code).toBe(
          IamErrorCode.NOT_FOUND,
        );
      });
    });

    describe('audit (Doc 03 §9, Doc 10 §4)', () => {
      it('records a successful login against the user who made it', async () => {
        await loginAs();
        const rows = await auditFor(fixture.clientId);

        const success = rows.find((row) => row.action === 'auth.login.success');
        expect(success).toBeDefined();
        // Attribution the caller could not have forged: `write_audit` derived
        // both fields from the context the definer function set (Doc 07 §6).
        expect(success?.actor_type).toBe('user');
        expect(success?.actor_id).toBe(fixture.activeUserId);
      });

      it('records a failed login with a reason code and no password material', async () => {
        await login({
          email: fixture.activeEmail,
          password: WRONG_PASSWORD,
          client_slug: fixture.clientSlug,
        });
        const rows = await auditFor(fixture.clientId);

        const failure = rows.find((row) => row.action === 'auth.login.failed');
        expect(failure?.payload['reason']).toBe('bad_password');
        expect(failure?.payload['email']).toBe(fixture.activeEmail);
        // An unattributable human attempt: recorded as a user with no id,
        // rather than mis-filed under machine identities.
        expect(failure?.actor_type).toBe('user');
        expect(failure?.actor_id).toBeNull();
        expect(JSON.stringify(failure?.payload)).not.toContain(WRONG_PASSWORD);
      });

      it('records the logout', async () => {
        const tokens = await loginAs();
        await authed(tokens.access_token, '/auth/logout', { method: 'POST' });

        const rows = await auditFor(fixture.clientId);
        expect(rows.some((row) => row.action === 'auth.logout')).toBe(true);
      });

      it('never writes a password, hash, or refresh token into a payload', async () => {
        const tokens = await loginAs();
        const serialised = JSON.stringify(await auditFor(fixture.clientId));

        expect(serialised).not.toContain(PASSWORD);
        expect(serialised).not.toContain(tokens.refresh_token);
        expect(serialised).not.toContain('$argon2id$');
      });
    });

    describe('the pre-auth functions leave no context behind', () => {
      it('does not elevate the connection that served a login', async () => {
        // The failure this guards is subtle and total: `auth_lookup_password_
        // identity` sets `app.is_platform_admin` to read across tenants. The
        // setting is transaction-local, so a function that forgot to restore it
        // would hand platform authority to whatever ran next in the same
        // request — and, in a pool, look perfectly normal while doing it.
        const tokens = await loginAs();

        const response = await authed(tokens.access_token, '/iam/whoami');
        const body = (await response.json()) as WhoAmIResponse;

        expect(body.isPlatformAdmin).toBe(false);
      });
    });
  },
);

interface AuditRow {
  action: string;
  actor_type: string;
  actor_id: string | null;
  payload: Record<string, unknown>;
}

/**
 * Builds the two tenants this suite needs.
 *
 * Runs as the migration owner **with a platform context**, because every table
 * it writes carries `force row level security` — which applies to the owner too
 * (Doc 07 §5.1). Without the context each insert would be refused by its own
 * `with check`, exactly as migration 0011 documents.
 */
async function seed(admin: DataSource): Promise<Fixture> {
  const suffix = randomUUID().slice(0, 8);
  const secretHash = await hashSecret(PASSWORD);

  await admin.query(`select set_config('app.is_platform_admin', 'true', false)`);

  const clientId = randomUUID();
  const suspendedClientId = randomUUID();
  const fixture: Fixture = {
    clientId,
    clientSlug: `s8-active-${suffix}`,
    activeEmail: `active-${suffix}@example.test`,
    activeUserId: randomUUID(),
    lockedEmail: `locked-${suffix}@example.test`,
    suspendedClientId,
    suspendedSlug: `s8-suspended-${suffix}`,
    suspendedEmail: `suspended-${suffix}@example.test`,
  };

  // `client`'s policy is `with check (id = app.current_client_id)`, so the
  // context has to name the row before it exists.
  await admin.query(`select set_config('app.current_client_id', $1, false)`, [clientId]);
  await admin.query(
    `insert into ${S}."client" (id, name, slug, status) values ($1, $2, $3, 'active')`,
    [clientId, `Session 8 Active ${suffix}`, fixture.clientSlug],
  );

  const lockedUserId = randomUUID();
  for (const [userId, email, status] of [
    [fixture.activeUserId, fixture.activeEmail, 'active'],
    [lockedUserId, fixture.lockedEmail, 'locked'],
  ] as const) {
    await admin.query(
      `insert into ${S}."user" (id, client_id, email, full_name, status)
       values ($1, $2, $3, $4, $5)`,
      [userId, clientId, email, 'Session 8 Fixture', status],
    );
    await admin.query(
      `insert into ${S}."user_identity" (client_id, user_id, provider, secret_hash)
       values ($1, $2, 'password', $3)`,
      [clientId, userId, secretHash],
    );
  }

  await admin.query(`select set_config('app.current_client_id', $1, false)`, [
    suspendedClientId,
  ]);
  await admin.query(
    `insert into ${S}."client" (id, name, slug, status) values ($1, $2, $3, 'suspended')`,
    [suspendedClientId, `Session 8 Suspended ${suffix}`, fixture.suspendedSlug],
  );
  const suspendedUserId = randomUUID();
  await admin.query(
    `insert into ${S}."user" (id, client_id, email, full_name, status)
     values ($1, $2, $3, 'Session 8 Fixture', 'active')`,
    [suspendedUserId, suspendedClientId, fixture.suspendedEmail],
  );
  await admin.query(
    `insert into ${S}."user_identity" (client_id, user_id, provider, secret_hash)
     values ($1, $2, 'password', $3)`,
    [suspendedClientId, suspendedUserId, secretHash],
  );

  return fixture;
}

/**
 * Removes the fixtures — including their audit rows, which is the one place in
 * the system that deletes audit. It is sound here only because these rows
 * describe tenants that never existed outside this file, and it runs as the
 * owner rather than through any path the application can reach: the app role
 * holds no DELETE on `audit_trail` at all (Doc 07 §6).
 */
async function teardown(admin: DataSource, fixture: Fixture): Promise<void> {
  if (fixture === undefined) return;

  await admin.query(`select set_config('app.is_platform_admin', 'true', false)`);
  for (const clientId of [fixture.clientId, fixture.suspendedClientId]) {
    await admin.query(`select set_config('app.current_client_id', $1, false)`, [clientId]);
    await admin.query(`delete from ${S}."session" where client_id = $1`, [clientId]);
    await admin.query(`delete from ${S}."user_identity" where client_id = $1`, [clientId]);
    await admin.query(`delete from ${S}."user" where client_id = $1`, [clientId]);
    await admin.query(`delete from ${S}."audit_trail" where client_id = $1`, [clientId]);
    await admin.query(`delete from ${S}."client" where id = $1`, [clientId]);
  }
}
