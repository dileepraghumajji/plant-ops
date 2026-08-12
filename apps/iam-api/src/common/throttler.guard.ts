/**
 * The blanket rate limit (Doc 06 §2 — 429 `RATE_LIMITED`).
 *
 * A fixed window in Redis, counted per caller per handler. Redis rather than
 * in-process memory because the limit has to hold across replicas: a
 * per-process counter with three instances behind a load balancer is a limit
 * three times larger than the number configured, and it resets on every
 * deploy.
 *
 * ## Fixed window, deliberately
 *
 * A fixed window admits up to `2 × limit` requests across a window boundary.
 * That is the accepted cost of one `INCR` on the hot path — the alternatives
 * (sliding log, token bucket) cost a sorted set or a Lua script per request to
 * buy precision that a *capacity* limit does not need. Session 8's `/auth/*`
 * limits are small enough that even the doubled burst stays useless to an
 * attacker.
 *
 * The counter key carries the window index, so each window gets its own key
 * and expires on its own. There is no separate `EXPIRE` to lose, and therefore
 * no way to leave an immortal counter behind that locks a caller out
 * permanently — the failure this design is chosen to avoid.
 */

import {
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
  Logger,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { EnvConfig } from '@plantops/config';
import type { Request, Response } from 'express';
import { ENV } from '../config/config.module';
import { RedisService } from '../redis/redis.service';
import { IamException } from './iam.exception';
import {
  RATE_LIMIT_METADATA,
  type RateLimitRule,
} from './rate-limit.decorator';
import { verifiedClaimsOf } from './verified-claims';
import { withTimeout } from './with-timeout';

/**
 * Budget for the counter round-trip. Short on purpose: the throttle exists to
 * protect the process, so it must never become the slowest thing in a request.
 */
const COUNTER_TIMEOUT_MS = 250;

@Injectable()
export class RateLimitGuard implements CanActivate {
  private readonly logger = new Logger(RateLimitGuard.name);

  constructor(
    @Inject(ENV) private readonly env: EnvConfig,
    private readonly redis: RedisService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (!this.env.RATE_LIMIT_ENABLED || context.getType() !== 'http') return true;

    // `getAllAndOverride` lets a handler override its controller, which is the
    // direction overrides are wanted: tighten one endpoint inside a controller
    // that is otherwise on the default.
    const override = this.reflector.getAllAndOverride<RateLimitRule | null>(
      RATE_LIMIT_METADATA,
      [context.getHandler(), context.getClass()],
    );
    if (override === null) return true;

    const rule: RateLimitRule = override ?? {
      limit: this.env.RATE_LIMIT_MAX_REQUESTS,
      windowSeconds: this.env.RATE_LIMIT_WINDOW_SECONDS,
    };

    const http = context.switchToHttp();
    const request = http.getRequest<Request>();
    const response = http.getResponse<Response>();

    const windowStart =
      Math.floor(Date.now() / 1000 / rule.windowSeconds) * rule.windowSeconds;
    const resetAt = windowStart + rule.windowSeconds;
    const key = [
      'rl',
      `${context.getClass().name}.${context.getHandler().name}`,
      this.callerOf(request),
      windowStart,
    ].join(':');

    let count: number;
    try {
      count = await withTimeout(
        this.increment(key, rule.windowSeconds),
        COUNTER_TIMEOUT_MS,
        'rate-limit counter',
      );
    } catch (error) {
      const failOpen = rule.failOpen ?? true;
      this.logger.warn(
        `Rate-limit counter unavailable (${(error as Error).message}); ` +
          `${failOpen ? 'allowing' : 'rejecting'} the request`,
      );
      if (failOpen) return true;
      throw IamException.rateLimited(
        'Request rate could not be verified; please retry',
      );
    }

    response.setHeader('X-RateLimit-Limit', rule.limit);
    response.setHeader('X-RateLimit-Remaining', Math.max(0, rule.limit - count));
    response.setHeader('X-RateLimit-Reset', resetAt);

    if (count > rule.limit) {
      // `Retry-After` is what makes a 429 actionable for a well-behaved client;
      // without it the usual response is an immediate retry, which is the
      // traffic the limit was trying to shed.
      response.setHeader('Retry-After', Math.max(1, resetAt - Math.floor(Date.now() / 1000)));
      throw IamException.rateLimited();
    }

    return true;
  }

  /**
   * One atomic round-trip: bump the window's counter and (re)assert its TTL.
   *
   * `MULTI` rather than a pipeline so a connection lost between the two
   * commands cannot leave a counter with no expiry. The TTL is twice the
   * window, which is slack rather than meaning — the key is already
   * unreachable once the window index moves on.
   */
  private async increment(key: string, windowSeconds: number): Promise<number> {
    const replies = await this.redis.client
      .multi()
      .incr(key)
      .expire(key, windowSeconds * 2)
      .exec();

    const incremented = replies?.[0];
    if (!incremented || incremented[0] !== null) {
      throw new Error('rate-limit counter did not return a value');
    }
    return Number(incremented[1]);
  }

  /**
   * Who is being counted.
   *
   * An authenticated subject is keyed by `sub`, so one tenant's traffic cannot
   * exhaust another's budget merely by sharing an office NAT — and so a single
   * compromised credential cannot hide behind rotating IPs. Everything else
   * falls back to the peer address, which is only trustworthy when
   * `TRUST_PROXY` matches the actual deployment (see the env comment).
   */
  private callerOf(request: Request): string {
    const claims = verifiedClaimsOf(request);
    if (claims) return `sub:${claims.sub}`;
    return `ip:${request.ip ?? request.socket.remoteAddress ?? 'unknown'}`;
  }
}
