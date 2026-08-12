/**
 * Per-endpoint throttle overrides.
 *
 * The guard applies a blanket limit from the environment to everything; this
 * is how an individual route tightens it. Session 8 puts a single-digit limit
 * on `POST /auth/login` with `failOpen: false` — a login endpoint that stops
 * counting when Redis blips is a credential-stuffing window, which is a very
 * different trade-off from the one the blanket limit is making.
 */

import { SetMetadata } from '@nestjs/common';

export const RATE_LIMIT_METADATA = 'iam:rate-limit';

export interface RateLimitRule {
  /** Requests permitted per window, per caller. */
  limit: number;
  /** Length of the fixed window, in seconds. */
  windowSeconds: number;
  /**
   * What to do when the counter store is unreachable.
   *
   * `true` (default) — serve the request. An unavailable *cache* should not
   * take down an API whose blanket limit exists to protect the process.
   * `false` — reject with 429. Correct wherever the limit is a security
   * control rather than a capacity one, since failing open there hands an
   * attacker unlimited attempts exactly when monitoring is already degraded.
   */
  failOpen?: boolean;
}

/** Tightens (or loosens) the throttle for one handler or controller. */
export const RateLimit = (rule: RateLimitRule) =>
  SetMetadata(RATE_LIMIT_METADATA, rule);

/**
 * Exempts a route entirely. For `/health` and `/ready` only: a throttled
 * readiness probe reports the *throttle* as an outage, and does so hardest
 * during the traffic spike that made the probe matter.
 */
export const SkipRateLimit = () => SetMetadata(RATE_LIMIT_METADATA, null);
