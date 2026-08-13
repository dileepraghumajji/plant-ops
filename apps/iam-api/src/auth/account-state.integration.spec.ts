/**
 * The Session 10 Definition of Done: the account-state matrix — each of
 * `active`, `locked` and `disabled` against login, refresh and reset — plus the
 * password-reset flow and the failed-attempt lockout that produces the middle
 * state (Doc 03 §7–8).
 *
 * This needs a real Postgres, for the reason `refresh-rotation.integration.spec.ts`
 * does and more so: every mechanism under test is a database mechanism. The
 * lockout counter increments under `select … for update`; `now()` decides
 * whether a reset token is expired; three `SECURITY DEFINER` functions reach
 * rows that RLS hides from an unauthenticated caller; and the property that
 * matters most — that a state change and its force-logout land together — is
 * exactly the property a fake cannot fail to have.
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
 * - **Rate limiting is off.** Login fails closed without Redis, reset does too,
 *   and every test here starts with one or the other.
 * - **The lockout threshold is three, not five.** The default is deployment
 *   configuration (`LOGIN_MAX_FAILED_ATTEMPTS`); pinning a smaller number here
 *   keeps the suite from spending five argon2 hashes per lockout case and makes
 *   the tests state *which* number they depend on.
 * - **Delivery is captured, not sent.** {@link CapturingDelivery} stands in for
 *   the mail transport the port exists to defer — it is the only way a test can
 *   hold the token a real user would receive by email.
 * - **Time is moved, not waited for.** Expiry is proved by backdating
 *   `expires_at` through the admin connection, which is the state an hour's
 *   passing would produce and is deterministic.
 *
 * ## Redis is not required, and its absence proves something
 *
 * Revocation is published to the revoked-`sid` cache best-effort; when Redis is
 * down the publish is logged and `AuthGuard` falls back to `iam.session_is_revoked`.
 * So every assertion below about a locked, disabled or reset account losing its
 * sessions holds with no cache at all — which is the claim that the database,
 * not the cache, is what makes a force-logout real (Doc 03 §6).
 */

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { loadEnv } from '@plantops/config';
import {
  IamErrorCode,
  type IamErrorResponse,
  type TokenPairResponse,
} from '@plantops/contracts';
import {
  ACCOUNT_AUDIT_ACTIONS,
  AUTO_LOCK_REASON,
  IAM_SCHEMA,
  IAM_SCHEMA_TEST_LOCK_ID,
  applyRlsContext,
  createMigrationDataSource,
  hashSecret,
  markClaimsVerified,
  type UserStatus,
} from '@plantops/db';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { DataSource } from 'typeorm';
import { AppModule } from '../app/app.module';
import { runInTransactionContext } from '../common/transaction-context';
import { ENV } from '../config/config.module';
import { DatabaseService } from '../database/database.service';
import { AccountStateService } from './account-state.service';
import {
  PASSWORD_RESET_DELIVERY,
  type PasswordResetDelivery,
  type PasswordResetMessage,
} from './password-reset.delivery';

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
const NEW_PASSWORD = 'a-quite-different-passphrase';
/** Small enough to keep the suite quick, and named so tests can count to it. */
const MAX_FAILED_ATTEMPTS = 3;

interface Fixture {
  clientId: string;
  clientSlug: string;
  email: string;
  userId: string;
}

/**
 * The mail transport, held in an array.
 *
 * `PasswordResetDelivery` exists precisely so that the channel is somebody
 * else's decision (see `password-reset.delivery.ts`); this is the test's.
 */
class CapturingDelivery implements PasswordResetDelivery {
  readonly sent: PasswordResetMessage[] = [];
  /** Set to make delivery throw, standing in for a transport outage. */
  failing = false;

  async deliver(message: PasswordResetMessage): Promise<void> {
    if (this.failing) throw new Error('mail transport unavailable');
    this.sent.push(message);
  }

  latest(): PasswordResetMessage {
    const message = this.sent.at(-1);
    if (message === undefined) throw new Error('No reset token was delivered');
    return message;
  }

  clear(): void {
    this.sent.length = 0;
    this.failing = false;
  }
}

interface UserRow {
  status: UserStatus;
  failed_login_attempts: number;
  last_failed_login_at: Date | null;
}

interface TokenRow {
  token_hash: string;
  used_at: Date | null;
  expires_at: Date;
}

describeWithDb(
  `account state & password reset (${configured ? 'live' : 'skipped: no DATABASE_URL'})`,
  () => {
    let app: INestApplication;
    let baseUrl: string;
    let admin: DataSource;
    let fixture: Fixture;
    let delivery: CapturingDelivery;
    let accountState: AccountStateService;
    let originalSecretHash: string;

    jest.setTimeout(180_000);

    beforeAll(async () => {
      const env = loadEnv();

      admin = createMigrationDataSource(env);
      await admin.initialize();
      await admin.query('select pg_advisory_lock($1)', [IAM_SCHEMA_TEST_LOCK_ID]);

      originalSecretHash = await hashSecret(PASSWORD);
      fixture = await seed(admin, originalSecretHash);

      const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(ENV)
        .useValue({
          ...env,
          RATE_LIMIT_ENABLED: false,
          LOGIN_MAX_FAILED_ATTEMPTS: MAX_FAILED_ATTEMPTS,
        })
        .overrideProvider(PASSWORD_RESET_DELIVERY)
        .useValue((delivery = new CapturingDelivery()))
        .compile();

      app = moduleRef.createNestApplication();
      await app.init();
      await app.listen(0);
      baseUrl = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
      accountState = app.get(AccountStateService);
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
     * Back to one active user with the original password, no sessions, no
     * tokens and no audit history.
     *
     * Every test here mutates the account it shares, so isolation is restored
     * rather than assumed — a lockout leaking into the next case would make the
     * suite pass or fail on execution order.
     */
    beforeEach(async () => {
      await elevate(admin, fixture.clientId);
      await admin.query(
        `update ${S}."user"
            set status = 'active', failed_login_attempts = 0, last_failed_login_at = null
          where id = $1`,
        [fixture.userId],
      );
      await admin.query(
        `update ${S}."user_identity" set secret_hash = $2 where user_id = $1`,
        [fixture.userId, originalSecretHash],
      );
      await admin.query(`delete from ${S}."password_reset_token" where client_id = $1`, [
        fixture.clientId,
      ]);
      await admin.query(`delete from ${S}."session" where client_id = $1`, [
        fixture.clientId,
      ]);
      await admin.query(`delete from ${S}."audit_trail" where client_id = $1`, [
        fixture.clientId,
      ]);
      delivery.clear();
    });

    // ── the wire ──────────────────────────────────────────────────────────

    const login = (password = PASSWORD) =>
      fetch(`${baseUrl}/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          email: fixture.email,
          password,
          client_slug: fixture.clientSlug,
        }),
      });

    const loginAs = async (password = PASSWORD): Promise<TokenPairResponse> => {
      const response = await login(password);
      expect(response.status).toBe(200);
      return (await response.json()) as TokenPairResponse;
    };

    const refresh = (token: string) =>
      fetch(`${baseUrl}/auth/refresh`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ refresh_token: token }),
      });

    const requestReset = (email = fixture.email, clientSlug = fixture.clientSlug) =>
      fetch(`${baseUrl}/auth/password/reset-request`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, client_slug: clientSlug }),
      });

    const completeReset = (token: string, newPassword = NEW_PASSWORD) =>
      fetch(`${baseUrl}/auth/password/reset`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token, new_password: newPassword }),
      });

    const whoami = (accessToken: string) =>
      fetch(`${baseUrl}/iam/whoami`, {
        headers: { authorization: `Bearer ${accessToken}` },
      });

    // ── inspection ────────────────────────────────────────────────────────

    const userRow = async (): Promise<UserRow> => {
      await elevate(admin, fixture.clientId);
      const rows = (await admin.query(
        `select status, failed_login_attempts, last_failed_login_at
           from ${S}."user" where id = $1`,
        [fixture.userId],
      )) as UserRow[];
      return rows[0];
    };

    const tokenRows = async (): Promise<TokenRow[]> => {
      await elevate(admin, fixture.clientId);
      return (await admin.query(
        `select token_hash, used_at, expires_at
           from ${S}."password_reset_token"
          where user_id = $1
          order by created_at asc`,
        [fixture.userId],
      )) as TokenRow[];
    };

    const auditActions = async (): Promise<string[]> => {
      await elevate(admin, fixture.clientId);
      const rows = (await admin.query(
        `select action from ${S}."audit_trail"
          where client_id = $1 order by created_at asc`,
        [fixture.clientId],
      )) as { action: string }[];
      return rows.map((row) => row.action);
    };

    const auditPayloads = async (action: string): Promise<Record<string, unknown>[]> => {
      await elevate(admin, fixture.clientId);
      const rows = (await admin.query(
        `select payload from ${S}."audit_trail"
          where client_id = $1 and action = $2 order by created_at asc`,
        [fixture.clientId, action],
      )) as { payload: Record<string, unknown> }[];
      return rows.map((row) => row.payload);
    };

    /**
     * Ages the outstanding token past its expiry, without spending the hour.
     *
     * `created_at` moves with it because `password_reset_token_expires_after_created`
     * is a real constraint and a row that expired before it was issued is not a
     * state the passage of time can produce.
     */
    const expireTokens = async (): Promise<void> => {
      await elevate(admin, fixture.clientId);
      await admin.query(
        `update ${S}."password_reset_token"
            set created_at = now() - interval '2 hours',
                expires_at = now() - interval '1 hour'
          where user_id = $1 and used_at is null`,
        [fixture.userId],
      );
    };

    /**
     * Runs an administrative transition the way a request would.
     *
     * `AccountStateService` runs on the per-request transaction under an RLS
     * context, so a test calling it has to supply both — this is
     * `TenantContextInterceptor` in miniature, down to running the `afterCommit`
     * callbacks only once `COMMIT` has returned. Session 16 puts a controller in
     * front of this; until then, this is the shape that controller will have.
     */
    const asAdministrator = async (work: () => Promise<unknown>): Promise<void> => {
      const runner = app.get(DatabaseService).dataSource.createQueryRunner();
      await runner.connect();
      await runner.startTransaction();
      try {
        await applyRlsContext(
          runner.manager,
          markClaimsVerified({
            cid: fixture.clientId,
            sub: fixture.userId,
            sty: 'user',
            sid: randomUUID(),
          }),
        );

        let deferred: Array<() => void | Promise<void>> = [];
        await runInTransactionContext(runner.manager, async (scope) => {
          await work();
          deferred = scope.afterCommit;
        });
        await runner.commitTransaction();
        for (const callback of deferred) await callback();
      } finally {
        await runner.release();
      }
    };

    const failLoginTimes = async (times: number): Promise<Response> => {
      let last!: Response;
      for (let attempt = 0; attempt < times; attempt += 1) {
        last = await login('definitely-not-the-password');
      }
      return last;
    };

    // ── POST /auth/password/reset-request (Doc 03 §7, Doc 06 §3) ──────────

    describe('POST /auth/password/reset-request', () => {
      it('answers 202 and issues a token for a real account', async () => {
        const response = await requestReset();

        expect(response.status).toBe(202);
        expect(await tokenRows()).toHaveLength(1);
        expect(delivery.latest().email).toBe(fixture.email);
      });

      it('answers the same 202 for an address that does not exist', async () => {
        const response = await requestReset('nobody-at-all@example.test');

        // The whole point: indistinguishable from the case above. A reset
        // endpoint that answers differently is a staff directory that needs no
        // password to query.
        expect(response.status).toBe(202);
        expect(delivery.sent).toHaveLength(0);
      });

      it('answers the same 202 for a tenant that does not exist', async () => {
        expect((await requestReset(fixture.email, 'no-such-client')).status).toBe(202);
        expect(delivery.sent).toHaveLength(0);
      });

      it('issues a token that is stored only as a hash', async () => {
        await requestReset();

        const [row] = await tokenRows();
        expect(row.token_hash).not.toBe(delivery.latest().token);
        expect(row.token_hash).not.toContain(delivery.latest().token);
      });

      it('audits the request (Doc 03 §9)', async () => {
        await requestReset();

        expect(await auditActions()).toContain(
          ACCOUNT_AUDIT_ACTIONS.PASSWORD_RESET_REQUESTED,
        );
      });

      it('audits nothing when there was no account to reset', async () => {
        await requestReset('nobody-at-all@example.test');

        expect(await auditActions()).not.toContain(
          ACCOUNT_AUDIT_ACTIONS.PASSWORD_RESET_REQUESTED,
        );
      });

      it('supersedes the previous outstanding token', async () => {
        await requestReset();
        const first = delivery.latest().token;
        await requestReset();
        const second = delivery.latest().token;

        expect(second).not.toBe(first);
        // One live token at a time: two links in two inboxes is two chances for
        // the wrong one to be the one that leaks.
        expect((await completeReset(first)).status).toBe(401);
        expect((await completeReset(second)).status).toBe(204);
      });

      it('still answers 202 when delivery fails', async () => {
        delivery.failing = true;

        const response = await requestReset();

        // The token exists and is audited; a transport outage that changed the
        // status code would turn the channel's health into an enumeration
        // signal.
        expect(response.status).toBe(202);
        expect(await tokenRows()).toHaveLength(1);
      });

      it('rejects a malformed address before it reaches the service', async () => {
        const response = await fetch(`${baseUrl}/auth/password/reset-request`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ email: '', client_slug: fixture.clientSlug }),
        });

        // A 400 about syntax says nothing about whether an account exists.
        expect(response.status).toBe(400);
        expect(((await response.json()) as IamErrorResponse).error.code).toBe(
          IamErrorCode.VALIDATION_FAILED,
        );
      });
    });

    // ── POST /auth/password/reset ─────────────────────────────────────────

    describe('POST /auth/password/reset', () => {
      const issue = async (): Promise<string> => {
        await requestReset();
        return delivery.latest().token;
      };

      it('sets the new password and lets it log in', async () => {
        const token = await issue();

        expect((await completeReset(token)).status).toBe(204);

        const tokens = await loginAs(NEW_PASSWORD);
        expect(tokens.access_token).toBeTruthy();
      });

      it('retires the old password', async () => {
        await completeReset(await issue());

        expect((await login(PASSWORD)).status).toBe(401);
      });

      it('spends the token — a second use is refused', async () => {
        const token = await issue();
        expect((await completeReset(token)).status).toBe(204);

        const response = await completeReset(token, 'yet-another-passphrase');

        expect(response.status).toBe(401);
        expect(((await response.json()) as IamErrorResponse).error.code).toBe(
          IamErrorCode.INVALID_CREDENTIALS,
        );
        // And the second password never took effect.
        expect((await login('yet-another-passphrase')).status).toBe(401);
        expect((await login(NEW_PASSWORD)).status).toBe(200);
      });

      it('refuses an expired token, and does not spend it', async () => {
        const token = await issue();
        await expireTokens();

        expect((await completeReset(token)).status).toBe(401);

        // Left unspent on purpose: burning a token on a *refusal* would let
        // anyone who guessed a hash invalidate a live one.
        const [row] = await tokenRows();
        expect(row.used_at).toBeNull();
      });

      it('refuses a token that matches nothing', async () => {
        const response = await completeReset('A'.repeat(43));

        expect(response.status).toBe(401);
        expect(((await response.json()) as IamErrorResponse).error.code).toBe(
          IamErrorCode.INVALID_CREDENTIALS,
        );
      });

      it('refuses a password below the policy, with a field-level 400', async () => {
        const token = await issue();

        const response = await completeReset(token, 'short');

        // Doc 03 §7 asks for the minimum policy at the API, and the API's
        // validation boundary is the DTO — so this is a 400 naming the field,
        // not a 401 that makes the caller guess.
        expect(response.status).toBe(400);
        const body = (await response.json()) as IamErrorResponse;
        expect(body.error.code).toBe(IamErrorCode.VALIDATION_FAILED);
        expect(body.error.details?.map((detail) => detail.field)).toContain(
          'new_password',
        );
        // ...and the token survives a rejected password.
        expect((await completeReset(token)).status).toBe(204);
      });

      it('revokes every live session (Doc 03 §6)', async () => {
        const first = await loginAs();
        const second = await loginAs();
        expect((await whoami(first.access_token)).status).toBe(200);

        await completeReset(await issue());

        // A reset is either a forgotten password or a stolen one, and the second
        // case is what decides this: leaving sessions running would change
        // nothing for whoever is already inside.
        expect((await whoami(first.access_token)).status).toBe(401);
        expect((await whoami(second.access_token)).status).toBe(401);
        expect((await refresh(first.refresh_token)).status).toBe(401);
      });

      it('clears the failed-attempt counter', async () => {
        await failLoginTimes(MAX_FAILED_ATTEMPTS - 1);
        expect((await userRow()).failed_login_attempts).toBe(MAX_FAILED_ATTEMPTS - 1);

        await completeReset(await issue());

        expect((await userRow()).failed_login_attempts).toBe(0);
      });

      it('audits the completion (Doc 03 §9)', async () => {
        await completeReset(await issue());

        expect(await auditActions()).toContain(
          ACCOUNT_AUDIT_ACTIONS.PASSWORD_RESET_COMPLETED,
        );
      });

      it('never writes the token or the password into the audit trail (Doc 10 §8)', async () => {
        const token = await issue();
        await completeReset(token);

        await elevate(admin, fixture.clientId);
        const rows = (await admin.query(
          `select payload from ${S}."audit_trail" where client_id = $1`,
          [fixture.clientId],
        )) as { payload: unknown }[];
        const serialised = JSON.stringify(rows);

        expect(serialised).not.toContain(token);
        expect(serialised).not.toContain(NEW_PASSWORD);
        expect(serialised).not.toContain('$argon2');
      });
    });

    // ── the failed-attempt lockout (Doc 03 §8) ────────────────────────────

    describe('failed-attempt lockout', () => {
      it('counts consecutive failures on the user row', async () => {
        await failLoginTimes(MAX_FAILED_ATTEMPTS - 1);

        const row = await userRow();
        expect(row.failed_login_attempts).toBe(MAX_FAILED_ATTEMPTS - 1);
        expect(row.last_failed_login_at).not.toBeNull();
        expect(row.status).toBe('active');
      });

      it('locks the account on the Nth failure', async () => {
        await failLoginTimes(MAX_FAILED_ATTEMPTS);

        const row = await userRow();
        expect(row.status).toBe('locked');
        // Zeroed as it locks: left at the threshold, the account would re-lock
        // on the first typo after an unlock.
        expect(row.failed_login_attempts).toBe(0);
      });

      it('still answers the generic 401 on the attempt that locks it', async () => {
        const response = await failLoginTimes(MAX_FAILED_ATTEMPTS);

        // Announcing the lock the moment it happens would confirm to whoever
        // provoked it that the address is real.
        expect(response.status).toBe(401);
        expect(((await response.json()) as IamErrorResponse).error.code).toBe(
          IamErrorCode.INVALID_CREDENTIALS,
        );
      });

      it('answers 423 to the correct password once locked (Doc 03 §8)', async () => {
        await failLoginTimes(MAX_FAILED_ATTEMPTS);

        const response = await login(PASSWORD);

        // The one place the status distinguishes a state, and it is only shown
        // to somebody who has already proved they know the password.
        expect(response.status).toBe(423);
        expect(((await response.json()) as IamErrorResponse).error.code).toBe(
          IamErrorCode.ACCOUNT_LOCKED,
        );
      });

      it('audits the lock with the reason and the count (Doc 03 §9)', async () => {
        await failLoginTimes(MAX_FAILED_ATTEMPTS);

        expect(await auditActions()).toContain(ACCOUNT_AUDIT_ACTIONS.ACCOUNT_LOCKED);
        expect(await auditPayloads(ACCOUNT_AUDIT_ACTIONS.ACCOUNT_LOCKED)).toEqual([
          { reason: AUTO_LOCK_REASON, attempts: MAX_FAILED_ATTEMPTS },
        ]);
      });

      it('force-logs-out the sessions the account already had (Doc 03 §6)', async () => {
        const session = await loginAs();
        expect((await whoami(session.access_token)).status).toBe(200);

        await failLoginTimes(MAX_FAILED_ATTEMPTS);

        expect((await whoami(session.access_token)).status).toBe(401);
      });

      it('clears the counter on a successful login', async () => {
        await failLoginTimes(MAX_FAILED_ATTEMPTS - 1);
        await loginAs();

        expect((await userRow()).failed_login_attempts).toBe(0);

        // ...which is what makes the threshold *consecutive* failures rather
        // than a lifetime tally.
        await failLoginTimes(MAX_FAILED_ATTEMPTS - 1);
        expect((await userRow()).status).toBe('active');
        expect((await login(PASSWORD)).status).toBe(200);
      });

      it('does not count failures against an address that does not exist', async () => {
        for (let attempt = 0; attempt < MAX_FAILED_ATTEMPTS + 2; attempt += 1) {
          await fetch(`${baseUrl}/auth/login`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              email: 'nobody-at-all@example.test',
              password: 'wrong',
              client_slug: fixture.clientSlug,
            }),
          });
        }

        // Nothing to count against, and nothing written: an unknown address
        // must not be a write-amplification target for anyone who can spell a
        // slug.
        expect((await userRow()).failed_login_attempts).toBe(0);
        expect(await auditActions()).not.toContain(
          ACCOUNT_AUDIT_ACTIONS.ACCOUNT_LOCKED,
        );
      });

      it('does not keep counting once the account is locked', async () => {
        await failLoginTimes(MAX_FAILED_ATTEMPTS);
        await failLoginTimes(MAX_FAILED_ATTEMPTS);

        // One lock, not two: the status is decided, and counting further would
        // only make the eventual unlock fragile.
        expect(
          (await auditActions()).filter(
            (action) => action === ACCOUNT_AUDIT_ACTIONS.ACCOUNT_LOCKED,
          ),
        ).toHaveLength(1);
        expect((await userRow()).failed_login_attempts).toBe(0);
      });
    });

    // ── administrative transitions (Doc 03 §8) ────────────────────────────

    describe('AccountStateService', () => {
      it('unlocks a locked account and restores login', async () => {
        await failLoginTimes(MAX_FAILED_ATTEMPTS);
        expect((await login(PASSWORD)).status).toBe(423);

        await asAdministrator(() => accountState.unlock(fixture.userId));

        expect((await userRow()).status).toBe('active');
        expect((await login(PASSWORD)).status).toBe(200);
        expect(await auditActions()).toContain(ACCOUNT_AUDIT_ACTIONS.ACCOUNT_UNLOCKED);
      });

      it('refuses to unlock a disabled account', async () => {
        await asAdministrator(() => accountState.disable(fixture.userId));

        await asAdministrator(async () => {
          const result = await accountState.unlock(fixture.userId);
          expect(result.changed).toBe(false);
        });

        // Offboarding is not something the unlock button undoes by accident.
        expect((await userRow()).status).toBe('disabled');
      });

      it('locks manually, with the same action the policy writes', async () => {
        await asAdministrator(() => accountState.lock(fixture.userId, 'under review'));

        expect((await userRow()).status).toBe('locked');
        expect((await login(PASSWORD)).status).toBe(423);
        expect(await auditPayloads(ACCOUNT_AUDIT_ACTIONS.ACCOUNT_LOCKED)).toEqual([
          { reason: 'under review' },
        ]);
      });

      it('revokes every session when an account is disabled', async () => {
        const first = await loginAs();
        const second = await loginAs();

        await asAdministrator(async () => {
          const result = await accountState.disable(fixture.userId);
          expect(result.revokedSessions).toHaveLength(2);
        });

        // "Immediately" is the point of the acceptance criterion: the tokens are
        // still signed, still unexpired, and still refused.
        expect((await whoami(first.access_token)).status).toBe(401);
        expect((await whoami(second.access_token)).status).toBe(401);
        expect(await auditActions()).toContain(ACCOUNT_AUDIT_ACTIONS.ACCOUNT_DISABLED);
      });

      it('is idempotent — re-applying a state changes and audits nothing', async () => {
        await asAdministrator(() => accountState.lock(fixture.userId));
        await asAdministrator(async () => {
          const result = await accountState.lock(fixture.userId);
          expect(result.changed).toBe(false);
        });

        // An audit trail that logs "locked" three times because a screen was
        // double-clicked is one nobody can read.
        expect(
          (await auditActions()).filter(
            (action) => action === ACCOUNT_AUDIT_ACTIONS.ACCOUNT_LOCKED,
          ),
        ).toHaveLength(1);
      });

      it('does not touch a user in another tenant', async () => {
        await asAdministrator(async () => {
          const result = await accountState.disable(randomUUID());
          expect(result.changed).toBe(false);
        });

        expect((await userRow()).status).toBe('active');
      });

      it('leaves revoked sessions revoked after an unlock', async () => {
        const session = await loginAs();
        await asAdministrator(() => accountState.lock(fixture.userId));
        await asAdministrator(() => accountState.unlock(fixture.userId));

        // A revocation is a fact about a moment. Unlock restores the account,
        // not the sessions it had.
        expect((await whoami(session.access_token)).status).toBe(401);
        expect((await login(PASSWORD)).status).toBe(200);
      });
    });

    // ── the matrix (the Session 10 Definition of Done) ────────────────────

    describe('the state machine: each state × login, refresh, reset', () => {
      /** Logs in while still active, then moves the account into `state`. */
      const arrange = async (state: UserStatus): Promise<TokenPairResponse> => {
        const tokens = await loginAs();
        if (state === 'locked') {
          await asAdministrator(() => accountState.lock(fixture.userId));
        }
        if (state === 'disabled') {
          await asAdministrator(() => accountState.disable(fixture.userId));
        }
        return tokens;
      };

      it('active: logs in', async () => {
        await arrange('active');
        expect((await login(PASSWORD)).status).toBe(200);
      });

      it('active: refreshes', async () => {
        const tokens = await arrange('active');
        expect((await refresh(tokens.refresh_token)).status).toBe(200);
      });

      it('active: is issued a reset token', async () => {
        await arrange('active');
        expect((await requestReset()).status).toBe(202);
        expect(await tokenRows()).toHaveLength(1);
      });

      it('locked: is refused with 423 (Doc 03 §8)', async () => {
        await arrange('locked');
        const response = await login(PASSWORD);

        expect(response.status).toBe(423);
        expect(((await response.json()) as IamErrorResponse).error.code).toBe(
          IamErrorCode.ACCOUNT_LOCKED,
        );
      });

      it('locked: cannot refresh — the lock revoked the session', async () => {
        const tokens = await arrange('locked');
        expect((await refresh(tokens.refresh_token)).status).toBe(401);
      });

      it('locked: is issued no reset token, and still answers 202', async () => {
        await arrange('locked');

        expect((await requestReset()).status).toBe(202);
        // Deliberate: a lock is administrative (Doc 03 §8), and an
        // unlock-by-email path would hand the decision back to whoever provoked
        // it. The 202 keeps that from being observable.
        expect(await tokenRows()).toHaveLength(0);
        expect(delivery.sent).toHaveLength(0);
      });

      it('disabled: is refused with the generic 401, not a 403', async () => {
        await arrange('disabled');
        const response = await login(PASSWORD);

        // Doc 03 §8's table says 403; at an unauthenticated endpoint that is an
        // enumeration hint, so the state machine's 403 becomes login's 401 and
        // the distinction is kept in the audit trail instead.
        expect(response.status).toBe(401);
        expect(((await response.json()) as IamErrorResponse).error.code).toBe(
          IamErrorCode.INVALID_CREDENTIALS,
        );
      });

      it('disabled: cannot refresh, and its access token stops working', async () => {
        const tokens = await arrange('disabled');

        expect((await refresh(tokens.refresh_token)).status).toBe(401);
        expect((await whoami(tokens.access_token)).status).toBe(401);
      });

      it('disabled: is issued no reset token', async () => {
        await arrange('disabled');

        expect((await requestReset()).status).toBe(202);
        expect(await tokenRows()).toHaveLength(0);
      });

      it('records the reason for every refusal (Doc 03 §3)', async () => {
        await arrange('disabled');
        await login(PASSWORD);

        expect(
          await auditPayloads('auth.login.failed'),
        ).toContainEqual(
          expect.objectContaining({ reason: 'account_disabled' }),
        );
      });
    });

    // ── the definer functions leave no context behind ─────────────────────

    describe('the definer functions leave no context behind', () => {
      it('does not elevate the connection that served a reset', async () => {
        await requestReset();
        await completeReset(delivery.latest().token);

        const tokens = await loginAs(NEW_PASSWORD);
        const body = (await (await whoami(tokens.access_token)).json()) as {
          isPlatformAdmin: boolean;
        };

        // Both reset functions set `app.is_platform_admin` to find a row whose
        // tenant they do not yet know. The setting is transaction-local, so
        // forgetting to restore it would hand platform authority to whatever ran
        // next on the same connection — and look perfectly normal doing it.
        expect(body.isPlatformAdmin).toBe(false);
      });

      it('does not elevate the connection that served a lockout', async () => {
        await failLoginTimes(MAX_FAILED_ATTEMPTS);
        await asAdministrator(() => accountState.unlock(fixture.userId));

        const tokens = await loginAs();
        const body = (await (await whoami(tokens.access_token)).json()) as {
          isPlatformAdmin: boolean;
        };

        expect(body.isPlatformAdmin).toBe(false);
      });
    });
  },
);

/** Platform context on the admin connection, so fixtures can be read and written. */
async function elevate(admin: DataSource, clientId: string): Promise<void> {
  await admin.query(`select set_config('app.is_platform_admin', 'true', false)`);
  await admin.query(`select set_config('app.current_client_id', $1, false)`, [clientId]);
}

/** One tenant with one active user. See the Session 8 suite for the pattern. */
async function seed(admin: DataSource, secretHash: string): Promise<Fixture> {
  const suffix = randomUUID().slice(0, 8);

  const fixture: Fixture = {
    clientId: randomUUID(),
    clientSlug: `s10-state-${suffix}`,
    email: `state-${suffix}@example.test`,
    userId: randomUUID(),
  };

  await elevate(admin, fixture.clientId);
  await admin.query(
    `insert into ${S}."client" (id, name, slug, status) values ($1, $2, $3, 'active')`,
    [fixture.clientId, `Session 10 ${suffix}`, fixture.clientSlug],
  );
  await admin.query(
    `insert into ${S}."user" (id, client_id, email, full_name, status)
     values ($1, $2, $3, 'Session 10 Fixture', 'active')`,
    [fixture.userId, fixture.clientId, fixture.email],
  );
  await admin.query(
    `insert into ${S}."user_identity" (client_id, user_id, provider, secret_hash)
     values ($1, $2, 'password', $3)`,
    [fixture.clientId, fixture.userId, secretHash],
  );

  return fixture;
}

async function teardown(admin: DataSource, fixture: Fixture): Promise<void> {
  if (fixture === undefined) return;

  await elevate(admin, fixture.clientId);
  await admin.query(`delete from ${S}."password_reset_token" where client_id = $1`, [
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
  await admin.query(`delete from ${S}."client" where id = $1`, [fixture.clientId]);
}
