/**
 * Boots the **real** `AppModule` over a real HTTP socket, with the two
 * external dependencies swapped for in-memory fakes.
 *
 * Real module, real middleware, real guard, real interceptor, real filter —
 * because the properties under test are properties of the *pipeline*. A test
 * that calls `filter.catch()` directly proves the filter formats an envelope;
 * it does not prove the filter is registered, that the guard runs before the
 * transaction opens, or that a 404 from the router (which no handler ever
 * sees) comes back in the envelope too. Those are the regressions worth
 * catching, and only an assembled app can catch them.
 *
 * The fakes are behavioural, not stubs: the Redis fake counts, so the throttle
 * genuinely throttles. What they cannot prove is anything about the database
 * *enforcing* something — that is `rls-context.integration.spec.ts`, which
 * uses a real Postgres.
 *
 * Test-only, and excluded from `tsconfig.app.json` — nothing here ships.
 */

import { type INestApplication, Module, type Type } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test, type TestingModule } from '@nestjs/testing';
import { type EnvConfig, parseEnv } from '@plantops/config';
import { SubjectType } from '@plantops/contracts';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { AppModule } from '../app/app.module';
import { NEST_APP_OPTIONS, hardenExpress } from '../app/http-hardening';
import { TokenService } from '../auth/token.service';
import { ENV } from '../config/env.token';
import { DatabaseService } from '../database/database.service';
import { RedisService } from '../redis/redis.service';

/**
 * A real keypair, generated once for the process.
 *
 * It used to be two PEM-shaped strings, which was enough while nothing verified
 * anything. Since Session 8 the global `AuthGuard` verifies a signature on
 * every non-`@Public()` route, so a token has to be genuinely signable — and a
 * fake key would make every authenticated test pass or fail for the wrong
 * reason. 2048-bit generation costs ~100 ms once per suite.
 */
const TEST_KEYPAIR = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

const PRIVATE_KEY = TEST_KEYPAIR.privateKey;
const PUBLIC_KEY = TEST_KEYPAIR.publicKey;

/**
 * A valid environment that owes nothing to the developer's `.env`. Tests that
 * care about a setting override it explicitly, which also documents which
 * setting the test is about.
 */
export function testEnv(overrides: Partial<Record<string, string>> = {}): EnvConfig {
  return parseEnv({
    NODE_ENV: 'test',
    DATABASE_URL: 'postgresql://app:pw@localhost:6543/plantops_iam',
    DATABASE_DIRECT_URL: 'postgresql://owner:pw@localhost:5432/plantops_iam',
    REDIS_URL: 'redis://localhost:6379',
    JWT_SIGNING_KEY_ID: 'test-key',
    JWT_PRIVATE_KEY: PRIVATE_KEY,
    JWT_PUBLIC_KEY: PUBLIC_KEY,
    PLATFORM_BOOTSTRAP_SECRET: 'x'.repeat(48),
    ...overrides,
  });
}

/** Every query the fake database was asked to run, in order. */
export interface RecordedQuery {
  sql: string;
  parameters?: unknown[];
}

export class FakeDatabaseService {
  healthy = true;
  readonly queries: RecordedQuery[] = [];
  /** Transaction lifecycle, recorded so a test can assert commit vs rollback. */
  readonly events: string[] = [];
  /** Rows the next `query` returns. Shifted off, so a test can queue several. */
  readonly rows: unknown[][] = [];

  private readonly manager = {
    query: (sql: string, parameters?: unknown[]): Promise<unknown[]> => {
      this.queries.push({ sql, parameters });
      return Promise.resolve(this.rows.shift() ?? []);
    },
  };

  readonly dataSource = {
    /**
     * Pool-level queries — the ones that deliberately run *outside* the request
     * transaction: `AuthGuard`'s revocation fallback, and the failed-login
     * audit that must survive the rollback its own 401 causes.
     */
    query: (sql: string, parameters?: unknown[]): Promise<unknown[]> => {
      this.queries.push({ sql, parameters });
      return Promise.resolve(this.rows.shift() ?? []);
    },

    createQueryRunner: () => {
      let active = false;
      return {
        manager: this.manager,
        get isTransactionActive() {
          return active;
        },
        connect: async () => undefined,
        // The isolation level is recorded rather than ignored: a route that
        // asks for `REPEATABLE READ` (Doc 04 §7.1) and silently gets the
        // default is a correctness bug no assertion about rows would catch.
        startTransaction: async (isolation?: string) => {
          active = true;
          this.events.push(isolation === undefined ? 'begin' : `begin:${isolation}`);
        },
        commitTransaction: async () => {
          active = false;
          this.events.push('commit');
        },
        rollbackTransaction: async () => {
          active = false;
          this.events.push('rollback');
        },
        release: async () => {
          this.events.push('release');
        },
      };
    },
  };

  isHealthy(): Promise<boolean> {
    return Promise.resolve(this.healthy);
  }
}

export class FakeRedisService {
  healthy = true;
  /** Set to make every command reject, standing in for an outage. */
  failing = false;
  readonly counters = new Map<string, number>();
  /** Plain keys — the revoked-`sid` entries the guard reads (Doc 03 §6). */
  readonly keys = new Map<string, string>();

  readonly client = {
    // `set`/`exists` back the revocation cache. Behavioural like the counter
    // fake: a test can revoke a session and watch the guard refuse the next
    // request, which a stub returning `0` could never show.
    set: async (key: string, value: string): Promise<'OK'> => {
      if (this.failing) throw new Error('redis unavailable');
      this.keys.set(key, value);
      return 'OK';
    },
    exists: async (key: string): Promise<number> => {
      if (this.failing) throw new Error('redis unavailable');
      return this.keys.has(key) ? 1 : 0;
    },

    multi: () => {
      const commands: Array<() => unknown> = [];
      const chain = {
        incr: (key: string) => {
          commands.push(() => {
            const next = (this.counters.get(key) ?? 0) + 1;
            this.counters.set(key, next);
            return next;
          });
          return chain;
        },
        // The TTL is irrelevant to the fake: keys carry the window index, so a
        // counter is unreachable once the window moves on whether it expired
        // or not. Recorded as a reply so `exec()`'s shape matches ioredis.
        expire: () => {
          commands.push(() => 1);
          return chain;
        },
        exec: async (): Promise<Array<[Error | null, unknown]>> => {
          if (this.failing) throw new Error('redis unavailable');
          return commands.map((run) => [null, run()]);
        },
      };
      return chain;
    },
  };

  isHealthy(): Promise<boolean> {
    return Promise.resolve(this.healthy);
  }

  channel(name: string): string {
    return `test:${name}`;
  }
}

/**
 * A compiled testing module → an application wired exactly like the deployed
 * one.
 *
 * The live `*.integration.spec.ts` suites assemble their own module (they need
 * a real `DataSource` and their own seed data, which the fakes below cannot
 * give them), so they cannot use {@link createHarness}. What they must not do
 * is boot that module differently from `main.ts` — `NEST_APP_OPTIONS` in
 * particular is load-bearing, and forgetting it does not fail loudly, it just
 * puts Nest's own body parser in front of the one `AppModule` registers.
 *
 * So the boot lives in one function and every suite calls it, which is the same
 * argument `app.module.ts` makes for `APP_*` providers over `main.ts` wiring.
 */
export function createTestApplication(
  moduleRef: TestingModule,
): NestExpressApplication {
  const app = moduleRef.createNestApplication<NestExpressApplication>(
    NEST_APP_OPTIONS,
  );
  hardenExpress(app);
  return app;
}

/** Who a minted test token claims to be. Every field has a usable default. */
export interface TestSubject {
  subjectId?: string;
  subjectType?: SubjectType;
  clientId?: string;
  sessionId?: string;
}

export interface IssuedTestToken {
  accessToken: string;
  /** Spreadable straight into a `fetch` init. */
  headers: { authorization: string };
  claims: { sub: string; cid: string; sid: string; sty: SubjectType };
}

export interface Harness {
  app: INestApplication;
  /** `http://127.0.0.1:<port>` — the app is on a port the OS picked. */
  baseUrl: string;
  database: FakeDatabaseService;
  redis: FakeRedisService;
  /** `fetch`, with the base URL already applied. */
  get(path: string, init?: RequestInit): Promise<Response>;
  /**
   * A genuinely signed access token for a made-up subject.
   *
   * Signed by the app's own `TokenService` with the harness keypair, so it
   * passes the real guard for the real reason. There is no back door here: a
   * test cannot bypass verification, only satisfy it.
   */
  tokenFor(subject?: TestSubject): IssuedTestToken;
  close(): Promise<void>;
}

export interface HarnessOptions {
  env?: EnvConfig;
  /**
   * Extra controllers, mounted alongside the real ones.
   *
   * They land in a module that *imports* `AppModule`, so they inherit the
   * genuine `APP_FILTER` / `APP_GUARD` / `APP_INTERCEPTOR` / `APP_PIPE` stack
   * (Nest applies those app-wide, not per module). A spec can therefore
   * provoke a failure mode the real routes cannot yet produce — a handler that
   * throws, a body that fails validation — and still be testing the shipped
   * pipeline rather than a replica of it.
   */
  controllers?: Type[];
}

export async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
  const env = options.env ?? testEnv();
  const database = new FakeDatabaseService();
  const redis = new FakeRedisService();

  @Module({ imports: [AppModule], controllers: options.controllers ?? [] })
  class TestRootModule {}

  const moduleRef = await Test.createTestingModule({ imports: [TestRootModule] })
    .overrideProvider(ENV)
    .useValue(env)
    .overrideProvider(DatabaseService)
    .useValue(database)
    .overrideProvider(RedisService)
    .useValue(redis)
    .compile();

  const app = createTestApplication(moduleRef);
  await app.init();
  // Port 0 — the OS assigns a free one, so suites can run without agreeing on
  // a port and without failing when a stray dev server holds 3000.
  await app.listen(0);

  const address = app.getHttpServer().address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const tokens = app.get(TokenService);

  return {
    app,
    baseUrl,
    database,
    redis,
    get: (path, init) => fetch(`${baseUrl}${path}`, init),

    tokenFor(subject: TestSubject = {}): IssuedTestToken {
      const input = {
        subjectId: subject.subjectId ?? randomUUID(),
        subjectType: subject.subjectType ?? SubjectType.USER,
        clientId: subject.clientId ?? randomUUID(),
        sessionId: subject.sessionId ?? randomUUID(),
      };
      const issued = tokens.issueAccessToken(input);
      return {
        accessToken: issued.accessToken,
        headers: { authorization: `Bearer ${issued.accessToken}` },
        claims: {
          sub: input.subjectId,
          cid: input.clientId,
          sid: input.sessionId,
          sty: input.subjectType,
        },
      };
    },

    close: () => app.close(),
  };
}
