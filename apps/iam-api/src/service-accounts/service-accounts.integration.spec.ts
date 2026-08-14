/**
 * The Session 11 Definition of Done, end to end: create → exchange → call the
 * API → revoke → the next exchange fails (Doc 03 §5, Doc 06 §10).
 *
 * This needs a real Postgres, and not incidentally. Every claim the session
 * makes is a claim about the database: that only a hash is stored, that RLS
 * confines an administrator to their own tenant's accounts, that a revoked
 * status fails the *next* exchange with no cache in the path, and that the audit
 * row for a refused exchange survives the transaction that 401 rolls back. A
 * fake cannot fail any of those.
 *
 *   docker compose up -d postgres
 *   npm run migration:run
 *   npx nx test @plantops/iam-api
 *
 * **Destructive within its own fixtures only.** It creates one client under a
 * generated slug and removes it afterwards; it touches nothing else.
 *
 * ## Deliberate deviations from the shipped configuration
 *
 * - **Rate limiting is off.** Login fails closed without Redis, and every case
 *   here starts by logging an administrator in.
 * - **Nothing else.** The token TTL, the argon2 parameters and the interim
 *   permission rule are the shipped ones; each is something the suite asserts.
 *
 * ## Redis is not required, and its absence proves something
 *
 * A service token's `sid` is ephemeral and backed by no `session` row, so
 * `SessionService.isRevoked` short-circuits for `sty=service` rather than
 * consulting the revocation cache (Doc 03 §5). Every assertion below about a
 * service token working — and about a revoked account failing at the *exchange*
 * rather than at the guard — therefore holds with no cache at all, which is the
 * claim that a machine identity's revocation is the database's alone.
 */

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { loadEnv } from '@plantops/config';
import {
  IamErrorCode,
  ServiceAccountStatus,
  type AccessTokenResponse,
  type IamErrorResponse,
  type Paginated,
  type ServiceAccountDTO,
  type ServiceAccountSecretDTO,
  type TokenPairResponse,
} from '@plantops/contracts';
import {
  IAM_SCHEMA,
  IAM_SCHEMA_TEST_LOCK_ID,
  SERVICE_ACCOUNT_AUDIT_ACTIONS,
  createMigrationDataSource,
  hashSecret,
} from '@plantops/db';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { DataSource } from 'typeorm';
import { AppModule } from '../app/app.module';
import { ENV } from '../config/config.module';
import { SERVICE_ACCOUNT_KEY_PREFIX } from '../auth/service-credentials.util';

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

interface Fixture {
  clientId: string;
  clientSlug: string;
  /** A user carrying `is_client_admin` — the interim administrator. */
  adminEmail: string;
  adminId: string;
  /** An ordinary user in the same tenant, who must be refused. */
  memberEmail: string;
  memberId: string;
}

interface AccountRow {
  id: string;
  client_id: string;
  key: string;
  key_hash: string;
  status: string;
}

describeWithDb(
  `service accounts & client-credentials exchange (${
    configured ? 'live' : 'skipped: no DATABASE_URL'
  })`,
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
     * One tenant with no accounts, no sessions and no history, before every
     * case — every test here mutates what it shares, and a leftover account
     * would make the suite pass or fail on execution order.
     *
     * The second delete is narrow on purpose: a refused exchange against an
     * *unknown* key belongs to no tenant, so its audit row carries a null
     * `client_id` (Doc 10 §2) and the tenant-scoped delete above cannot reach
     * it. Removing every null-tenant row instead would take the platform's own
     * history with it.
     */
    beforeEach(async () => {
      await elevate(admin, fixture.clientId);
      await admin.query(`delete from ${S}."service_account" where client_id = $1`, [
        fixture.clientId,
      ]);
      await admin.query(`delete from ${S}."session" where client_id = $1`, [
        fixture.clientId,
      ]);
      await admin.query(`delete from ${S}."audit_trail" where client_id = $1`, [
        fixture.clientId,
      ]);
      await admin.query(
        `delete from ${S}."audit_trail" where action = $1 and client_id is null`,
        [SERVICE_ACCOUNT_AUDIT_ACTIONS.TOKEN_FAILED],
      );
    });

    // ── the wire ──────────────────────────────────────────────────────────

    const login = async (email: string): Promise<string> => {
      const response = await fetch(`${baseUrl}/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          email,
          password: PASSWORD,
          client_slug: fixture.clientSlug,
        }),
      });
      expect(response.status).toBe(200);
      return ((await response.json()) as TokenPairResponse).access_token;
    };

    const asAdmin = () => login(fixture.adminEmail);

    const createAccount = (token: string, name = 'Gatepass module') =>
      fetch(`${baseUrl}/iam/service-accounts`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ name }),
      });

    const createdAccount = async (
      token?: string,
      name?: string,
    ): Promise<ServiceAccountSecretDTO> => {
      const response = await createAccount(token ?? (await asAdmin()), name);
      expect(response.status).toBe(201);
      return (await response.json()) as ServiceAccountSecretDTO;
    };

    const listAccounts = (token: string, query = '') =>
      fetch(`${baseUrl}/iam/service-accounts${query}`, {
        headers: { authorization: `Bearer ${token}` },
      });

    const rotate = (token: string, id: string) =>
      fetch(`${baseUrl}/iam/service-accounts/${id}/rotate`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
      });

    const patch = (token: string, id: string, status: string) =>
      fetch(`${baseUrl}/iam/service-accounts/${id}`, {
        method: 'PATCH',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ status }),
      });

    const exchange = (accountKey: string, accountSecret: string) =>
      fetch(`${baseUrl}/auth/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          account_key: accountKey,
          account_secret: accountSecret,
        }),
      });

    const exchanged = async (
      account: ServiceAccountSecretDTO,
    ): Promise<AccessTokenResponse> => {
      const response = await exchange(account.account_key, account.account_secret);
      expect(response.status).toBe(200);
      return (await response.json()) as AccessTokenResponse;
    };

    const whoami = (accessToken: string) =>
      fetch(`${baseUrl}/iam/whoami`, {
        headers: { authorization: `Bearer ${accessToken}` },
      });

    // ── inspection ────────────────────────────────────────────────────────

    const accountRows = async (): Promise<AccountRow[]> => {
      await elevate(admin, fixture.clientId);
      return (await admin.query(
        `select id, client_id, key, key_hash, status
           from ${S}."service_account"
          where client_id = $1
          order by created_at asc`,
        [fixture.clientId],
      )) as AccountRow[];
    };

    const auditActions = async (): Promise<string[]> => {
      await elevate(admin, fixture.clientId);
      const rows = (await admin.query(
        `select action from ${S}."audit_trail"
          where client_id = $1
          order by created_at asc`,
        [fixture.clientId],
      )) as { action: string }[];
      return rows.map((row) => row.action);
    };

    const sessionCount = async (): Promise<number> => {
      await elevate(admin, fixture.clientId);
      const rows = (await admin.query(
        `select count(*)::int as total from ${S}."session" where client_id = $1`,
        [fixture.clientId],
      )) as { total: number }[];
      return rows[0]?.total ?? 0;
    };

    const auditPayloads = async (action: string): Promise<Record<string, unknown>[]> => {
      await elevate(admin, fixture.clientId);
      const rows = (await admin.query(
        `select payload from ${S}."audit_trail"
          where action = $1 and (client_id = $2 or client_id is null)
          order by created_at asc`,
        [action, fixture.clientId],
      )) as { payload: Record<string, unknown> }[];
      return rows.map((row) => row.payload);
    };

    // ── the Definition of Done ────────────────────────────────────────────

    describe('create → exchange → call the API → revoke → next exchange fails', () => {
      it('walks the whole lifecycle', async () => {
        const token = await asAdmin();

        // Create. The secret exists exactly here and nowhere else.
        const account = await createdAccount(token);
        expect(account.account_secret).toBeTruthy();

        // Exchange.
        const issued = await exchanged(account);

        // Call the API with what came back — a real request through the guard,
        // the RLS context and a handler, not merely a signature check.
        const identity = (await (await whoami(issued.access_token)).json()) as {
          subjectId: string;
          subjectType: string;
          clientId: string | null;
          userId: string | null;
        };
        expect(identity.subjectId).toBe(account.id);
        expect(identity.subjectType).toBe('service');
        expect(identity.clientId).toBe(fixture.clientId);
        // Null by design (Doc 07 §6): a service account is not a user, and the
        // audit writer distinguishes the two by exactly this.
        expect(identity.userId).toBeNull();

        // Revoke.
        expect(
          (await patch(token, account.id, ServiceAccountStatus.REVOKED)).status,
        ).toBe(200);

        // The next exchange fails — immediately, and with no cache in the path.
        const refused = await exchange(account.account_key, account.account_secret);
        expect(refused.status).toBe(401);
        expect(((await refused.json()) as IamErrorResponse).error.code).toBe(
          IamErrorCode.INVALID_CREDENTIALS,
        );
      });

      it('leaves the already-issued token working until it expires (Doc 03 §5)', async () => {
        const token = await asAdmin();
        const account = await createdAccount(token);
        const issued = await exchanged(account);

        await patch(token, account.id, ServiceAccountStatus.REVOKED);

        // The deliberate trade, stated plainly: an ephemeral `sid` cannot be
        // killed mid-token, so the ≤5 min TTL is the exposure bound and the
        // *next* exchange is what enforces the revocation. A test asserting the
        // opposite would be asserting a mechanism that does not exist.
        expect((await whoami(issued.access_token)).status).toBe(200);
        expect(issued.expires_in).toBeLessThanOrEqual(300);
      });

      it('audits the created and revoked events (Doc 10 §4)', async () => {
        const token = await asAdmin();
        const account = await createdAccount(token);
        await patch(token, account.id, ServiceAccountStatus.REVOKED);

        const actions = await auditActions();
        expect(actions).toContain(SERVICE_ACCOUNT_AUDIT_ACTIONS.CREATED);
        expect(actions).toContain(SERVICE_ACCOUNT_AUDIT_ACTIONS.REVOKED);
      });

      it('audits the refused exchange with its reason', async () => {
        const token = await asAdmin();
        const account = await createdAccount(token);
        await patch(token, account.id, ServiceAccountStatus.REVOKED);
        await exchange(account.account_key, account.account_secret);

        // The row survives the 401 that rolled the request transaction back —
        // it is written on its own connection precisely so that the events most
        // worth keeping are not the ones discarded (Doc 10 §3).
        expect(
          await auditPayloads(SERVICE_ACCOUNT_AUDIT_ACTIONS.TOKEN_FAILED),
        ).toContainEqual(
          expect.objectContaining({
            reason: 'account_revoked',
            account_key: account.account_key,
          }),
        );
      });
    });

    // ── the secret is shown once (Doc 03 §7, Doc 06 §10) ──────────────────

    describe('the secret', () => {
      it('is returned by create, and stored only as an argon2id hash', async () => {
        const account = await createdAccount();

        const [row] = await accountRows();
        expect(row.key_hash).toMatch(/^\$argon2id\$/);
        expect(row.key_hash).not.toContain(account.account_secret);
        // The key is public and stored as-is; the secret is neither.
        expect(row.key).toBe(account.account_key);
      });

      it('appears in no read — not in the list, not in the PATCH response', async () => {
        const token = await asAdmin();
        const account = await createdAccount(token);

        const list = (await (await listAccounts(token)).json()) as Paginated<
          ServiceAccountDTO & { account_secret?: string; key_hash?: string }
        >;
        const patched = (await (
          await patch(token, account.id, ServiceAccountStatus.REVOKED)
        ).json()) as Record<string, unknown>;

        const listed = list.data[0];
        expect(listed?.account_secret).toBeUndefined();
        expect(listed?.key_hash).toBeUndefined();
        expect(patched['account_secret']).toBeUndefined();
        expect(patched['key_hash']).toBeUndefined();
        // The whole serialised response, in case a future field carries it.
        expect(JSON.stringify(list)).not.toContain(account.account_secret);
      });

      it('never reaches the audit trail (Doc 10 §8)', async () => {
        const token = await asAdmin();
        const account = await createdAccount(token);
        await rotate(token, account.id);

        await elevate(admin, fixture.clientId);
        const rows = (await admin.query(
          `select payload from ${S}."audit_trail" where client_id = $1`,
          [fixture.clientId],
        )) as { payload: unknown }[];
        const serialised = JSON.stringify(rows);

        expect(serialised).not.toContain(account.account_secret);
        expect(serialised).not.toContain('$argon2');
        // The key *is* recorded: it is the public half, and a trail that cannot
        // say which account was created is not one an operator can act on.
        expect(serialised).toContain(account.account_key);
      });

      it('is a different secret every time', async () => {
        const first = await createdAccount(undefined, 'first');
        const second = await createdAccount(undefined, 'second');

        expect(first.account_secret).not.toBe(second.account_secret);
        expect(first.account_key).not.toBe(second.account_key);
        expect(first.account_key.startsWith(SERVICE_ACCOUNT_KEY_PREFIX)).toBe(true);
      });
    });

    // ── the exchange (Doc 03 §5) ──────────────────────────────────────────

    describe('POST /auth/token', () => {
      it('needs no bearer token of its own', async () => {
        const account = await createdAccount();

        // `@Public()`, necessarily: it is the route that produces the token
        // everything else requires.
        const response = await exchange(account.account_key, account.account_secret);

        expect(response.status).toBe(200);
      });

      it('returns no refresh token (Doc 03 §5)', async () => {
        const account = await createdAccount();

        const body = (await (
          await exchange(account.account_key, account.account_secret)
        ).json()) as Record<string, unknown>;

        expect(Object.keys(body).sort()).toEqual(['access_token', 'expires_in']);
      });

      it('refuses a wrong secret and an unknown key identically', async () => {
        const account = await createdAccount();

        const wrongSecret = await exchange(account.account_key, 'not-the-secret');
        const unknownKey = await exchange('sa_nothing-here', account.account_secret);

        expect(wrongSecret.status).toBe(unknownKey.status);
        expect(wrongSecret.status).toBe(401);

        // Everything but the request id, which is per-request by construction:
        // a response that distinguishes "no such account" from "wrong secret"
        // is a directory of which keys are worth attacking.
        const refusal = async (response: Response) => {
          const { error } = (await response.json()) as IamErrorResponse;
          return { code: error.code, message: error.message };
        };
        expect(await refusal(wrongSecret)).toEqual(await refusal(unknownKey));
      });

      it('records the two failures under different reasons', async () => {
        const account = await createdAccount();

        await exchange(account.account_key, 'not-the-secret');
        await exchange('sa_nothing-here', account.account_secret);

        const reasons = (
          await auditPayloads(SERVICE_ACCOUNT_AUDIT_ACTIONS.TOKEN_FAILED)
        ).map((payload) => payload['reason']);
        expect(reasons).toContain('bad_secret');
        expect(reasons).toContain('unknown_account');
      });

      it('writes no session row', async () => {
        const account = await createdAccount();
        const before = await sessionCount();

        await exchanged(account);
        await exchanged(account);

        // Not one row per exchange, and not one row at all: the service token's
        // `sid` is ephemeral and backed by nothing (Doc 03 §5). Machine
        // identities exchange on a timer, so a row apiece would be a table that
        // grows forever and that nobody will ever list or revoke by hand.
        expect(await sessionCount()).toBe(before);
      });

      it('does not elevate the connection that served it', async () => {
        const account = await createdAccount();
        const issued = await exchanged(account);

        const identity = (await (await whoami(issued.access_token)).json()) as {
          isPlatformAdmin: boolean;
        };

        // The lookup sets `app.is_platform_admin` to find a row whose tenant it
        // does not yet know. The setting is transaction-local, so forgetting to
        // restore it would hand platform authority to whatever ran next on the
        // same connection — and look perfectly normal doing it.
        expect(identity.isPlatformAdmin).toBe(false);
      });
    });

    // ── rotation (Doc 06 §10) ─────────────────────────────────────────────

    describe('POST /iam/service-accounts/:id/rotate', () => {
      it('issues a new secret and kills the old one at once', async () => {
        const token = await asAdmin();
        const account = await createdAccount(token);
        await exchanged(account);

        const response = await rotate(token, account.id);
        expect(response.status).toBe(200);
        const rotated = (await response.json()) as ServiceAccountSecretDTO;

        expect(rotated.account_secret).not.toBe(account.account_secret);
        // No grace period, deliberately: the reason to rotate a machine
        // credential is that somebody else may have it.
        expect((await exchange(account.account_key, account.account_secret)).status).toBe(
          401,
        );
        expect((await exchange(rotated.account_key, rotated.account_secret)).status).toBe(
          200,
        );
      });

      it('keeps the account key, so a deployment updates one value', async () => {
        const token = await asAdmin();
        const account = await createdAccount(token);

        const rotated = (await (await rotate(token, account.id)).json()) as
          ServiceAccountSecretDTO;

        expect(rotated.account_key).toBe(account.account_key);
        expect(rotated.id).toBe(account.id);
      });

      it('audits the rotation', async () => {
        const token = await asAdmin();
        const account = await createdAccount(token);
        await rotate(token, account.id);

        expect(await auditActions()).toContain(SERVICE_ACCOUNT_AUDIT_ACTIONS.ROTATED);
      });

      it('answers 404 for an id that is not the caller tenant’s', async () => {
        const token = await asAdmin();

        const response = await rotate(token, randomUUID());

        // The same 404 an account in another tenant gets — RLS makes the row
        // invisible rather than forbidden, so the two are indistinguishable
        // (Doc 06 §2).
        expect(response.status).toBe(404);
      });
    });

    // ── status changes (Doc 06 §10) ───────────────────────────────────────

    describe('PATCH /iam/service-accounts/:id', () => {
      it('reactivates a revoked account, and audits it', async () => {
        const token = await asAdmin();
        const account = await createdAccount(token);
        await patch(token, account.id, ServiceAccountStatus.REVOKED);

        const response = await patch(token, account.id, ServiceAccountStatus.ACTIVE);

        expect(response.status).toBe(200);
        expect(((await response.json()) as ServiceAccountDTO).status).toBe('active');
        expect((await exchange(account.account_key, account.account_secret)).status).toBe(
          200,
        );
        expect(await auditActions()).toContain(
          SERVICE_ACCOUNT_AUDIT_ACTIONS.REACTIVATED,
        );
      });

      it('is idempotent — the same status twice is one event', async () => {
        const token = await asAdmin();
        const account = await createdAccount(token);

        await patch(token, account.id, ServiceAccountStatus.REVOKED);
        const second = await patch(token, account.id, ServiceAccountStatus.REVOKED);

        // Still a 200 with the state the caller asked for, and still one row in
        // the trail: an audit that logs "revoked" three times because a screen
        // was double-clicked is one nobody can read.
        expect(second.status).toBe(200);
        expect(((await second.json()) as ServiceAccountDTO).status).toBe('revoked');
        expect(
          (await auditActions()).filter(
            (action) => action === SERVICE_ACCOUNT_AUDIT_ACTIONS.REVOKED,
          ),
        ).toHaveLength(1);
      });

      it('refuses a status that is not one of the two', async () => {
        const token = await asAdmin();
        const account = await createdAccount(token);

        const response = await patch(token, account.id, 'locked');

        // There is no `locked` for a machine: nobody can be told to contact an
        // administrator and come back.
        expect(response.status).toBe(400);
        expect(((await response.json()) as IamErrorResponse).error.code).toBe(
          IamErrorCode.VALIDATION_FAILED,
        );
      });

      it('answers 404 for an unknown id', async () => {
        expect((await patch(await asAdmin(), randomUUID(), 'revoked')).status).toBe(404);
      });
    });

    // ── the list (Doc 06 §10) ─────────────────────────────────────────────

    describe('GET /iam/service-accounts', () => {
      it('returns the tenant’s accounts in the pagination envelope', async () => {
        const token = await asAdmin();
        await createdAccount(token, 'first');
        await createdAccount(token, 'second');

        const body = (await (await listAccounts(token)).json()) as Paginated<
          ServiceAccountDTO
        >;

        expect(body.total).toBe(2);
        expect(body.data).toHaveLength(2);
        expect(body.data.map((account) => account.name).sort()).toEqual([
          'first',
          'second',
        ]);
        expect(body.data.every((account) => account.client_id === fixture.clientId)).toBe(
          true,
        );
      });

      it('honours page and limit', async () => {
        const token = await asAdmin();
        await createdAccount(token, 'first');
        await createdAccount(token, 'second');

        const page = (await (
          await listAccounts(token, '?page=2&limit=1')
        ).json()) as Paginated<ServiceAccountDTO>;

        expect(page.data).toHaveLength(1);
        expect(page.page).toBe(2);
        expect(page.total).toBe(2);
      });

      it('does not show another tenant’s accounts', async () => {
        const token = await asAdmin();
        await createdAccount(token);

        const body = (await (await listAccounts(token)).json()) as Paginated<
          ServiceAccountDTO
        >;

        // The platform bootstrap account (migration 0011) exists and is
        // platform-level; a client admin must not see it. RLS decides this, not
        // the query.
        expect(body.total).toBe(1);
      });
    });

    // ── the interim permission rule ───────────────────────────────────────

    describe('who may administer service accounts', () => {
      it('refuses an ordinary user in the same tenant with a 403', async () => {
        const member = await login(fixture.memberEmail);

        const response = await createAccount(member);

        // Doc 06 §10 gates this on `iam.client.svc.*`, which needs Session 23's
        // PermissionGuard. Until then the check is `user.is_client_admin` — the
        // shortcut flag Doc 01 §3.6 describes — because the alternative is
        // letting any authenticated user mint a credential with no expiry.
        expect(response.status).toBe(403);
        expect(((await response.json()) as IamErrorResponse).error.code).toBe(
          IamErrorCode.PERMISSION_DENIED,
        );
      });

      it('refuses an unauthenticated caller with a 401', async () => {
        const response = await fetch(`${baseUrl}/iam/service-accounts`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: 'nobody' }),
        });

        expect(response.status).toBe(401);
      });

      it('refuses a service account minting service accounts', async () => {
        const account = await createdAccount();
        const issued = await exchanged(account);

        const response = await createAccount(issued.access_token);

        // One leaked secret must not become a supply of them, and no
        // module-to-module call has a reason to create an identity.
        expect(response.status).toBe(403);
      });

      it('refuses an ordinary user the list as well', async () => {
        const member = await login(fixture.memberEmail);

        expect((await listAccounts(member)).status).toBe(403);
      });

      it('writes nothing when it refuses', async () => {
        const member = await login(fixture.memberEmail);
        await createAccount(member);

        expect(await accountRows()).toHaveLength(0);
        expect(await auditActions()).not.toContain(
          SERVICE_ACCOUNT_AUDIT_ACTIONS.CREATED,
        );
      });
    });
  },
);

/** Platform context on the admin connection, so fixtures can be read and written. */
async function elevate(admin: DataSource, clientId: string): Promise<void> {
  await admin.query(`select set_config('app.is_platform_admin', 'true', false)`);
  await admin.query(`select set_config('app.current_client_id', $1, false)`, [clientId]);
}

/** One tenant, one client admin, one ordinary member. */
async function seed(admin: DataSource, secretHash: string): Promise<Fixture> {
  const suffix = randomUUID().slice(0, 8);

  const fixture: Fixture = {
    clientId: randomUUID(),
    clientSlug: `s11-svc-${suffix}`,
    adminEmail: `admin-${suffix}@example.test`,
    adminId: randomUUID(),
    memberEmail: `member-${suffix}@example.test`,
    memberId: randomUUID(),
  };

  await elevate(admin, fixture.clientId);
  await admin.query(
    `insert into ${S}."client" (id, name, slug, status) values ($1, $2, $3, 'active')`,
    [fixture.clientId, `Session 11 ${suffix}`, fixture.clientSlug],
  );

  for (const [id, email, isClientAdmin] of [
    [fixture.adminId, fixture.adminEmail, true],
    [fixture.memberId, fixture.memberEmail, false],
  ] as const) {
    await admin.query(
      `insert into ${S}."user" (id, client_id, email, full_name, status, is_client_admin)
       values ($1, $2, $3, 'Session 11 Fixture', 'active', $4)`,
      [id, fixture.clientId, email, isClientAdmin],
    );
    await admin.query(
      `insert into ${S}."user_identity" (client_id, user_id, provider, secret_hash)
       values ($1, $2, 'password', $3)`,
      [fixture.clientId, id, secretHash],
    );
  }

  return fixture;
}

async function teardown(admin: DataSource, fixture: Fixture): Promise<void> {
  if (fixture === undefined) return;

  await elevate(admin, fixture.clientId);
  await admin.query(`delete from ${S}."service_account" where client_id = $1`, [
    fixture.clientId,
  ]);
  await admin.query(`delete from ${S}."session" where client_id = $1`, [
    fixture.clientId,
  ]);
  await admin.query(`delete from ${S}."user_identity" where client_id = $1`, [
    fixture.clientId,
  ]);
  await admin.query(`delete from ${S}."user" where client_id = $1`, [fixture.clientId]);
  await admin.query(`delete from ${S}."audit_trail" where client_id = $1`, [
    fixture.clientId,
  ]);
  // The null-tenant rows this suite can produce, and only those — see the
  // `beforeEach` for why the blanket delete would be wrong.
  await admin.query(
    `delete from ${S}."audit_trail" where action = $1 and client_id is null`,
    [SERVICE_ACCOUNT_AUDIT_ACTIONS.TOKEN_FAILED],
  );
  await admin.query(`delete from ${S}."client" where id = $1`, [fixture.clientId]);
}
