/**
 * `@Claims()` — the verified JWT claims, as a handler parameter.
 *
 * ## What it replaces, and why that mattered
 *
 * Before this, every handler that needed a subject took `@Req() request:
 * Request` and passed it through a local `claimsOf(request)` helper — the same
 * five lines copy-pasted into four controllers, with a fifth variant inlined in
 * `whoami.controller.ts`. Each copy encoded a real invariant:
 *
 * > `AuthGuard` has already refused anything without claims, so reaching the
 * > throw means a route lost its guard. Fail closed rather than run the handler
 * > with no subject.
 *
 * An invariant enforced by copy-paste is one that stops holding at the first
 * controller whose author writes `verifiedClaimsOf(request)!` instead — and the
 * symptom of getting it wrong is a route that *works*, which is the same failure
 * mode `auth.guard.ts` argues against for opt-in guards. Now there is one copy,
 * and a handler cannot obtain claims without going through it.
 *
 * ## It also takes `express` out of the controllers
 *
 * `@Req()` obliges a controller to import `Request` from `'express'` to type the
 * parameter. Controllers are the layer that should be platform-agnostic: the
 * decorator reads through `ExecutionContext.switchToHttp()`, so the adapter is
 * named in exactly one file instead of six, and a controller's signature now
 * states what the route needs (a subject) rather than how the framework happens
 * to deliver it.
 *
 * Where a handler genuinely needs the raw request or response — `/ready` taking
 * over its status code with `@Res({ passthrough: true })` — `@Req()`/`@Res()`
 * stay, with a comment saying why. This decorator replaces the *claims*
 * extraction only.
 *
 * ## Why it throws rather than returning `VerifiedClaims | undefined`
 *
 * A nullable return would push the fail-closed check back out to every caller,
 * which is the situation this file exists to end. The non-nullable type is the
 * enforcement: a handler that declares `@Claims() claims: VerifiedClaims` cannot
 * compile against a route that might not have one.
 *
 * `VerifiedClaims` is the branded type from `@plantops/db`, obtainable only
 * through `markClaimsVerified` (see `verified-claims.ts`), so what this hands a
 * handler cannot have come from a body, a header or a query parameter.
 *
 * ```ts
 * ⁣@Post()
 * create(⁣@Claims() claims: VerifiedClaims, ⁣@Body() body: CreateRoleDto) { … }
 * ```
 */

import { type ExecutionContext, createParamDecorator } from '@nestjs/common';
import type { VerifiedClaims } from '@plantops/db';
import { IamException } from './iam.exception';
import { verifiedClaimsOf } from './verified-claims';

export const Claims = createParamDecorator(
  (_: unknown, context: ExecutionContext): VerifiedClaims => {
    // `switchToHttp()` rather than `getRequest()` on a typed context: the same
    // reason the express import left the controllers.
    const claims = verifiedClaimsOf(context.switchToHttp().getRequest());
    // Unreachable through the guard. It is the backstop for a route that ever
    // loses it — a `@Public()` route that still asks for a subject, or a guard
    // dropped from `app.module.ts` — and it answers the same 401 an anonymous
    // request gets, rather than running the handler with nothing.
    if (!claims) throw IamException.authRequired();
    return claims;
  },
);
