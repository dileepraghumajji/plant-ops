/**
 * Throttling (Doc 06 §2 — 429 `RATE_LIMITED`).
 *
 * Asserted through the socket because the criterion is about the *response*:
 * "throttling returns 429 `RATE_LIMITED` in the standard envelope". A guard
 * that rejects correctly but bypasses the filter would answer with Nest's own
 * `ThrottlerException` body, which no consumer can parse.
 */

import { Controller, Get } from '@nestjs/common';
import { NoPermissionRequired, Public } from '@plantops/auth-kit';
import { IamErrorCode, type IamErrorResponse } from '@plantops/contracts';
import { RateLimit } from './rate-limit.decorator';
import { type Harness, createHarness, testEnv } from '../testing/app-harness';

// A fixture controller for a spec about something else. The pipeline it
// runs through is the real one, so an ungated route still has to say so.
@NoPermissionRequired('test fixture')
@Controller('__throttled')
@Public()
class ThrottledController {
  @Get('default')
  onDefault(): string {
    return 'ok';
  }

  @Get('tight')
  @RateLimit({ limit: 2, windowSeconds: 60 })
  tight(): string {
    return 'ok';
  }

  @Get('tight-closed')
  @RateLimit({ limit: 2, windowSeconds: 60, failOpen: false })
  tightClosed(): string {
    return 'ok';
  }
}

/** Authenticated, to exercise the per-subject bucket the guard order enables. */
// A fixture controller for a spec about something else. The pipeline it
// runs through is the real one, so an ungated route still has to say so.
@NoPermissionRequired('test fixture')
@Controller('__throttled-auth')
class AuthenticatedThrottledController {
  @Get()
  @RateLimit({ limit: 2, windowSeconds: 60 })
  hit(): string {
    return 'ok';
  }
}

const controllers = [ThrottledController, AuthenticatedThrottledController];

describe('rate limiting', () => {
  let harness: Harness;

  beforeAll(async () => {
    harness = await createHarness({ controllers });
  });

  afterAll(async () => {
    await harness.close();
  });

  beforeEach(() => {
    harness.redis.counters.clear();
    harness.redis.failing = false;
  });

  it('rejects the request past the limit with the standard envelope', async () => {
    expect((await harness.get('/__throttled/tight')).status).toBe(200);
    expect((await harness.get('/__throttled/tight')).status).toBe(200);

    const response = await harness.get('/__throttled/tight');
    const body = (await response.json()) as IamErrorResponse;

    expect(response.status).toBe(429);
    expect(body.error.code).toBe(IamErrorCode.RATE_LIMITED);
    expect(body.error.requestId).toEqual(expect.any(String));
  });

  it('tells a well-behaved client when to come back', async () => {
    await harness.get('/__throttled/tight');
    await harness.get('/__throttled/tight');
    const response = await harness.get('/__throttled/tight');

    // Without Retry-After the usual client behaviour is an immediate retry —
    // exactly the traffic the limit is shedding.
    expect(Number(response.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(response.headers.get('x-ratelimit-limit')).toBe('2');
    expect(response.headers.get('x-ratelimit-remaining')).toBe('0');
  });

  it('counts each handler separately, so one busy route cannot starve another', async () => {
    await harness.get('/__throttled/tight');
    await harness.get('/__throttled/tight');
    await harness.get('/__throttled/tight');

    expect((await harness.get('/__throttled/default')).status).toBe(200);
  });

  it('gives each authenticated subject its own budget, not one shared by IP', async () => {
    // This is what putting AuthGuard ahead of the throttle buys (see
    // `app.module.ts`): every request in this test comes from the same address,
    // so an IP-keyed limiter would have exhausted the budget before `other`
    // ever ran. A plant's terminals share a NAT address; they must not share a
    // rate-limit bucket.
    const subject = harness.tokenFor();
    const other = harness.tokenFor();

    for (let i = 0; i < 2; i += 1) {
      const ok = await harness.get('/__throttled-auth', { headers: subject.headers });
      expect(ok.status).toBe(200);
    }
    const throttled = await harness.get('/__throttled-auth', {
      headers: subject.headers,
    });
    expect(throttled.status).toBe(429);

    const unaffected = await harness.get('/__throttled-auth', {
      headers: other.headers,
    });
    expect(unaffected.status).toBe(200);
  });

  it('exempts the probes — a throttled /ready reports the throttle as an outage', async () => {
    for (let i = 0; i < 5; i += 1) {
      expect((await harness.get('/health')).status).toBe(200);
    }
    expect(harness.redis.counters.size).toBe(0);
  });

  it('serves the request when the counter store is unreachable', async () => {
    harness.redis.failing = true;
    // An unavailable *cache* must not take down an API whose blanket limit is
    // about capacity.
    expect((await harness.get('/__throttled/tight')).status).toBe(200);
  });

  it('rejects instead, where the rule asked to fail closed', async () => {
    harness.redis.failing = true;

    const response = await harness.get('/__throttled/tight-closed');
    const body = (await response.json()) as IamErrorResponse;

    // The Session 8 posture for /auth/*: failing open there would hand an
    // attacker unlimited attempts precisely when monitoring is degraded.
    expect(response.status).toBe(429);
    expect(body.error.code).toBe(IamErrorCode.RATE_LIMITED);
  });
});

describe('rate limiting — disabled', () => {
  let harness: Harness;

  beforeAll(async () => {
    harness = await createHarness({
      controllers,
      env: testEnv({ RATE_LIMIT_ENABLED: 'false' }),
    });
  });

  afterAll(async () => {
    await harness.close();
  });

  it('counts nothing at all', async () => {
    for (let i = 0; i < 5; i += 1) {
      expect((await harness.get('/__throttled/tight')).status).toBe(200);
    }
    expect(harness.redis.counters.size).toBe(0);
  });
});
