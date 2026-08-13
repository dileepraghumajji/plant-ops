/**
 * The claim this session actually has to earn: the RLS context reaches the
 * transaction the handler runs in (Doc 07 §5).
 *
 * Everything else in this app's test suite runs against a fake database, and a
 * fake cannot fail the way this can. The interceptor could parse claims
 * perfectly, call `applyRlsContext` faithfully, and still apply the settings
 * to a different connection than the handler queries, or outside a
 * transaction — where `set_config(..., true)` becomes session-local and gets
 * handed to the *next* tenant to use that pooled connection. From the
 * application's side all three look identical. Only Postgres can tell them
 * apart, so this suite asks Postgres.
 *
 * Needs a migrated database. Skips (loudly, in the suite name) without one:
 *
 *   docker compose up -d postgres
 *   npm run migration:run
 *   npx nx test @plantops/iam-api
 *
 * Read-only — it creates no rows and drops nothing, so it is safe against a
 * database that carries data. It takes the shared advisory lock only to keep
 * `@plantops/db`'s destructive suites from rebuilding the schema underneath it.
 *
 * ## Since Session 8: real tokens, real guard
 *
 * This suite used to install a fixture guard that read claims from headers.
 * That is gone — the app now has a genuine `AuthGuard`, and a test that routes
 * around it would be asserting the RLS behaviour of a pipeline nobody ships.
 * Tokens are signed here by the app's own `TokenService`, with the keys from
 * the real environment, so every request below passes verification for the
 * ordinary reason.
 *
 * The subject is the seeded **service** account, and its `sty` matters twice
 * over: it keeps the suite read-only (a service token's `sid` is ephemeral and
 * needs no `session` row, Doc 03 §5), and it is what the platform-flag
 * derivation is written against.
 */

import { Controller, Get, type INestApplication, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Public } from '@plantops/auth-kit';
import { loadEnv } from '@plantops/config';
import { SubjectType, type IamErrorResponse } from '@plantops/contracts';
import {
  IAM_SCHEMA,
  IAM_SCHEMA_TEST_LOCK_ID,
  PLATFORM_CLIENT_SLUG,
  PLATFORM_SERVICE_ACCOUNT_KEY,
  RLS_SETTINGS,
  createMigrationDataSource,
} from '@plantops/db';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { DataSource } from 'typeorm';
import { AppModule } from '../app/app.module';
import { TokenService } from '../auth/token.service';
import { entityManager } from '../common/transaction-context';
import type { WhoAmIResponse } from './whoami.controller';

const PLACEHOLDER = /REPLACE_ME|[[\]<>]/;
const usable = (url: string | undefined) =>
  url !== undefined &&
  /^postgres(ql)?:\/\/\S+@\S+/.test(url.trim()) &&
  !PLACEHOLDER.test(url);

const configured =
  usable(process.env['DATABASE_URL']) && usable(process.env['DATABASE_DIRECT_URL']);

const describeWithDb = configured ? describe : describe.skip;

/**
 * Reports the RLS context *without* requiring claims — which `/iam/whoami`
 * cannot do, since it 401s first. That is what makes the leak test possible:
 * an unauthenticated request has to be able to look at the settings it should
 * not have inherited.
 */
@Controller('__ctx')
@Public()
class ContextProbeController {
  @Get()
  async read(): Promise<{ clientId: string | null; isPlatformAdmin: string | null }> {
    const [row] = (await entityManager().query(
      `select nullif(current_setting($1, true), '') as client_id,
              nullif(current_setting($2, true), '') as is_platform_admin`,
      [RLS_SETTINGS.CLIENT_ID, RLS_SETTINGS.IS_PLATFORM_ADMIN],
    )) as { client_id: string | null; is_platform_admin: string | null }[];

    return {
      clientId: row?.client_id ?? null,
      isPlatformAdmin: row?.is_platform_admin ?? null,
    };
  }
}

@Module({
  imports: [AppModule],
  controllers: [ContextProbeController],
})
class FixtureRootModule {}

interface PlatformFixture {
  clientId: string;
  serviceAccountId: string;
}

describeWithDb(`RLS context over HTTP (${configured ? 'live' : 'skipped: no DATABASE_URL'})`, () => {
  let app: INestApplication;
  let baseUrl: string;
  let admin: DataSource;
  let platform: PlatformFixture;
  let tokens: TokenService;

  // Migrations, an app boot and a schema read; comfortably past Jest's default.
  jest.setTimeout(60_000);

  beforeAll(async () => {
    const env = loadEnv();

    admin = createMigrationDataSource(env);
    await admin.initialize();
    await admin.query('select pg_advisory_lock($1)', [IAM_SCHEMA_TEST_LOCK_ID]);

    // Even the owner needs a context to read these tables: every one of them
    // carries `force row level security`, which applies to the owner too
    // (Doc 07 §5.1). Without this the fixture read comes back empty and the
    // suite reports a missing seed that is in fact present.
    await admin.query(`select set_config('app.is_platform_admin', 'true', false)`);

    // The bootstrap seed (migration 0011) is the fixture: a platform client and
    // a service account bound at the platform scope root. Using it rather than
    // inserting rows keeps this suite read-only.
    const rows = (await admin.query(
      `select c.id as client_id, sa.id as service_account_id
         from "${IAM_SCHEMA}"."client" c
         join "${IAM_SCHEMA}"."service_account" sa on sa."key" = $2
        where c.slug = $1`,
      [PLATFORM_CLIENT_SLUG, PLATFORM_SERVICE_ACCOUNT_KEY],
    )) as { client_id: string; service_account_id: string }[];

    if (rows.length === 0) {
      throw new Error(
        'The platform bootstrap seed is missing. Run `npm run migration:run` ' +
          'against the database in DATABASE_DIRECT_URL before this suite.',
      );
    }
    platform = {
      clientId: rows[0].client_id,
      serviceAccountId: rows[0].service_account_id,
    };

    const moduleRef = await Test.createTestingModule({
      imports: [FixtureRootModule],
    }).compile();

    // The real DatabaseService and RedisService — the whole point.
    app = moduleRef.createNestApplication();
    await app.init();
    await app.listen(0);
    baseUrl = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
    tokens = app.get(TokenService);
  });

  afterAll(async () => {
    await app?.close();
    if (admin?.isInitialized) {
      await admin.query('select pg_advisory_unlock($1)', [IAM_SCHEMA_TEST_LOCK_ID]);
      await admin.destroy();
    }
  });

  /**
   * A real bearer header for a subject, signed with the deployment's own key.
   *
   * `sid` is a fresh uuid with no `session` row behind it, which is exactly
   * what a service token carries (Doc 03 §5) — so the guard's revocation check
   * finds nothing to revoke and this suite writes no rows.
   */
  const bearer = (
    subjectId: string,
    subjectType: SubjectType = SubjectType.SERVICE,
    clientId: string = platform.clientId,
  ): Record<string, string> => ({
    authorization: `Bearer ${
      tokens.issueAccessToken({
        subjectId,
        subjectType,
        clientId,
        sessionId: randomUUID(),
      }).accessToken
    }`,
  });

  const whoami = (headers: Record<string, string> = {}) =>
    fetch(`${baseUrl}/iam/whoami`, { headers });

  it('rejects an unauthenticated request with AUTH_REQUIRED', async () => {
    const response = await whoami();
    expect(response.status).toBe(401);
    expect(((await response.json()) as IamErrorResponse).error.code).toBe('AUTH_REQUIRED');
  });

  it('rejects a token this deployment did not sign', async () => {
    // The forgery that would matter: a well-formed token from elsewhere. It is
    // refused with the same bare 401 as a missing one — the guard never says
    // which check failed (Doc 06 §2).
    const [header, payload] = tokens
      .issueAccessToken({
        subjectId: platform.serviceAccountId,
        subjectType: SubjectType.SERVICE,
        clientId: platform.clientId,
        sessionId: randomUUID(),
      })
      .accessToken.split('.');

    const response = await whoami({
      authorization: `Bearer ${header}.${payload}.${Buffer.from('forged').toString('base64url')}`,
    });

    expect(response.status).toBe(401);
    expect(((await response.json()) as IamErrorResponse).error.code).toBe('AUTH_REQUIRED');
  });

  it('sets the tenant Postgres sees to the token`s cid, inside the request transaction', async () => {
    const response = await whoami(bearer(platform.serviceAccountId));
    const body = (await response.json()) as WhoAmIResponse;

    expect(response.status).toBe(200);
    // Read back with `current_setting` from inside the handler's transaction:
    // this is the assertion a fake database cannot make.
    expect(body.clientId).toBe(platform.clientId);
  });

  it('leaves app.current_user_id null for a service subject (Doc 07 §6)', async () => {
    const response = await whoami(bearer(platform.serviceAccountId));
    const body = (await response.json()) as WhoAmIResponse;

    // The audit writer distinguishes a human from a machine by this being
    // null; a service account writing its id here would be recorded as a user.
    expect(body.userId).toBeNull();
    expect(body.subjectType).toBe('service');
  });

  it('derives the platform flag from a binding, for the seeded platform identity', async () => {
    const response = await whoami(bearer(platform.serviceAccountId));

    expect(((await response.json()) as WhoAmIResponse).isPlatformAdmin).toBe(true);
  });

  it('never grants the platform flag to a subject that merely claims the platform tenant', async () => {
    // The attack the derivation exists to defeat: a valid token whose `cid`
    // names the platform tenant does not confer platform authority — only a
    // binding at the platform scope root does (Doc 04 §10).
    const response = await whoami(bearer('00000000-0000-4000-8000-000000000000'));

    expect(((await response.json()) as WhoAmIResponse).isPlatformAdmin).toBe(false);
  });

  it('does not leak the context to the next request on the same pool', async () => {
    // The failure this guards is the reason `set_config`'s third argument is
    // `true`: a session-local setting pins the tenant to a pooled connection
    // and hands it to whoever is given that connection next. The pool holds
    // ten connections, so twelve unauthenticated probes after an authenticated
    // request will certainly be handed a used one back.
    //
    // The authenticated half goes through `/iam/whoami` rather than the probe:
    // `/__ctx` is `@Public()`, and a public route is genuinely unauthenticated
    // — the guard skips it and attaches no claims even when a valid token is
    // offered. That is the property being relied on for the second half.
    const authenticated = await whoami(bearer(platform.serviceAccountId));
    expect(((await authenticated.json()) as WhoAmIResponse).clientId).toBe(
      platform.clientId,
    );

    for (let i = 0; i < 12; i += 1) {
      const probe = await fetch(`${baseUrl}/__ctx`);
      expect(await probe.json()).toEqual({ clientId: null, isPlatformAdmin: null });
    }
  });
});
