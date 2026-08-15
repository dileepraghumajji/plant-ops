/**
 * Liveness and readiness (Doc 06 §13).
 *
 * Two endpoints because they answer to different actions, and conflating them
 * is a self-inflicted outage:
 *
 * - **`/health`** — "is this process alive?" A failing liveness probe gets the
 *   container *killed*, so it must not consult Postgres or Redis. A brief
 *   database blip would otherwise restart every replica at once, converting a
 *   recoverable dependency failure into a cold start of the whole fleet.
 * - **`/ready`** — "should this instance receive traffic?" A failing readiness
 *   probe only removes the instance from the load balancer, which is the right
 *   response to a dependency it cannot serve without. It stays alive and
 *   rejoins when the dependency returns.
 *
 * Both are exempt from authentication, from the throttle, and from the
 * per-request transaction. An orchestrator's probe holds no credential and
 * never will; a throttled probe reports the throttle as an outage, hardest
 * during the traffic spike that made it matter; and `/ready`'s job is to find
 * out whether the database answers at all, which it cannot do from inside a
 * transaction on that database.
 *
 * The exemption costs nothing: neither route reads a tenant row, and `/ready`
 * reports only which dependency is up.
 *
 * Neither uses the Doc 06 §2 error envelope: a probe consumes status codes,
 * and a readiness report says *which* dependency is down, which an error code
 * cannot (Doc 06 §2, note).
 */

import { Controller, Get, Res } from '@nestjs/common';
import { Public } from '@plantops/auth-kit';
// The one platform-typed import left in a controller: `/ready` sets its own
// status code and a cache header on the raw response, which no return value can
// express. Everything that only needed the *claims* off the request now takes
// `@Claims()` and imports nothing from express (`common/claims.decorator.ts`).
import type { Response } from 'express';
import { SkipRateLimit } from '../common/rate-limit.decorator';
import { SkipTransaction } from '../common/transaction-context';
import { HealthService, type ReadinessReport } from './health.service';

/** Liveness answer. Deliberately says nothing about dependencies. */
export interface LivenessReport {
  status: 'ok';
  uptimeSeconds: number;
}

@Controller()
@Public()
@SkipRateLimit()
@SkipTransaction()
export class HealthController {
  constructor(private readonly health: HealthService) {}

  @Get('health')
  live(): LivenessReport {
    return { status: 'ok', uptimeSeconds: Math.round(process.uptime()) };
  }

  @Get('ready')
  async ready(
    // `passthrough` so Nest still serialises the returned body; the status is
    // the only thing being taken over.
    @Res({ passthrough: true }) response: Response,
  ): Promise<ReadinessReport> {
    const report = await this.health.readiness();
    // 503, not an exception: the report names the failing dependency, and
    // routing it through the error filter would replace that with a code.
    response.status(report.status === 'ready' ? 200 : 503);
    // Probes are polled every few seconds and must never be answered from a
    // proxy's cache — a cached "ready" outlives the readiness it reported.
    response.setHeader('Cache-Control', 'no-store');
    return report;
  }
}
