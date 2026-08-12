/**
 * The dependency checks behind `/ready` (Doc 06 §13).
 *
 * Both checks are live round-trips with a deadline, never a cached flag or a
 * client's own `status` field — see `DatabaseService.isHealthy` and
 * `RedisService.isHealthy` for why each of those lies.
 */

import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { RedisService } from '../redis/redis.service';

export type DependencyStatus = 'up' | 'down';

export interface ReadinessReport {
  status: 'ready' | 'not_ready';
  checks: {
    postgres: DependencyStatus;
    redis: DependencyStatus;
  };
}

@Injectable()
export class HealthService {
  constructor(
    private readonly database: DatabaseService,
    private readonly redis: RedisService,
  ) {}

  async readiness(): Promise<ReadinessReport> {
    // In parallel, so the worst case is one timeout rather than two in series
    // — the readiness budget is per dependency, and a probe interval is short.
    const [postgres, redis] = await Promise.all([
      this.database.isHealthy(),
      this.redis.isHealthy(),
    ]);

    // Both are required. Redis holds the revoked-`sid` set (Doc 03 §6), so an
    // instance serving without it would honour tokens that have been revoked —
    // degraded in a way that matters more than being briefly out of rotation.
    return {
      status: postgres && redis ? 'ready' : 'not_ready',
      checks: {
        postgres: postgres ? 'up' : 'down',
        redis: redis ? 'up' : 'down',
      },
    };
  }
}
