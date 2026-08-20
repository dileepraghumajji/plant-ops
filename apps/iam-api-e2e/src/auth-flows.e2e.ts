/**
 * **The full authentication lifecycle, over the wire** (Doc 03).
 *
 * Doc 08 §7's second demand: login, refresh-race, reuse, lockout, revocation
 * and service tokens, all green in one place. `apps/iam-api` proves each of
 * them in-process against a *fake* Redis; this file proves them against the
 * real one, because three of the six are only interesting when the cache is
 * real:
 *
 * - **Revocation** is a Redis set the guard reads on every request (Doc 03 §6).
 *   The fake answers `exists` from a `Map`; a wrong key prefix, a missing TTL
 *   or a `set` the shipped code never issues all pass there and fail here.
 * - **Reuse detection** turns on a row written by one request and read by the
 *   next, through a pooled connection under PgBouncer semantics.
 * - **Lockout** counts across requests, which is exactly what a per-process
 *   fake cannot get wrong.
 *
 * Every subject that gets damaged — locked, disabled, reset, revoked — is
 * created for the case that damages it. The four fixture users stay usable, so
 * a case failing here cannot cascade into the next.
 *
 * **Rate limiting is off** for this run (see `support/api-process.ts`): the
 * lockout case alone spends five of `/auth/login`'s ten-per-minute budget, and
 * a battery that tripped its own throttle would be testing the throttle. The
 * 429 path has its own coverage in `apps/iam-api/src/common/rate-limit.spec.ts`.
 */

import { IamErrorCode } from '@plantops/contracts';
import { anonymous, as, expectOk, type Caller } from './support/api';
import { logSize, waitForResetToken } from './support/server-log';
import {
  callerFor,
  createUserWithPassword,
  login,
  machineToken,
  seedTwoTenants,
  type FixtureUser,
  type TwoTenants,
} from './support/two-tenant-fixture';

const PREFIX = 'e2e-auth-';

/** What `.env` and `api-process.ts` agree the failed-attempt policy is. */
const MAX_FAILED_ATTEMPTS = Number(
  process.env['LOGIN_MAX_FAILED_ATTEMPTS'] ?? '5',
);

/** The grace window `api-process.ts` pins for this run (Doc 03 §4). */
const GRACE_SECONDS = 10;

interface TokenPair {
  access_token: string;
  refresh_token: string;
  expires_in: number;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('authentication flows, end to end', () => {
  let fixture: TwoTenants;
  let admin: Caller;

  beforeAll(async () => {
    fixture = await seedTwoTenants(PREFIX);
    admin = await callerFor(fixture.alpha, fixture.alpha.admin);
  });

  /** A user nobody else in this file touches. */
  const disposable = (local: string): Promise<FixtureUser> =>
    createUserWithPassword(admin, fixture.alpha.slug, local);

  describe('login (Doc 03 §3)', () => {
    it('issues a usable pair for valid credentials', async () => {
      const pair = await login(fixture.alpha, fixture.alpha.operator);

      expect(pair.access_token).toEqual(expect.any(String));
      expect(pair.refresh_token).toEqual(expect.any(String));
      expect(pair.expires_in).toBeGreaterThan(0);

      const whoami = await as(pair.access_token).get<{ subject_id: string }>(
        '/iam/whoami',
      );
      expect(whoami.status).toBe(200);
    });

    it('answers a wrong password and an unknown address identically', async () => {
      const wrongPassword = await anonymous.post<{
        error: { code: string; message: string };
      }>('/auth/login', {
        email: fixture.alpha.operator.email,
        password: 'not-the-password-at-all',
        client_slug: fixture.alpha.slug,
      });
      const unknownUser = await anonymous.post<{
        error: { code: string; message: string };
      }>('/auth/login', {
        email: `nobody@${fixture.alpha.slug}.test`,
        password: 'not-the-password-at-all',
        client_slug: fixture.alpha.slug,
      });

      expect(wrongPassword.status).toBe(401);
      expect(unknownUser.status).toBe(401);
      expect(wrongPassword.data.error.code).toBe(IamErrorCode.INVALID_CREDENTIALS);
      expect(unknownUser.data.error.message).toBe(
        wrongPassword.data.error.message,
      );
    });

    it('answers an unknown tenant with the same generic 401', async () => {
      const response = await anonymous.post<{ error: { code: string } }>(
        '/auth/login',
        {
          email: fixture.alpha.operator.email,
          password: fixture.alpha.operator.password,
          client_slug: 'no-such-tenant',
        },
      );

      expect(response.status).toBe(401);
      expect(response.data.error.code).toBe(IamErrorCode.INVALID_CREDENTIALS);
    });

    it('refuses the right password in the wrong tenant — the two tenants share none', async () => {
      const response = await anonymous.post('/auth/login', {
        email: fixture.alpha.operator.email,
        password: fixture.alpha.operator.password,
        client_slug: fixture.beta.slug,
      });

      expect(response.status).toBe(401);
    });
  });

  describe('the failed-attempt policy (Doc 03 §8)', () => {
    it('locks after N failures, answers 423, and unlocks on an admin’s say-so', async () => {
      const victim = await disposable('lockout');

      for (let attempt = 0; attempt < MAX_FAILED_ATTEMPTS; attempt += 1) {
        const refused = await anonymous.post('/auth/login', {
          email: victim.email,
          password: 'wrong-every-time',
          client_slug: fixture.alpha.slug,
        });
        expect(refused.status).toBe(401);
      }

      // The right password now, and it is no longer the question being asked.
      const locked = await anonymous.post<{ error: { code: string } }>(
        '/auth/login',
        {
          email: victim.email,
          password: victim.password,
          client_slug: fixture.alpha.slug,
        },
      );
      expect(locked.status).toBe(423);
      expect(locked.data.error.code).toBe(IamErrorCode.ACCOUNT_LOCKED);

      expect(
        (await admin.patch(`/iam/users/${victim.id}`, { status: 'active' })).status,
      ).toBe(200);

      const recovered = await login(fixture.alpha, victim);
      expect(recovered.access_token).toEqual(expect.any(String));
    });

    it('does not reveal a locked account to somebody without the password', async () => {
      const victim = await disposable('locked-probe');
      expect(
        (await admin.patch(`/iam/users/${victim.id}`, { status: 'locked' })).status,
      ).toBe(200);

      const guessing = await anonymous.post<{ error: { code: string } }>(
        '/auth/login',
        {
          email: victim.email,
          password: 'still-guessing',
          client_slug: fixture.alpha.slug,
        },
      );

      // 423 here would turn the lock into an enumeration oracle: the attacker
      // learns the address is real and the account exists (Doc 03 §8).
      expect(guessing.status).toBe(401);
      expect(guessing.data.error.code).toBe(IamErrorCode.INVALID_CREDENTIALS);
    });
  });

  describe('sessions and revocation (Doc 03 §6)', () => {
    it('lists the caller’s sessions and flags the current one', async () => {
      const pair = await login(fixture.alpha, fixture.alpha.approver, 'laptop');
      const caller = as(pair.access_token);

      // `/auth/sessions` answers a bare array, not a pagination envelope: a
      // subject's session list is small and unpaged by design (Doc 06 §3).
      const sessions = expectOk(
        await caller.get<
          { id: string; current: boolean; device_label: string | null }[]
        >('/auth/sessions'),
        'list sessions',
      );

      const current = sessions.filter((session) => session.current);
      expect(current).toHaveLength(1);
      expect(current[0].device_label).toBe('laptop');
    });

    it('stops the access token working the moment its session is revoked', async () => {
      const victim = await disposable('revoke-me');
      const pair = await login(fixture.alpha, victim);
      const caller = as(pair.access_token);

      expect((await caller.get('/iam/whoami')).status).toBe(200);

      const sessions = expectOk(
        await caller.get<{ id: string; current: boolean }[]>('/auth/sessions'),
        'list sessions',
      );
      const current = sessions.find((session) => session.current);
      expect(current).toBeDefined();

      expect(
        (await caller.post(`/auth/sessions/${current?.id}/revoke`)).status,
      ).toBe(204);

      // The token is still cryptographically valid and still unexpired. What
      // changed is the revoked-`sid` entry in Redis, and the guard reads it on
      // every request — which is the whole force-logout guarantee.
      const after = await caller.get<{ error: { code: string } }>('/iam/whoami');
      expect(after.status).toBe(401);
      expect(after.data.error.code).toBe(IamErrorCode.AUTH_REQUIRED);
    });

    it('leaves the same user’s other sessions alone', async () => {
      const user = await disposable('two-devices');
      const phone = await login(fixture.alpha, user, 'phone');
      const desk = await login(fixture.alpha, user, 'desk');

      const sessions = expectOk(
        await as(phone.access_token).get<{ id: string; current: boolean }[]>(
          '/auth/sessions',
        ),
        'list sessions',
      );
      const phoneSession = sessions.find((session) => session.current);

      expect(
        (
          await as(phone.access_token).post(
            `/auth/sessions/${phoneSession?.id}/revoke`,
          )
        ).status,
      ).toBe(204);

      expect((await as(phone.access_token).get('/iam/whoami')).status).toBe(401);
      expect((await as(desk.access_token).get('/iam/whoami')).status).toBe(200);
    });

    it('logging out kills the token that logged out', async () => {
      const user = await disposable('logout');
      const pair = await login(fixture.alpha, user);

      expect(
        (
          await as(pair.access_token).post('/auth/logout', {
            refresh_token: pair.refresh_token,
          })
        ).status,
      ).toBe(204);
      expect((await as(pair.access_token).get('/iam/whoami')).status).toBe(401);
    });

    it('answers 404 for a session that belongs to somebody else', async () => {
      const mine = await login(fixture.alpha, fixture.alpha.operator);
      const theirs = await login(fixture.alpha, fixture.alpha.approver);

      const theirSessions = expectOk(
        await as(theirs.access_token).get<{ id: string; current: boolean }[]>(
          '/auth/sessions',
        ),
        'list sessions',
      );
      const target = theirSessions.find((session) => session.current);

      const attempt = await as(mine.access_token).post(
        `/auth/sessions/${target?.id}/revoke`,
      );
      expect(attempt.status).toBe(404);
    });
  });

  describe('refresh rotation, the race and the replay (Doc 03 §4)', () => {
    it('rotates to a new refresh token and keeps the session', async () => {
      const user = await disposable('rotate');
      const first = await login(fixture.alpha, user);

      const second = expectOk(
        await anonymous.post<TokenPair>('/auth/refresh', {
          refresh_token: first.refresh_token,
        }),
        'refresh',
      );

      expect(second.refresh_token).not.toBe(first.refresh_token);

      // Same `sid`: rotation replaces the credential, not the session, which is
      // what keeps a device's entry in `/auth/sessions` stable across a week.
      const before = await introspect(first.access_token);
      const after = await introspect(second.access_token);
      expect(after.sid).toBe(before.sid);
    });

    it('survives two tabs refreshing at once — the previous token replays idempotently', async () => {
      const user = await disposable('race');
      const first = await login(fixture.alpha, user);

      const second = expectOk(
        await anonymous.post<TokenPair>('/auth/refresh', {
          refresh_token: first.refresh_token,
        }),
        'first refresh',
      );

      // The second tab presents the token it still holds, inside the window.
      const replay = expectOk(
        await anonymous.post<TokenPair>('/auth/refresh', {
          refresh_token: first.refresh_token,
        }),
        'replay inside the grace window',
      );

      expect(replay.refresh_token).toBe(second.refresh_token);
      // And the session is emphatically still alive.
      expect((await as(second.access_token).get('/iam/whoami')).status).toBe(200);
    });

    it('treats a two-generations-old token as compromise and kills the session', async () => {
      const user = await disposable('replay-old');
      const first = await login(fixture.alpha, user);

      const second = expectOk(
        await anonymous.post<TokenPair>('/auth/refresh', {
          refresh_token: first.refresh_token,
        }),
        'first refresh',
      );
      const third = expectOk(
        await anonymous.post<TokenPair>('/auth/refresh', {
          refresh_token: second.refresh_token,
        }),
        'second refresh',
      );

      // `first` is now two generations behind: no grace window covers it, and
      // the only explanation for its presentation is that somebody else has it.
      const replayed = await anonymous.post('/auth/refresh', {
        refresh_token: first.refresh_token,
      });
      expect(replayed.status).toBe(401);

      // The live token dies with the session — that is the point of detecting
      // reuse rather than merely refusing it.
      expect((await as(third.access_token).get('/iam/whoami')).status).toBe(401);
      expect(
        (
          await anonymous.post('/auth/refresh', {
            refresh_token: third.refresh_token,
          })
        ).status,
      ).toBe(401);
    });

    it('treats the previous token as compromise once the grace window has passed', async () => {
      const user = await disposable('replay-late');
      const first = await login(fixture.alpha, user);

      const second = expectOk(
        await anonymous.post<TokenPair>('/auth/refresh', {
          refresh_token: first.refresh_token,
        }),
        'first refresh',
      );

      // The one place in the battery that waits out real time. `api-process.ts`
      // pins the window to the 10 s floor of Doc 03 §4's band so this costs as
      // little as the spec permits.
      await sleep((GRACE_SECONDS + 2) * 1000);

      const late = await anonymous.post('/auth/refresh', {
        refresh_token: first.refresh_token,
      });

      expect(late.status).toBe(401);
      expect((await as(second.access_token).get('/iam/whoami')).status).toBe(401);
    });

    it('refuses a refresh token that was never issued', async () => {
      const response = await anonymous.post('/auth/refresh', {
        refresh_token: 'a'.repeat(64),
      });

      expect(response.status).toBe(401);
    });
  });

  describe('password reset (Doc 03 §7)', () => {
    it('completes the cycle and revokes every session the old password held', async () => {
      const user = await disposable('reset-cycle');
      const before = await login(fixture.alpha, user);
      expect((await as(before.access_token).get('/iam/whoami')).status).toBe(200);

      const mark = logSize();
      expect(
        (
          await anonymous.post('/auth/password/reset-request', {
            email: user.email,
            client_slug: fixture.alpha.slug,
          })
        ).status,
      ).toBe(202);
      const token = await waitForResetToken(mark);

      const next = 'A-Brand-New-Password-9';
      expect(
        (
          await anonymous.post('/auth/password/reset', {
            token,
            new_password: next,
          })
        ).status,
      ).toBe(204);

      // A reset is either "I forgot" or "somebody else has it"; the second case
      // decides the behaviour, so the live sessions go.
      expect((await as(before.access_token).get('/iam/whoami')).status).toBe(401);

      expect(
        (
          await anonymous.post('/auth/login', {
            email: user.email,
            password: user.password,
            client_slug: fixture.alpha.slug,
          })
        ).status,
      ).toBe(401);
      expect(
        (
          await anonymous.post('/auth/login', {
            email: user.email,
            password: next,
            client_slug: fixture.alpha.slug,
          })
        ).status,
      ).toBe(200);
    });

    it('spends the token — a second presentation is refused', async () => {
      const user = await disposable('reset-once');

      const mark = logSize();
      await anonymous.post('/auth/password/reset-request', {
        email: user.email,
        client_slug: fixture.alpha.slug,
      });
      const token = await waitForResetToken(mark);

      expect(
        (
          await anonymous.post('/auth/password/reset', {
            token,
            new_password: 'First-Use-Password-1',
          })
        ).status,
      ).toBe(204);

      const reuse = await anonymous.post('/auth/password/reset', {
        token,
        new_password: 'Second-Use-Password-2',
      });
      expect(reuse.status).toBeGreaterThanOrEqual(400);

      expect(
        (
          await anonymous.post('/auth/login', {
            email: user.email,
            password: 'Second-Use-Password-2',
            client_slug: fixture.alpha.slug,
          })
        ).status,
      ).toBe(401);
    });

    it('answers 202 for an address that does not exist, and issues nothing', async () => {
      const mark = logSize();
      const response = await anonymous.post('/auth/password/reset-request', {
        email: `definitely-nobody@${fixture.alpha.slug}.test`,
        client_slug: fixture.alpha.slug,
      });

      expect(response.status).toBe(202);

      // No token line appeared, so the 202 really is the no-enumeration answer
      // and not a reset that happened to a user who should not exist.
      await expect(waitForResetToken(mark)).rejects.toThrow(/No line matching/);
    }, 30_000);
  });

  describe('account state kills access immediately (Doc 03 §8)', () => {
    it('revokes every session when a user is disabled', async () => {
      const user = await disposable('disable-me');
      const pair = await login(fixture.alpha, user);
      expect((await as(pair.access_token).get('/iam/whoami')).status).toBe(200);

      expect(
        (await admin.patch(`/iam/users/${user.id}`, { status: 'disabled' })).status,
      ).toBe(200);

      expect((await as(pair.access_token).get('/iam/whoami')).status).toBe(401);
      expect(
        (
          await anonymous.post('/auth/login', {
            email: user.email,
            password: user.password,
            client_slug: fixture.alpha.slug,
          })
        ).status,
      ).toBe(401);
    });
  });

  describe('service accounts (Doc 03 §5)', () => {
    it('exchanges credentials for a short-lived token that authenticates', async () => {
      const response = expectOk(
        await anonymous.post<{ access_token: string; expires_in: number }>(
          '/auth/token',
          {
            account_key: fixture.alpha.machine.accountKey,
            account_secret: fixture.alpha.machine.accountSecret,
          },
        ),
        'service token exchange',
      );

      // Doc 03 §5 caps these at five minutes: the `sid` is ephemeral and cannot
      // be revoked, so the TTL *is* the revocation window.
      expect(response.expires_in).toBeLessThanOrEqual(300);

      const claims = await introspect(response.access_token);
      expect(claims.sty).toBe('service');
      expect(claims.sub).toBe(fixture.alpha.machine.id);
    });

    it('refuses a wrong secret', async () => {
      const response = await anonymous.post('/auth/token', {
        account_key: fixture.alpha.machine.accountKey,
        account_secret: 'not-the-secret',
      });

      expect(response.status).toBe(401);
    });

    it('stops issuing once the account is revoked, and rotation changes the secret', async () => {
      const created = expectOk(
        await admin.post<{
          id: string;
          account_key: string;
          account_secret: string;
        }>('/iam/service-accounts', { name: 'Disposable Machine' }),
        'create service account',
      );

      expect(
        await machineToken({
          id: created.id,
          accountKey: created.account_key,
          accountSecret: created.account_secret,
        }),
      ).toEqual(expect.any(String));

      const rotated = expectOk(
        await admin.post<{ account_secret: string }>(
          `/iam/service-accounts/${created.id}/rotate`,
        ),
        'rotate secret',
      );
      expect(rotated.account_secret).not.toBe(created.account_secret);

      expect(
        (
          await anonymous.post('/auth/token', {
            account_key: created.account_key,
            account_secret: created.account_secret,
          })
        ).status,
      ).toBe(401);

      expect(
        (await admin.patch(`/iam/service-accounts/${created.id}`, {
          status: 'revoked',
        })).status,
      ).toBe(200);

      expect(
        (
          await anonymous.post('/auth/token', {
            account_key: created.account_key,
            account_secret: rotated.account_secret,
          })
        ).status,
      ).toBe(401);
    });
  });

  describe('the published keys verify what the API signs (Doc 03 §1)', () => {
    it('serves a JWKS whose `kid` matches the token’s header', async () => {
      const jwks = expectOk(
        await anonymous.get<{ keys: { kid: string; kty: string; alg: string }[] }>(
          '/iam/.well-known/jwks.json',
        ),
        'fetch jwks',
      );

      expect(jwks.keys.length).toBeGreaterThan(0);
      expect(jwks.keys.every((key) => key.alg === 'RS256')).toBe(true);

      const pair = await login(fixture.alpha, fixture.alpha.operator);
      const header = JSON.parse(
        Buffer.from(pair.access_token.split('.')[0], 'base64url').toString('utf8'),
      ) as { kid: string; alg: string };

      expect(header.alg).toBe('RS256');
      expect(jwks.keys.map((key) => key.kid)).toContain(header.kid);
    });
  });

  /** `POST /iam/introspect` is the API's own answer about a token (Doc 06 §11). */
  async function introspect(
    token: string,
  ): Promise<{ active: boolean; sub?: string; sid?: string; sty?: string }> {
    const platformCaller = as(token);
    return expectOk(
      await platformCaller.post<{
        active: boolean;
        sub?: string;
        sid?: string;
        sty?: string;
      }>('/iam/introspect', { token }),
      'introspect',
    );
  }
});
