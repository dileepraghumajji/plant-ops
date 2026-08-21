/**
 * Single-tenant deployment mode (roadmap Session 44, Doc 11 §6.5, §8 gap 4).
 *
 * A dedicated or self-hosted installation serves one organisation. Its users
 * type an email and a password; the tenant comes from configuration, resolved
 * once at boot.
 *
 * ## What is actually under test
 *
 * Not "the login form has one fewer box" — that is a consequence. The property
 * is that **the browser cannot choose the tenant**, so this suite drives the API
 * directly and asserts the things that make that true:
 *
 *   1. a login with no `client_slug` succeeds, against the pinned tenant;
 *   2. a login naming a *different* tenant is refused rather than quietly
 *      served the pinned one — a caller must not be able to believe they chose;
 *   3. the tenant the session lands in is the pinned one, which is what
 *      `app.current_client_id` and every row-level policy is keyed on;
 *   4. a real user of another tenant cannot reach it here at all.
 *
 * Plus the coherence rule: a deployment pinned to one client refuses to create
 * a second, because a second would be unreachable by every request the process
 * serves.
 *
 * ## Its own instance, and why
 *
 * `DEPLOYMENT_MODE` is boot-time configuration — there is no way to change it
 * on a running process, and that is deliberate: a mode a request could switch
 * would be a mode an attacker could switch. So this file starts a *second* API
 * on its own port, against the same database, and stops it afterwards.
 *
 * The battery's shared instance stays in `saas` mode throughout, which is the
 * other half of this session's safety argument: every other suite runs against
 * it unmodified, and their passing is the evidence that the multi-tenant path
 * did not move.
 */

import { as, expectOk, type Caller } from './support/api';
import { startApi, stopApi } from './support/api-process';
import {
  platformToken,
  purgeTenants,
  seedTwoTenants,
  type FixtureTenant,
  type FixtureUser,
} from './support/two-tenant-fixture';

const PREFIX = 'e2e-single-';

interface TokenPair {
  access_token: string;
  refresh_token: string;
}

interface WhoAmI {
  subjectId: string;
  clientId: string | null;
}

interface ErrorBody {
  error: { code: string };
}

describe('single-tenant deployment mode', () => {
  /** The tenant the second instance is pinned to. */
  let pinnedTenant: FixtureTenant;
  /** A second tenant in the same database — the one that must be unreachable. */
  let otherTenant: FixtureTenant;
  let insider: FixtureUser;
  let outsider: FixtureUser;

  let baseUrl: string;
  let pid: number | undefined;
  /** Unauthenticated, against the pinned instance. */
  let pinned: Caller;

  beforeAll(async () => {
    // Seeded through the battery's own (SaaS) instance. Two tenants, because
    // the interesting assertions are about the one that is *not* pinned.
    const fixture = await seedTwoTenants(PREFIX);
    pinnedTenant = fixture.alpha;
    otherTenant = fixture.beta;
    insider = fixture.alpha.admin;
    outsider = fixture.beta.admin;

    const started = await startApi({
      DEPLOYMENT_MODE: 'single_tenant',
      SINGLE_TENANT_CLIENT_SLUG: pinnedTenant.slug,
    });
    baseUrl = started.runtime.baseUrl;
    pid = started.runtime.pid;
    pinned = as(undefined, baseUrl);
  }, 240_000);

  afterAll(async () => {
    await stopApi(pid);
    await purgeTenants(PREFIX);
  }, 60_000);

  it('boots, and says which deployment it is', async () => {
    const body = expectOk(
      await pinned.get<{
        mode: string;
        client_slug: string | null;
        client_name: string | null;
      }>('/iam/deployment'),
      'deployment description',
    );

    expect(body.mode).toBe('single_tenant');
    expect(body.client_slug).toBe(pinnedTenant.slug);
    expect(body.client_name).toEqual(expect.any(String));
  });

  it('signs a user in with no client_slug at all', async () => {
    const tokens = expectOk(
      await pinned.post<TokenPair>('/auth/login', {
        email: insider.email,
        password: insider.password,
      }),
      'slugless login',
    );

    expect(tokens.access_token).toEqual(expect.any(String));
  });

  it('puts that session in the pinned tenant, not in some default', async () => {
    const tokens = expectOk(
      await pinned.post<TokenPair>('/auth/login', {
        email: insider.email,
        password: insider.password,
      }),
      'slugless login',
    );

    const me = expectOk(
      await as(tokens.access_token, baseUrl).get<WhoAmI>('/iam/whoami'),
      'whoami',
    );

    // The load-bearing one. The tenant a request operates in still comes from
    // verified claims, and those claims name a client the *deployment* chose —
    // nothing about the request selected it.
    expect(me.clientId).toBe(pinnedTenant.clientId);
    expect(me.subjectId).toBe(insider.id);
  });

  it('accepts the pinned slug when a caller sends it', async () => {
    // An integration written against the SaaS shape — `@plantops/iam-client`, a
    // saved script — keeps working. Sending the right answer is not an error.
    const response = await pinned.post<TokenPair>('/auth/login', {
      client_slug: pinnedTenant.slug,
      email: insider.email,
      password: insider.password,
    });

    expect(response.status).toBe(200);
  });

  it('refuses a login that names a different tenant', async () => {
    // Refused rather than quietly served the pinned tenant. Both would sign the
    // same user in; only one of them tells the caller their choice was not
    // honoured — and the whole design rests on that not being ambiguous.
    const response = await pinned.post<ErrorBody>('/auth/login', {
      client_slug: otherTenant.slug,
      email: insider.email,
      password: insider.password,
    });

    expect(response.status).toBe(400);
    expect(response.data.error.code).toBe('VALIDATION_FAILED');
  });

  it('does not let another tenant be reached by naming it', async () => {
    // A *real* user of the other tenant, with their real password, cannot sign
    // in here — named or unnamed. This deployment serves one organisation.
    const named = await pinned.post<ErrorBody>('/auth/login', {
      client_slug: otherTenant.slug,
      email: outsider.email,
      password: outsider.password,
    });
    expect(named.status).toBe(400);

    const slugless = await pinned.post<ErrorBody>('/auth/login', {
      email: outsider.email,
      password: outsider.password,
    });
    // 401, not 400: within the pinned tenant they are simply not a user, and
    // Doc 03 §3 requires "no such user" and "wrong password" to look the same.
    expect(slugless.status).toBe(401);
  });

  it('refuses to create a second client', async () => {
    const caller = as(await platformToken(), baseUrl);

    const response = await caller.post<ErrorBody>('/iam/clients', {
      name: 'A tenant that could never be reached',
      slug: `${PREFIX}impossible-${Date.now()}`,
    });

    expect(response.status).toBe(409);
    expect(response.data.error.code).toBe('CONFLICT');
  });

  it('still creates clients on the multi-tenant instance', async () => {
    // The control, and it is not ceremony: the same call, the same credential
    // and the same database succeed against the SaaS instance. Without it the
    // assertion above would pass just as well against an endpoint that was
    // broken for everybody.
    const caller = as(await platformToken());

    const response = await caller.post<{ id: string }>('/iam/clients', {
      name: 'An ordinary multi-tenant client',
      slug: `${PREFIX}ordinary-${Date.now()}`,
    });

    expect(response.status).toBe(201);
  });
});
