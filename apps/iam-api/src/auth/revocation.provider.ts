/**
 * The IAM's binding of `auth-kit`'s {@link RevocationCache} to its Redis
 * connection (Doc 03 §6).
 *
 * `auth-kit` deliberately does not depend on `ioredis` — it is consumed by every
 * future module and must not impose a client on them — so it declares the two
 * commands it needs and each host supplies something that has them. `ioredis`'s
 * `Redis` satisfies that as-is.
 *
 * The keys land under `REDIS_KEY_PREFIX` automatically, because `RedisService`
 * configures the client with it. That matters more here than it looks: a
 * staging deployment sharing a managed Redis with production would otherwise
 * revoke production's sessions.
 */

import { RevocationCache, type RevocationStore } from '@plantops/auth-kit';
import { CLOCK_SKEW_LEEWAY_SECONDS } from '@plantops/contracts';
import type { EnvConfig } from '@plantops/config';
import type { Provider } from '@nestjs/common';
import { ENV } from '../config/config.module';
import { RedisService } from '../redis/redis.service';

export const REVOCATION_CACHE = Symbol('REVOCATION_CACHE');

export const revocationCacheProvider: Provider = {
  provide: REVOCATION_CACHE,
  inject: [RedisService, ENV],
  useFactory: (redis: RedisService, env: EnvConfig): RevocationCache =>
    new RevocationCache(redis.client as unknown as RevocationStore, {
      // One access-token lifetime plus the leeway every verifier applies. Past
      // that a token carrying the `sid` is refused for `exp` anyway, so the
      // entry would be protecting nothing while still costing memory.
      ttlSeconds: env.ACCESS_TOKEN_TTL_SECONDS + CLOCK_SKEW_LEEWAY_SECONDS,
    }),
};
