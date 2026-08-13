/**
 * `POST /auth/login`, `/auth/logout`, `/auth/sessions` (Doc 06 §3).
 *
 * ## Which routes are public, and why exactly these
 *
 * `AuthGuard` is registered app-wide, so a route is authenticated unless it
 * says otherwise. Only login is `@Public()` here — it is the route that exists
 * to *produce* the token everything else requires. Logout, the session list and
 * the revoke endpoint all carry a bearer token and are guarded like any other
 * endpoint, which is what lets them act on `claims.sid` and `claims.sub`
 * instead of trusting a body.
 *
 * ## The throttle on login is a security control, not a capacity one
 *
 * Hence `failOpen: false`: when the counter store is unreachable the request is
 * refused rather than served. Everywhere else in this API the opposite is
 * right — an unavailable *cache* should not take down an API. Here, failing
 * open hands an attacker unlimited password attempts at exactly the moment
 * monitoring is already degraded, which is the one situation the limit exists
 * for.
 *
 * The limit is per caller IP, and IP is a blunt instrument: a plant behind one
 * NAT shares a bucket, so it is set at ten a minute rather than the three that
 * would be ideal against a single attacker. The real credential-stuffing
 * defence is per-account and arrives in Session 10 (failed-attempt lockout,
 * Doc 03 §8) — this is the blunt outer layer, not the answer.
 */

import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
} from '@nestjs/common';
import { Public } from '@plantops/auth-kit';
import {
  AUTH_ROUTE_PREFIX,
  type SessionDTO,
  type TokenPairResponse,
} from '@plantops/contracts';
import type { Request } from 'express';
import { IamException } from '../common/iam.exception';
import { RateLimit } from '../common/rate-limit.decorator';
import { verifiedClaimsOf } from '../common/verified-claims';
import { AuthAuditAction, AuthService } from './auth.service';
import { LoginDto } from './auth.dto';
import { SessionService } from './session.service';

/** Ten attempts a minute per caller, and no free pass when Redis is down. */
const LOGIN_RATE_LIMIT = { limit: 10, windowSeconds: 60, failOpen: false } as const;

/**
 * Session management is authenticated and cheap, but it is still a lever an
 * attacker would like to pull repeatedly with a stolen token — a loop of
 * revokes is a denial of service against a whole tenant's terminals.
 */
const SESSION_RATE_LIMIT = { limit: 60, windowSeconds: 60 } as const;

@Controller(AUTH_ROUTE_PREFIX)
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly sessions: SessionService,
  ) {}

  @Post('login')
  @Public()
  @HttpCode(HttpStatus.OK)
  @RateLimit(LOGIN_RATE_LIMIT)
  login(@Body() body: LoginDto): Promise<TokenPairResponse> {
    return this.auth.login({
      email: body.email,
      password: body.password,
      clientSlug: body.client_slug,
      deviceLabel: body.device_label ?? null,
    });
  }

  /** Revokes the session the caller's own token belongs to. */
  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RateLimit(SESSION_RATE_LIMIT)
  async logout(@Req() request: Request): Promise<void> {
    await this.auth.logout(claimsOf(request));
  }

  @Get('sessions')
  @RateLimit(SESSION_RATE_LIMIT)
  sessionList(@Req() request: Request): Promise<SessionDTO[]> {
    return this.sessions.listForSubject(claimsOf(request));
  }

  /**
   * Force-logout (Doc 03 §6) — the shift-end kill for a shared terminal.
   *
   * Restricted to the caller's own sessions today. Revoking *another* user's
   * session is an administrative act that needs `iam.client.user.*` and a scope
   * check, which is Session 23's `PermissionGuard`; until it exists the honest
   * position is that nobody has that power, rather than that everybody does.
   *
   * A session id that is not the caller's — including one from another tenant,
   * which RLS makes invisible rather than forbidden — answers 404, so the
   * response cannot be used to discover that a session exists elsewhere.
   */
  @Post('sessions/:id/revoke')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RateLimit(SESSION_RATE_LIMIT)
  async revokeSession(
    @Req() request: Request,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ): Promise<void> {
    const revoked = await this.sessions.revoke(
      id,
      claimsOf(request),
      AuthAuditAction.SESSION_REVOKED,
    );
    if (!revoked) throw IamException.notFound('The session');
  }
}

/**
 * The verified claims for this request.
 *
 * The guard has already refused anything without them, so reaching the throw is
 * a wiring bug — a route that lost its guard — and it fails closed rather than
 * running the handler with no subject.
 */
function claimsOf(request: Request) {
  const claims = verifiedClaimsOf(request);
  if (!claims) throw IamException.authRequired();
  return claims;
}
