/**
 * Binds {@link RefreshReplayCache} to the IAM's Redis connection.
 *
 * The keys land under `REDIS_KEY_PREFIX` automatically, because `RedisService`
 * configures the client with it — which matters here for the same reason it
 * matters for revocation: a staging deployment sharing a managed Redis with
 * production must not answer production's refresh races.
 */

import type { Provider } from '@nestjs/common';
import type { EnvConfig } from '@plantops/config';
import { ENV } from '../config/config.module';
import { RedisService } from '../redis/redis.service';
import { RefreshReplayCache, type ReplayStore } from './refresh-replay.cache';

export const REFRESH_REPLAY_CACHE = Symbol('REFRESH_REPLAY_CACHE');

export const refreshReplayCacheProvider: Provider = {
  provide: REFRESH_REPLAY_CACHE,
  inject: [RedisService, ENV],
  useFactory: (redis: RedisService, env: EnvConfig): RefreshReplayCache =>
    new RefreshReplayCache(
      redis.client as unknown as ReplayStore,
      env.REFRESH_REUSE_GRACE_SECONDS,
    ),
};
