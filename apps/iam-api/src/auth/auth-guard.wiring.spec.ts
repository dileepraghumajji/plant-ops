/**
 * Authentication as the assembled app applies it (Doc 03 §6).
 *
 * `auth.guard.spec.ts` in `auth-kit` proves the guard's logic against fakes.
 * This suite proves something the guard class cannot: that it is *registered*,
 * that it runs before the transaction opens, that exactly the intended routes
 * are public, and that a refusal comes back in the Doc 06 §2 envelope rather
 * than as Nest's own 401 body. Those are properties of the wiring, and only an
 * assembled app has wiring.
 *
 * Deny-by-default is the claim that matters most here, and it is the one a
 * unit test can never make: a route that forgets its guard *works*, which is
 * exactly what a passing test looks like.
 */

import { Controller, Get } from '@nestjs/common';
import { revokedSessionKey } from '@plantops/contracts';
import { IamErrorCode, type IamErrorResponse } from '@plantops/contracts';
import { type Harness, createHarness } from '../testing/app-harness';

/** No `@Public()`, and no decorators at all — the default posture. */
@Controller('__guarded')
class UndecoratedController {
  @Get()
  read(): { ok: true } {
    return { ok: true };
  }
}

const json = (body: unknown) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

describe('AuthGuard wiring', () => {
  let harness: Harness;

  beforeAll(async () => {
    harness = await createHarness({ controllers: [UndecoratedController] });
  });

  afterAll(async () => {
    await harness.close();
  });

  beforeEach(() => {
    harness.redis.keys.clear();
    harness.redis.failing = false;
    harness.database.queries.length = 0;
    harness.database.events.length = 0;
  });

  it('refuses a route that says nothing about authentication', async () => {
    const response = await harness.get('/__guarded');
    const body = (await response.json()) as IamErrorResponse;

    // The whole point of deny-by-default: a new controller is protected before
    // anyone remembers to protect it.
    expect(response.status).toBe(401);
    expect(body.error.code).toBe(IamErrorCode.AUTH_REQUIRED);
    expect(body.error.requestId).toEqual(expect.any(String));
  });

  it('admits the same route with a genuinely signed token', async () => {
    const token = harness.tokenFor();

    const response = await harness.get('/__guarded', { headers: token.headers });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  it('refuses before opening a transaction', async () => {
    await harness.get('/__guarded');

    // Guard ahead of interceptor: an unauthenticated request must not cost a
    // connection from the pool, let alone a BEGIN.
    expect(harness.database.events).not.toContain('begin');
  });

  it('refuses a token whose session has been revoked', async () => {
    const token = harness.tokenFor();
    expect((await harness.get('/__guarded', { headers: token.headers })).status).toBe(
      200,
    );

    // Exactly what `SessionService` publishes after a logout commits. No
    // `REDIS_KEY_PREFIX` here: the real client applies it to both the write and
    // the read, so it cancels out, and the fake does not emulate it.
    harness.redis.keys.set(revokedSessionKey(token.claims.sid), '1');

    const response = await harness.get('/__guarded', { headers: token.headers });
    expect(response.status).toBe(401);
  });

  it('falls back to the database when the revocation cache is unavailable', async () => {
    const token = harness.tokenFor();
    harness.redis.failing = true;

    const response = await harness.get('/__guarded', { headers: token.headers });

    // The fake database answers no rows, which `SessionService.isRevoked`
    // reads as revoked — the correct direction for a question asked when the
    // cache is already known to be broken.
    expect(response.status).toBe(401);
    expect(
      harness.database.queries.some((query) =>
        query.sql.includes('session_is_revoked'),
      ),
    ).toBe(true);
  });

  it.each([
    ['/health', 'an orchestrator holds no credential'],
    ['/ready', 'the same'],
    ['/iam/.well-known/jwks.json', 'a verifier has no token until it has the keys'],
  ])('leaves %s reachable without one — %s', async (path) => {
    const response = await harness.get(path);

    expect(response.status).toBeLessThan(400);
  });

  it('leaves POST /auth/login public, since it is what produces a token', async () => {
    const response = await fetch(`${harness.baseUrl}/auth/login`, json({}));
    const body = (await response.json()) as IamErrorResponse;

    // 400, not 401: the request reached validation, which is only possible if
    // the guard let it past.
    expect(response.status).toBe(400);
    expect(body.error.code).toBe(IamErrorCode.VALIDATION_FAILED);
  });

  it.each([
    ['/auth/sessions', 'GET'],
    ['/iam/whoami', 'GET'],
  ])('keeps %s behind the guard', async (path, method) => {
    const response = await harness.get(path, { method });

    expect(response.status).toBe(401);
    expect(((await response.json()) as IamErrorResponse).error.code).toBe(
      IamErrorCode.AUTH_REQUIRED,
    );
  });
});
