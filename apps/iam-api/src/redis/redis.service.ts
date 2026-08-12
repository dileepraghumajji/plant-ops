/**
 * The process-wide Redis connection.
 *
 * Redis is a *supporting* dependency, not a load-bearing one: it holds the
 * grants cache (Doc 04 §6), the revoked-`sid` set (Doc 03 §6) and the throttle
 * counters. Every one of those has a defined behaviour when the cache is
 * unreachable, so the connection is configured to fail *fast and loudly*
 * rather than to hide an outage behind queued commands:
 *
 * - `lazyConnect` + a caught `connect()` — the process boots with Redis down
 *   and reports it on `/ready`. Refusing to start instead would give an
 *   orchestrator nothing to probe and turn a cache blip into a rollback.
 * - `enableOfflineQueue: false` — a command issued while disconnected rejects
 *   immediately instead of buffering. A queued `GET` that resolves ninety
 *   seconds later is worse than no cache at all: the caller is already gone.
 * - `maxRetriesPerRequest: 1` — one retry, then the caller decides. Callers on
 *   the request path apply their own timeout on top (see {@link withTimeout}).
 */

import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import type { EnvConfig } from '@plantops/config';
import { Redis } from 'ioredis';
import { ENV } from '../config/config.module';
import { withTimeout } from '../common/with-timeout';

@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  readonly client: Redis;

  constructor(@Inject(ENV) private readonly env: EnvConfig) {
    this.client = new Redis(env.REDIS_URL, {
      keyPrefix: env.REDIS_KEY_PREFIX,
      lazyConnect: true,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
      connectTimeout: env.READINESS_TIMEOUT_MS,
    });

    // ioredis emits `error` on every failed reconnection attempt, and an
    // unhandled 'error' on an EventEmitter is a process-level crash. Logging at
    // debug keeps a Redis outage from filling the log with one line per retry
    // while the reconnect loop runs — `/ready` is where the outage is visible.
    this.client.on('error', (error: Error) => {
      this.logger.debug(`Redis connection error: ${error.message}`);
    });
  }

  async onModuleInit(): Promise<void> {
    try {
      await this.client.connect();
      this.logger.log('Redis connected');
    } catch (error) {
      // Deliberately not fatal — see the class comment.
      this.logger.warn(
        `Redis unavailable at startup; /ready will report not-ready until it recovers (${
          (error as Error).message
        })`,
      );
    }
  }

  async onModuleDestroy(): Promise<void> {
    // `quit` waits for in-flight commands; `disconnect` is the hard fallback
    // for the case where the socket is already gone and `quit` would hang.
    try {
      await this.client.quit();
    } catch {
      this.client.disconnect();
    }
  }

  /**
   * Is Redis answering *right now*, within the readiness budget?
   *
   * A bounded `PING`, never the connection's `status` field: ioredis reports
   * `ready` from the moment the socket handshake completes, which a half-open
   * connection to a wedged server also satisfies.
   */
  async isHealthy(): Promise<boolean> {
    try {
      const reply = await withTimeout(
        this.client.ping(),
        this.env.READINESS_TIMEOUT_MS,
        'redis ping',
      );
      return reply === 'PONG';
    } catch {
      return false;
    }
  }

  /**
   * Prefixes a pub/sub channel name.
   *
   * `keyPrefix` covers keys automatically but **not** channels — ioredis does
   * not rewrite `publish`/`subscribe` arguments. Without this, two deployments
   * sharing a managed Redis would cross-invalidate each other's caches over
   * `perms.invalidated` (Doc 04 §7) while their keys stayed properly separated.
   */
  channel(name: string): string {
    return `${this.env.REDIS_KEY_PREFIX}${name}`;
  }
}
