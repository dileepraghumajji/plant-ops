/**
 * `/health` and `/ready` (Doc 06 §13), over real HTTP.
 *
 * The acceptance criterion is "`/health` 200 always; `/ready` 503 when
 * Postgres or Redis is down", and the *always* is the part worth guarding:
 * liveness answering 200 during a dependency outage is what stops an
 * orchestrator from killing every replica over a database blip.
 */

import { type Harness, createHarness } from '../testing/app-harness';

describe('/health — liveness', () => {
  let harness: Harness;

  beforeAll(async () => {
    harness = await createHarness();
  });

  afterAll(async () => {
    await harness.close();
  });

  it('answers 200 with both dependencies down', async () => {
    harness.database.healthy = false;
    harness.redis.healthy = false;

    const response = await harness.get('/health');

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: 'ok',
      version: expect.any(String),
      uptimeSeconds: expect.any(Number),
    });
  });

  it('does not open a transaction — a liveness probe must not need the database', async () => {
    harness.database.events.length = 0;
    await harness.get('/health');
    expect(harness.database.events).toEqual([]);
  });
});

describe('/ready — readiness', () => {
  let harness: Harness;

  beforeAll(async () => {
    harness = await createHarness();
  });

  afterAll(async () => {
    await harness.close();
  });

  beforeEach(() => {
    harness.database.healthy = true;
    harness.redis.healthy = true;
  });

  it('answers 200 when both dependencies answer', async () => {
    const response = await harness.get('/ready');

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: 'ready',
      checks: { postgres: 'up', redis: 'up' },
    });
  });

  it('answers 503 and names Postgres when Postgres is down', async () => {
    harness.database.healthy = false;

    const response = await harness.get('/ready');

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      status: 'not_ready',
      checks: { postgres: 'down', redis: 'up' },
    });
  });

  it('answers 503 and names Redis when Redis is down', async () => {
    // Redis alone is enough: it holds the revoked-`sid` set (Doc 03 §6), so an
    // instance serving without it honours tokens that have been revoked.
    harness.redis.healthy = false;

    const response = await harness.get('/ready');

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      status: 'not_ready',
      checks: { postgres: 'up', redis: 'down' },
    });
  });

  it('is not cacheable — a cached "ready" outlives the readiness it reported', async () => {
    const response = await harness.get('/ready');
    expect(response.headers.get('cache-control')).toBe('no-store');
  });
});
