/**
 * End-to-end against the **built and served** app (Session 6 DoD: "app boots
 * against docker-compose services").
 *
 * The in-process suites in `apps/iam-api` cover behaviour with fakes; this one
 * exists to catch what only a real boot can catch — a webpack bundle missing a
 * decorator's metadata, an environment variable the schema requires and the
 * compose file does not supply, a Nest provider that resolves under Jest and
 * not under the bundler. It therefore asserts little and boots everything.
 *
 *   docker compose up -d postgres redis
 *   npm run migration:run
 *   npx nx e2e @plantops/iam-api-e2e
 */

import axios from 'axios';

/** Never throw on a status — these tests assert on 4xx and 5xx too. */
const http = axios.create({ validateStatus: () => true });

describe('iam-api — a served instance', () => {
  it('answers liveness', async () => {
    const response = await http.get('/health');

    expect(response.status).toBe(200);
    expect(response.data).toEqual({
      status: 'ok',
      uptimeSeconds: expect.any(Number),
    });
  });

  it('reports readiness per dependency, and agrees with its own status code', async () => {
    const response = await http.get('/ready');
    const { status, checks } = response.data;

    // Postgres must be up: `main.ts` refuses to boot without it, so a served
    // instance reporting it down would mean the check is not checking.
    expect(checks.postgres).toBe('up');
    expect(checks.redis).toMatch(/^(up|down)$/);

    // The contract an orchestrator relies on: 200 exactly when ready.
    expect(status).toBe(checks.redis === 'up' ? 'ready' : 'not_ready');
    expect(response.status).toBe(status === 'ready' ? 200 : 503);
  });

  it('answers an unknown route in the Doc 06 §2 envelope', async () => {
    const response = await http.get('/no-such-route');

    expect(response.status).toBe(404);
    expect(response.data).toEqual({
      error: {
        code: 'NOT_FOUND',
        message: expect.any(String),
        requestId: expect.any(String),
      },
    });
    expect(response.headers['x-request-id']).toEqual(expect.any(String));
  });

  it('leaves the RLS-probe route authenticated-only until Session 8', async () => {
    const response = await http.get('/iam/whoami');

    expect(response.status).toBe(401);
    expect(response.data.error.code).toBe('AUTH_REQUIRED');
  });
});
