/**
 * The tenant a single-tenant deployment logs you in to (roadmap Session 44,
 * Doc 11 §6.5).
 *
 * One job, on one route: in `DEPLOYMENT_MODE=single_tenant`, supply
 * `client_slug` on `POST /auth/login` from configuration, and refuse a request
 * that supplies a different one.
 *
 * ## Why a middleware rather than a change to the login service
 *
 * The acceptance criterion that governs this session is that **`saas` behaviour
 * is identical to today** — every existing e2e passing unmodified is what makes
 * the change safe. So the login path is not touched: `loginSchema` still
 * requires `client_slug`, `ZodValidationPipe` still produces the same
 * `VALIDATION_FAILED` envelope for the same bodies, and `AuthService.login`
 * still resolves a tenant by slug exactly as it always has.
 *
 * Middleware runs before pipes, so by the time the DTO is validated the body is
 * the same shape it would have had in SaaS. In `saas` mode this file does
 * nothing at all: one branch, taken never.
 *
 * ## Refused, not overwritten
 *
 * A `client_slug` that disagrees with the pinned one could be silently replaced
 * — the outcome would be the same login. It is refused instead, because the two
 * are not the same statement to whoever sent it: overwriting tells a caller
 * their choice was honoured, and the one thing this deployment must never
 * suggest is that the tenant was theirs to choose. Doc 11 §6.5's rule is that
 * the browser does not select the tenant; the empty login form is a consequence
 * of that rule, not the rule itself.
 *
 * A slug that *matches* is allowed through untouched, so an integration written
 * against the SaaS shape — `@plantops/iam-client`, a saved script — keeps
 * working against a single-tenant install.
 *
 * ## What it deliberately does not do
 *
 * It does not set an RLS context, derive authority, or touch a claim. The tenant
 * still reaches the database the one way it ever has: resolved from the slug by
 * the login service, then carried in the session's verified `cid`
 * (`libs/db/src/rls-context.ts`). This adds no authorization path — it removes
 * an input.
 */

import { Injectable, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { IamException } from '../common/iam.exception';
import { DeploymentModeService } from '../config/deployment-mode';

@Injectable()
export class SingleTenantLoginMiddleware implements NestMiddleware {
  constructor(private readonly deployment: DeploymentModeService) {}

  use(request: Request, _response: Response, next: NextFunction): void {
    if (!this.deployment.isSingleTenant) return next();

    const pinned = this.deployment.client;
    // Unreachable in a booted process — `DeploymentModeService` refuses to
    // initialize without a pinned client, so the app never listens. Left as a
    // refusal rather than a fallback because "carry on without a tenant" is not
    // an answer this route can give safely.
    if (pinned === undefined) {
      // A plain Error, so the exception filter takes its 500 path and logs the
      // message against the request id without returning it. There is no
      // field-level complaint to hand a caller here: the fault is entirely this
      // process's.
      throw new Error(
        'single-tenant mode is configured but no client is pinned — ' +
          'DeploymentModeService did not initialize.',
      );
    }

    // A non-object body is not this file's problem: the validation pipe will
    // refuse it in a moment, with a better message than anything here.
    const body: unknown = request.body;
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      return next();
    }

    const supplied = (body as Record<string, unknown>)['client_slug'];

    if (supplied === undefined || supplied === null || supplied === '') {
      (body as Record<string, unknown>)['client_slug'] = pinned.slug;
      return next();
    }

    if (supplied !== pinned.slug) {
      throw IamException.validationFailed([
        {
          field: 'client_slug',
          message:
            'This deployment serves a single organisation, which it is configured ' +
            'with. Omit client_slug, or send the configured one.',
        },
      ]);
    }

    return next();
  }
}
