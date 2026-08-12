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
import { Test } from '@nestjs/testing';
import { type EnvConfig, parseEnv } from '@plantops/config';
import type { AddressInfo } from 'node:net';
import { AppModule } from '../app/app.module';
import { ENV } from '../config/config.module';
import { DatabaseService } from '../database/database.service';
import { RedisService } from '../redis/redis.service';

const PRIVATE_KEY =
  '-----BEGIN PRIVATE KEY-----\nMIIBVgIBADANBg\n-----END PRIVATE KEY-----';
const PUBLIC_KEY =
  '-----BEGIN PUBLIC KEY-----\nMIIBIjANBgkqhki\n-----END PUBLIC KEY-----';

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
    createQueryRunner: () => {
      let active = false;
      return {
        manager: this.manager,
        get isTransactionActive() {
          return active;
        },
        connect: async () => undefined,
        startTransaction: async () => {
          active = true;
          this.events.push('begin');
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

  readonly client = {
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

export interface Harness {
  app: INestApplication;
  /** `http://127.0.0.1:<port>` — the app is on a port the OS picked. */
  baseUrl: string;
  database: FakeDatabaseService;
  redis: FakeRedisService;
  /** `fetch`, with the base URL already applied. */
  get(path: string, init?: RequestInit): Promise<Response>;
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

  const app = moduleRef.createNestApplication();
  await app.init();
  // Port 0 — the OS assigns a free one, so suites can run without agreeing on
  // a port and without failing when a stray dev server holds 3000.
  await app.listen(0);

  const address = app.getHttpServer().address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;

  return {
    app,
    baseUrl,
    database,
    redis,
    get: (path, init) => fetch(`${baseUrl}${path}`, init),
    close: () => app.close(),
  };
}
