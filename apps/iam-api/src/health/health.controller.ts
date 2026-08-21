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

import { Controller, Get, Inject, Res } from '@nestjs/common';
import { Public } from '@plantops/auth-kit';
import type { EnvConfig } from '@plantops/config';
// The one platform-typed import left in a controller: `/ready` sets its own
// status code and a cache header on the raw response, which no return value can
// express. Everything that only needed the *claims* off the request now takes
// `@Claims()` and imports nothing from express (`common/claims.decorator.ts`).
import type { Response } from 'express';
import { SkipRateLimit } from '../common/rate-limit.decorator';
import { SkipTransaction } from '../common/transaction-context';
import { ENV } from '../config/config.module';
import { HealthService, type ReadinessReport } from './health.service';

/**
 * Liveness answer. Deliberately says nothing about dependencies — and one thing
 * that is not about liveness at all.
 *
 * `version` rides here because of where it has to be readable from, not because
 * it belongs to the same question. Doc 11 §8, gap 8: support for a self-hosted
 * install starts with "what version are you on", and the person who can answer
 * has no dashboard, possibly no network to us, and no credential for anything
 * behind the guard. `/health` is the only endpoint that is already
 * unauthenticated, unthrottled and reachable from inside the client's own
 * network, so it is where the answer costs nothing to reach.
 *
 * It leaks nothing an attacker cannot get more reliably elsewhere: a version
 * string is not a secret, and hiding it buys obscurity while costing every
 * legitimate support conversation an hour.
 */
export interface LivenessReport {
  status: 'ok';
  /** The build, stamped into the image at build time (`APP_VERSION`). */
  version: string;
  uptimeSeconds: number;
}

@Controller()
@Public()
@SkipRateLimit()
@SkipTransaction()
export class HealthController {
  constructor(
    private readonly health: HealthService,
    @Inject(ENV) private readonly env: EnvConfig,
  ) {}

  @Get('health')
  live(): LivenessReport {
    return {
      status: 'ok',
      // Read off the validated environment, never off `process.env` or a
      // `package.json` bundled beside the code: the first is what every other
      // setting in this app is read from, and the second reports the version of
      // the *workspace at build time*, which is 0.0.0 and always has been.
      version: this.env.APP_VERSION,
      uptimeSeconds: Math.round(process.uptime()),
    };
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
