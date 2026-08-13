/**
 * The Session 9 Definition of Done: rotation that survives the two-tabs race
 * and revokes on real replay (Doc 03 §4).
 *
 * This needs a real Postgres, and no amount of faking substitutes. The whole
 * mechanism *is* a database mechanism: `select … for update` serialising two
 * concurrent refreshes, `now()` deciding which side of the grace window a token
 * fell on, a `SECURITY DEFINER` function reaching rows that RLS otherwise hides
 * from an unauthenticated caller. A fake cannot fail the way any of that can.
 *
 *   docker compose up -d postgres
 *   npm run migration:run
 *   npx nx test @plantops/iam-api
 *
 * **Destructive within its own fixtures only.** It creates one client under a
 * generated slug and removes it afterwards; it touches nothing else.
 *
 * ## Three deliberate deviations from the shipped configuration
 *
 * - **Rate limiting is off**, as in `auth-lifecycle.integration.spec.ts` — login
 *   fails closed without Redis, and every test here starts with a login.
 * - **Time is moved, not waited for.** Proving that a token *outside* the grace
 *   window revokes its session would otherwise cost fifteen seconds per case and
 *   would still be a race against the clock. The tests backdate `rotated_at`
 *   through the admin connection instead, which is the same state the passage of
 *   time would produce and is deterministic — which the Definition of Done
 *   explicitly asks for.
 * - **The replay cache is in-memory**, holding the same `RefreshReplayCache`
 *   over a Map instead of Redis. What this file exists to prove — that two
 *   concurrent refreshes resolve to one rotation and one *recognised* replay —
 *   is a property of `select … for update` and the grace state on the row, and
 *   it must not become unprovable in an environment that happens to have no
 *   Redis. The cache's own behaviour is covered against a fake in
 *   `refresh.service.spec.ts`, and what is left is two lines of provider wiring.
 *
 * That substitution is also a claim in its own right: every assertion below
 * about *refusal* — reuse detection, revocation, the audit trail — passes with a
 * cache that never expires anything, because none of them consult it. The
 * security half of Doc 03 §4 lives in the row.
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
  IAM_SCHEMA,
  IAM_SCHEMA_TEST_LOCK_ID,
  REFRESH_AUDIT_ACTIONS,
  createMigrationDataSource,
  hashSecret,
} from '@plantops/db';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { DataSource } from 'typeorm';
import { AppModule } from '../app/app.module';
import { ENV } from '../config/config.module';
import { RefreshReplayCache, type ReplayStore } from './refresh-replay.cache';
import { REFRESH_REPLAY_CACHE } from './refresh-replay.provider';

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
  email: string;
  userId: string;
}

/**
 * The two commands {@link RefreshReplayCache} needs, without a server.
 *
 * No expiry, deliberately: the grace window is the row's to enforce, and a test
 * store that forgot entries on its own would hide a cache doing the row's job.
 */
class MemoryStore implements ReplayStore {
  private readonly entries = new Map<string, string>();

  /** Stands in for the eviction or restart a real cache can suffer. */
  forget(): void {
    this.entries.clear();
  }

  /** `NX`, which is the property the election depends on — see the cache. */
  async set(key: string, value: string): Promise<'OK' | null> {
    if (this.entries.has(key)) return null;
    this.entries.set(key, value);
    return 'OK';
  }

  async get(key: string): Promise<string | null> {
    return this.entries.get(key) ?? null;
  }
}

interface SessionRow {
  refresh_token_hash: string | null;
  previous_refresh_token_hash: string | null;
  rotated_at: Date | null;
  revoked_at: Date | null;
}

describeWithDb(
  `refresh rotation (${configured ? 'live' : 'skipped: no DATABASE_URL'})`,
  () => {
    let app: INestApplication;
    let baseUrl: string;
    let admin: DataSource;
    let fixture: Fixture;
    let replays: MemoryStore;

    jest.setTimeout(120_000);

    beforeAll(async () => {
      const env = loadEnv();

      admin = createMigrationDataSource(env);
      await admin.initialize();
      await admin.query('select pg_advisory_lock($1)', [IAM_SCHEMA_TEST_LOCK_ID]);

      fixture = await seed(admin);

      const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(ENV)
        .useValue({ ...env, RATE_LIMIT_ENABLED: false })
        .overrideProvider(REFRESH_REPLAY_CACHE)
        .useValue(
          new RefreshReplayCache(
            (replays = new MemoryStore()),
            env.REFRESH_REUSE_GRACE_SECONDS,
          ),
        )
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

    const loginAs = async (): Promise<TokenPairResponse> => {
      const response = await fetch(`${baseUrl}/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          email: fixture.email,
          password: PASSWORD,
          client_slug: fixture.clientSlug,
        }),
      });
      expect(response.status).toBe(200);
      return (await response.json()) as TokenPairResponse;
    };

    const refresh = (token: string) =>
      fetch(`${baseUrl}/auth/refresh`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ refresh_token: token }),
      });

    const rotate = async (token: string): Promise<TokenPairResponse> => {
      const response = await refresh(token);
      expect(response.status).toBe(200);
      return (await response.json()) as TokenPairResponse;
    };

    /** The `session.id` a refresh token addresses. */
    const sessionIdOf = (token: string) => token.split('~')[0];

    const rowFor = async (sessionId: string): Promise<SessionRow> => {
      await admin.query(`select set_config('app.is_platform_admin', 'true', false)`);
      const rows = (await admin.query(
        `select refresh_token_hash, previous_refresh_token_hash, rotated_at, revoked_at
           from ${S}."session" where id = $1`,
        [sessionId],
      )) as SessionRow[];
      return rows[0];
    };

    /** Ages the grace window past its end, without spending the time. */
    const expireGrace = async (sessionId: string): Promise<void> => {
      await admin.query(`select set_config('app.is_platform_admin', 'true', false)`);
      await admin.query(`select set_config('app.current_client_id', $1, false)`, [
        fixture.clientId,
      ]);
      await admin.query(
        `update ${S}."session" set rotated_at = now() - interval '1 hour' where id = $1`,
        [sessionId],
      );
    };

    const auditFor = async (sessionId: string): Promise<string[]> => {
      await admin.query(`select set_config('app.is_platform_admin', 'true', false)`);
      const rows = (await admin.query(
        `select action from ${S}."audit_trail"
          where target_id = $1 order by created_at desc`,
        [sessionId],
      )) as { action: string }[];
      return rows.map((row) => row.action);
    };

    const whoami = (accessToken: string) =>
      fetch(`${baseUrl}/iam/whoami`, {
        headers: { authorization: `Bearer ${accessToken}` },
      });

    describe('POST /auth/refresh', () => {
      it('rotates the token and keeps the session (Doc 03 §4 step 3)', async () => {
        const login = await loginAs();
        const sessionId = sessionIdOf(login.refresh_token);

        const rotated = await rotate(login.refresh_token);

        expect(rotated.refresh_token).not.toBe(login.refresh_token);
        // The `sid` is the session's identity and rotation does not touch it —
        // otherwise every refresh would orphan a row and break the session list.
        expect(sessionIdOf(rotated.refresh_token)).toBe(sessionId);
        expect(rotated.expires_in).toBeGreaterThan(0);
      });

      it('updates the stored hash and remembers the one it replaced', async () => {
        const login = await loginAs();
        const sessionId = sessionIdOf(login.refresh_token);

        await rotate(login.refresh_token);
        const row = await rowFor(sessionId);

        expect(row.previous_refresh_token_hash).not.toBeNull();
        expect(row.rotated_at).not.toBeNull();
        expect(row.refresh_token_hash).not.toBe(row.previous_refresh_token_hash);
      });

      it('produces an access token that authenticates a real request', async () => {
        const login = await loginAs();

        const rotated = await rotate(login.refresh_token);

        expect((await whoami(rotated.access_token)).status).toBe(200);
      });

      it('lets a client rotate repeatedly', async () => {
        const login = await loginAs();

        let current = login.refresh_token;
        for (let generation = 0; generation < 4; generation += 1) {
          current = (await rotate(current)).refresh_token;
        }

        expect((await refresh(current)).status).toBe(200);
      });

      it('audits the rotation (Doc 10 §4)', async () => {
        const login = await loginAs();
        const sessionId = sessionIdOf(login.refresh_token);

        await rotate(login.refresh_token);

        expect(await auditFor(sessionId)).toContain(REFRESH_AUDIT_ACTIONS.ROTATED);
      });

      it('never returns the stored hash, in either direction', async () => {
        const login = await loginAs();
        const sessionId = sessionIdOf(login.refresh_token);

        const rotated = await rotate(login.refresh_token);
        const row = await rowFor(sessionId);

        expect(JSON.stringify(rotated)).not.toContain(row.refresh_token_hash);
      });
    });

    describe('the concurrent-refresh race (Doc 03 §4)', () => {
      it('serves two simultaneous refreshes of the same token', async () => {
        const login = await loginAs();

        // Genuinely concurrent, which is the case that used to kill sessions:
        // the row lock in `auth_rotate_refresh_token` is what makes one of these
        // the rotation and the other a recognised replay.
        const [first, second] = await Promise.all([
          rotate(login.refresh_token),
          rotate(login.refresh_token),
        ]);

        // Both converge on one token. Two different valid tokens would leave the
        // loser one generation behind and cost it its session at the *next*
        // refresh — fifteen minutes away from anything that could explain it.
        expect(second.refresh_token).toBe(first.refresh_token);
      });

      it('leaves the session alive and usable afterwards', async () => {
        const login = await loginAs();
        const sessionId = sessionIdOf(login.refresh_token);

        const [first] = await Promise.all([
          rotate(login.refresh_token),
          rotate(login.refresh_token),
        ]);

        expect((await rowFor(sessionId)).revoked_at).toBeNull();
        expect((await whoami(first.access_token)).status).toBe(200);
        expect((await refresh(first.refresh_token)).status).toBe(200);
      });

      it('records one rotation, not two', async () => {
        const login = await loginAs();
        const sessionId = sessionIdOf(login.refresh_token);

        await Promise.all([rotate(login.refresh_token), rotate(login.refresh_token)]);

        const rotations = (await auditFor(sessionId)).filter(
          (action) => action === REFRESH_AUDIT_ACTIONS.ROTATED,
        );
        expect(rotations).toHaveLength(1);
      });

      it('does not audit the replay as a compromise', async () => {
        const login = await loginAs();
        const sessionId = sessionIdOf(login.refresh_token);

        await Promise.all([rotate(login.refresh_token), rotate(login.refresh_token)]);

        expect(await auditFor(sessionId)).not.toContain(
          REFRESH_AUDIT_ACTIONS.REUSE_DETECTED,
        );
      });

      it('holds up under more contenders than there are winners', async () => {
        const login = await loginAs();
        const sessionId = sessionIdOf(login.refresh_token);

        // Eight at once, to make the row lock actually contend rather than
        // relying on two requests happening to overlap. Exactly one of these can
        // rotate; the other seven have to be recognised, not revoked.
        const responses = await Promise.all(
          Array.from({ length: 8 }, () => rotate(login.refresh_token)),
        );

        expect(new Set(responses.map((response) => response.refresh_token)).size).toBe(1);
        expect((await rowFor(sessionId)).revoked_at).toBeNull();
        expect(
          (await auditFor(sessionId)).filter(
            (action) => action === REFRESH_AUDIT_ACTIONS.ROTATED,
          ),
        ).toHaveLength(1);
      });

      it('refuses, without revoking, when the election is lost (Doc 03 §4)', async () => {
        const login = await loginAs();
        const sessionId = sessionIdOf(login.refresh_token);
        const rotated = await rotate(login.refresh_token);

        // An eviction, a restart, an outage — whatever the cause, the retrying
        // client now proposes a successor nobody agreed on, and the row is the
        // only thing in a position to notice that it is not what got installed.
        replays.forget();
        const response = await refresh(login.refresh_token);

        expect(response.status).toBe(401);
        // The session is *fine*. Refusing costs one person a fresh login;
        // revoking here would turn a cache blip into a fleet-wide logout.
        expect((await rowFor(sessionId)).revoked_at).toBeNull();
        expect(await auditFor(sessionId)).not.toContain(
          REFRESH_AUDIT_ACTIONS.REUSE_DETECTED,
        );
        expect((await refresh(rotated.refresh_token)).status).toBe(200);
      });

      it('replays idempotently for a sequential retry, too', async () => {
        // The same shape as the race, and the more common cause of it: a client
        // whose response was lost to a timeout, retrying the only token it has.
        const login = await loginAs();

        const first = await rotate(login.refresh_token);
        const retry = await rotate(login.refresh_token);

        expect(retry.refresh_token).toBe(first.refresh_token);
      });
    });

    describe('reuse detection (Doc 03 §4)', () => {
      it('revokes the session when the previous token returns after the window', async () => {
        const login = await loginAs();
        const sessionId = sessionIdOf(login.refresh_token);
        const rotated = await rotate(login.refresh_token);

        await expireGrace(sessionId);
        const response = await refresh(login.refresh_token);

        expect(response.status).toBe(401);
        expect(((await response.json()) as IamErrorResponse).error.code).toBe(
          IamErrorCode.INVALID_CREDENTIALS,
        );
        expect((await rowFor(sessionId)).revoked_at).not.toBeNull();
        expect(await auditFor(sessionId)).toContain(
          REFRESH_AUDIT_ACTIONS.REUSE_DETECTED,
        );
        // The compromise kills the session, not merely the presented token: the
        // successor the thief did not get is dead too.
        expect((await refresh(rotated.refresh_token)).status).toBe(401);
      });

      it('revokes on a token two generations old, even inside the window', async () => {
        const login = await loginAs();
        const sessionId = sessionIdOf(login.refresh_token);

        const second = await rotate(login.refresh_token);
        await rotate(second.refresh_token);

        // Nothing stores a two-generations-old hash, so this is only findable
        // because the session id travels in the token. Found, it matches neither
        // generation, and that is compromise however recent the last rotation.
        const response = await refresh(login.refresh_token);

        expect(response.status).toBe(401);
        expect((await rowFor(sessionId)).revoked_at).not.toBeNull();
        expect(await auditFor(sessionId)).toContain(
          REFRESH_AUDIT_ACTIONS.REUSE_DETECTED,
        );
      });

      it('revokes on a secret that never belonged to the session', async () => {
        const login = await loginAs();
        const sessionId = sessionIdOf(login.refresh_token);

        const forged = `${sessionId}~${'A'.repeat(43)}`;
        expect((await refresh(forged)).status).toBe(401);

        // Indistinguishable from an older generation, and treated the same:
        // somebody is presenting something they should not have.
        expect((await rowFor(sessionId)).revoked_at).not.toBeNull();
      });

      it('stops the access token that was minted alongside it', async () => {
        const login = await loginAs();
        const sessionId = sessionIdOf(login.refresh_token);
        const rotated = await rotate(login.refresh_token);
        expect((await whoami(rotated.access_token)).status).toBe(200);

        await expireGrace(sessionId);
        await refresh(login.refresh_token);

        // Revocation reaches the still-valid access token through `sid`, which
        // is the whole reason Doc 03 §6's cache exists.
        expect((await whoami(rotated.access_token)).status).toBe(401);
      });
    });

    describe('refusals', () => {
      it('refuses a revoked session without auditing it as compromise', async () => {
        const login = await loginAs();
        const sessionId = sessionIdOf(login.refresh_token);

        await fetch(`${baseUrl}/auth/logout`, {
          method: 'POST',
          headers: { authorization: `Bearer ${login.access_token}` },
        });

        expect((await refresh(login.refresh_token)).status).toBe(401);
        // Logging out and being caught replaying are different events, and an
        // audit trail that conflates them is unusable for the thing it exists
        // for.
        expect(await auditFor(sessionId)).not.toContain(
          REFRESH_AUDIT_ACTIONS.REUSE_DETECTED,
        );
      });

      it('refuses a session id that does not exist', async () => {
        const response = await refresh(`${randomUUID()}~${'A'.repeat(43)}`);

        expect(response.status).toBe(401);
        expect(((await response.json()) as IamErrorResponse).error.code).toBe(
          IamErrorCode.INVALID_CREDENTIALS,
        );
      });

      it('refuses a malformed token with the same 401 as a wrong one', async () => {
        const response = await refresh('not-a-refresh-token');

        // The shape check is in the service, not the DTO, precisely so that this
        // is a 401: a 400 here would be a way to probe which tokens are worth
        // presenting at all.
        expect(response.status).toBe(401);
        expect(((await response.json()) as IamErrorResponse).error.code).toBe(
          IamErrorCode.INVALID_CREDENTIALS,
        );
      });

      it('rejects an empty body field before it reaches the service', async () => {
        const response = await refresh('');

        expect(response.status).toBe(400);
        expect(((await response.json()) as IamErrorResponse).error.code).toBe(
          IamErrorCode.VALIDATION_FAILED,
        );
      });

      it('never writes a refresh token into the audit trail (Doc 10 §8)', async () => {
        const login = await loginAs();
        const sessionId = sessionIdOf(login.refresh_token);
        const rotated = await rotate(login.refresh_token);

        await admin.query(`select set_config('app.is_platform_admin', 'true', false)`);
        const rows = (await admin.query(
          `select payload from ${S}."audit_trail" where target_id = $1`,
          [sessionId],
        )) as { payload: unknown }[];
        const serialised = JSON.stringify(rows);

        expect(serialised).not.toContain(login.refresh_token.split('~')[1]);
        expect(serialised).not.toContain(rotated.refresh_token.split('~')[1]);
      });
    });

    describe('the definer function leaves no context behind', () => {
      it('does not elevate the connection that served a refresh', async () => {
        const login = await loginAs();

        const rotated = await rotate(login.refresh_token);
        const body = (await (await whoami(rotated.access_token)).json()) as {
          isPlatformAdmin: boolean;
        };

        // `auth_rotate_refresh_token` sets `app.is_platform_admin` to find a row
        // whose tenant it does not yet know. The setting is transaction-local,
        // so forgetting to restore it would hand platform authority to whatever
        // ran next in the same request — and look perfectly normal doing it.
        expect(body.isPlatformAdmin).toBe(false);
      });
    });
  },
);

/** One tenant with one active user. See the Session 8 suite for the pattern. */
async function seed(admin: DataSource): Promise<Fixture> {
  const suffix = randomUUID().slice(0, 8);
  const secretHash = await hashSecret(PASSWORD);

  await admin.query(`select set_config('app.is_platform_admin', 'true', false)`);

  const fixture: Fixture = {
    clientId: randomUUID(),
    clientSlug: `s9-refresh-${suffix}`,
    email: `refresh-${suffix}@example.test`,
    userId: randomUUID(),
  };

  await admin.query(`select set_config('app.current_client_id', $1, false)`, [
    fixture.clientId,
  ]);
  await admin.query(
    `insert into ${S}."client" (id, name, slug, status) values ($1, $2, $3, 'active')`,
    [fixture.clientId, `Session 9 ${suffix}`, fixture.clientSlug],
  );
  await admin.query(
    `insert into ${S}."user" (id, client_id, email, full_name, status)
     values ($1, $2, $3, 'Session 9 Fixture', 'active')`,
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

  await admin.query(`select set_config('app.is_platform_admin', 'true', false)`);
  await admin.query(`select set_config('app.current_client_id', $1, false)`, [
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
