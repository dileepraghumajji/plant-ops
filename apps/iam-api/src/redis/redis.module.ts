/**
 * Redis, as one connection shared by everything that needs it.
 *
 * Global because the consumers are spread across layers that have no
 * dependency relationship — the throttle guard, `/ready`, the revoked-`sid`
 * cache (Session 8) and the grants cache (Session 21) — and a second client
 * per consumer would multiply connections against a managed instance whose
 * connection count is the thing you pay for.
 */

import { Global, Module } from '@nestjs/common';
import { RedisService } from './redis.service';

@Global()
@Module({
  providers: [RedisService],
  exports: [RedisService],
})
export class RedisModule {}
