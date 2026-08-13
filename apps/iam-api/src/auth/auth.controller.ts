/**
 * `POST /auth/login`, `/auth/logout`, `/auth/sessions` (Doc 06 §3).
 *
 * ## Which routes are public, and why exactly these
 *
 * `AuthGuard` is registered app-wide, so a route is authenticated unless it
 * says otherwise. Login and refresh are `@Public()` here — between them they are
 * the routes that exist to *produce* the token everything else requires, and
 * refresh in particular is reached precisely when the access token has expired,
 * so requiring one would make it unreachable. Logout, the session list and the
 * revoke endpoint all carry a bearer token and are guarded like any other
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
 * would be ideal against a single attacker. It is the outer layer, not the
 * answer. The per-account half is the failed-attempt lockout in
 * `iam.auth_record_login_failure` (migration 0014), and the two cover different
 * cases: this bounds one attacker against the whole tenant, that bounds the
 * whole internet against one account.
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
import {
  LoginDto,
  PasswordResetDto,
  PasswordResetRequestDto,
  RefreshDto,
} from './auth.dto';
import { PasswordResetService } from './password-reset.service';
import { RefreshService } from './refresh.service';
import { SessionService } from './session.service';

/** Ten attempts a minute per caller, and no free pass when Redis is down. */
const LOGIN_RATE_LIMIT = { limit: 10, windowSeconds: 60, failOpen: false } as const;

/**
 * Refresh is limited too, but it fails **open** — the opposite of login, on
 * purpose.
 *
 * Login's limit is what stands between an attacker and unlimited guesses at a
 * human-chosen password. Nothing analogous applies here: the secret presented is
 * 256 bits from the CSPRNG, so guessing is not a strategy, and the limit exists
 * to bound the amplification in `iam.auth_rotate_refresh_token` — a token that
 * matches neither generation revokes its session, and that should not be a lever
 * anyone can pull in a loop.
 *
 * Failing closed would mean a Redis blip logs out every client whose access
 * token expires during it, since refresh is the only way back and re-login runs
 * into the throttle too. Thirty a minute leaves room for a plant behind one NAT
 * — a client refreshes about every quarter of an hour — while still bounding the
 * loop.
 */
const REFRESH_RATE_LIMIT = { limit: 30, windowSeconds: 60 } as const;

/**
 * Session management is authenticated and cheap, but it is still a lever an
 * attacker would like to pull repeatedly with a stolen token — a loop of
 * revokes is a denial of service against a whole tenant's terminals.
 */
const SESSION_RATE_LIMIT = { limit: 60, windowSeconds: 60 } as const;

/**
 * Reset is the tightest limit on the surface, and it fails **closed**.
 *
 * Requesting a reset is unauthenticated, costs an email, and invalidates the
 * account's outstanding token as a side effect — so an unthrottled loop is both
 * a mail-bomb against a person and a way to make sure no reset link a real user
 * clicks is ever still current. Five a minute is generous for a human who
 * mistypes their address twice and useless as an amplifier.
 *
 * Completion shares the bucket. It is a guess against a 256-bit secret, so the
 * limit is not what makes guessing hopeless, but there is no legitimate caller
 * who submits the same link six times in a minute either.
 */
const PASSWORD_RESET_RATE_LIMIT = {
  limit: 5,
  windowSeconds: 60,
  failOpen: false,
} as const;

@Controller(AUTH_ROUTE_PREFIX)
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly refreshes: RefreshService,
    private readonly sessions: SessionService,
    private readonly passwordResets: PasswordResetService,
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

  /**
   * Rotates a refresh token (Doc 03 §4, Doc 06 §3).
   *
   * Returns the same `{ access_token, refresh_token, expires_in }` login does,
   * because a client should be able to treat the two identically: store what
   * comes back, discard what it had. The refresh token in the response is a new
   * one on a normal rotation and the *already-issued* one when this request lost
   * a race — indistinguishable from here, which is what makes concurrent
   * refreshes safe for a caller that is not thinking about them.
   */
  @Post('refresh')
  @Public()
  @HttpCode(HttpStatus.OK)
  @RateLimit(REFRESH_RATE_LIMIT)
  refresh(@Body() body: RefreshDto): Promise<TokenPairResponse> {
    return this.refreshes.refresh(body.refresh_token);
  }

  /**
   * Starts a password reset (Doc 03 §7, Doc 06 §3).
   *
   * **202, always.** Unknown tenant, unknown address, locked account, disabled
   * account, mail transport down — every one of them accepted, with no body.
   * Doc 06 §3 pins the status and the reason is the one behind login's generic
   * 401: an endpoint that answers differently for an address that exists is a
   * staff directory anyone can query, and this one needs no password to do it.
   *
   * `@Public()`, necessarily: somebody who cannot log in is exactly who is here.
   */
  @Post('password/reset-request')
  @Public()
  @HttpCode(HttpStatus.ACCEPTED)
  @RateLimit(PASSWORD_RESET_RATE_LIMIT)
  async requestPasswordReset(@Body() body: PasswordResetRequestDto): Promise<void> {
    await this.passwordResets.request({
      email: body.email,
      clientSlug: body.client_slug,
    });
  }

  /**
   * Completes a password reset (Doc 03 §7, Doc 06 §3).
   *
   * 204 on success, and one 401 for every way it can fail. The new password is
   * policy-checked by the DTO before it arrives — Doc 03 §7's "enforce minimum
   * policy at the API" — so a 400 here is about the password being too short,
   * never about the token.
   *
   * Succeeding logs the account out everywhere (Doc 03 §6). A reset is either a
   * forgotten password or a stolen one, and the second case is what decides the
   * behaviour: leaving live sessions running would change nothing for whoever is
   * already inside.
   */
  @Post('password/reset')
  @Public()
  @HttpCode(HttpStatus.NO_CONTENT)
  @RateLimit(PASSWORD_RESET_RATE_LIMIT)
  async completePasswordReset(@Body() body: PasswordResetDto): Promise<void> {
    await this.passwordResets.complete({
      token: body.token,
      newPassword: body.new_password,
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
