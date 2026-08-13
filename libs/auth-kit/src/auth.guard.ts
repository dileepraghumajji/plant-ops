/**
 * The guard every authenticated request passes through (Doc 03 §6).
 *
 * Three checks, in this order, and the order is the design:
 *
 * 1. **Signature and claims** — delegated to a {@link TokenVerifier}. The IAM
 *    verifies with its own keys; a module verifies against the fetched JWKS.
 * 2. **Revocation** — `sid` against the shared cache, so a force-logout lands
 *    within seconds without a database round-trip on the happy path.
 * 3. **Hand-off** — the verified claims are given to a {@link VerifiedClaimsSink},
 *    which is the *only* way claims reach the RLS context (Doc 07 §5).
 *
 * Revocation runs after verification, never before: a `sid` read out of an
 * unverified token is attacker-chosen, and looking it up would leak whether a
 * guessed session exists through response timing.
 *
 * ## Deny by default
 *
 * The guard is registered app-wide and a route is authenticated unless it says
 * otherwise with {@link Public}. That direction matters. An opt-in guard makes
 * every new controller unprotected until someone remembers a decorator, and the
 * symptom of forgetting is a route that works — which is the failure mode no
 * test ever catches, because working is what tests assert.
 *
 * `@Public()` is for the routes that genuinely cannot carry a token: login and
 * refresh (there is none yet), the JWKS (the thing that verifies tokens), and
 * the ops probes.
 *
 * ## Everything is a bare 401
 *
 * A malformed token, a forged `kid`, an expired token and a revoked session all
 * produce the same `AUTH_REQUIRED`. The reason is kept server-side on
 * {@link TokenVerificationError} for logs and metrics — telling the caller
 * which check failed tells an attacker whether a forged `kid` was a near miss,
 * or whether a guessed `sid` exists.
 */

import {
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
  Logger,
  Optional,
  SetMetadata,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { JwtClaims } from '@plantops/contracts';
import { TokenRejection, TokenVerificationError } from './claims';
import type { TokenVerifier } from './jwks-verifier';
import type { RevocationChecker } from './revocation-cache';

/** Marks a route reachable without a bearer token. */
export const IS_PUBLIC_METADATA = 'auth-kit:public';

/**
 * Opts a route out of authentication.
 *
 * Use sparingly and say why at the call site: every one of these is a route
 * with no subject, and therefore no RLS context and no tenant.
 */
export const Public = () => SetMetadata(IS_PUBLIC_METADATA, true);

/**
 * Receives claims the guard has fully verified.
 *
 * The indirection exists because of a boundary: `auth-kit` may not import
 * `@plantops/db` (Doc 08 §2), and it is `@plantops/db` that owns the branded
 * `VerifiedClaims` type the RLS context accepts. So the host application
 * supplies the one adapter that brands them, and that adapter is the single
 * place in the system where an unverified object could ever become a verified
 * one — a thing far easier to review in one file than in a guard shared by
 * every module.
 */
export interface VerifiedClaimsSink {
  accept(request: unknown, claims: JwtClaims): void;
}

/** What to do when the revocation cache cannot answer. */
export interface RevocationFallback {
  /**
   * The authoritative answer, from the database.
   *
   * Present only in the IAM, which owns the `session` table. A module has no
   * such table and therefore no fallback — see {@link AuthGuardOptions}.
   *
   * It receives the whole claim set, not just `sid`, because the right answer
   * depends on `sty`: a service token's `sid` is ephemeral and backed by no
   * row at all (Doc 03 §5), so looking it up would find nothing and read that
   * absence as revoked — killing every machine identity the moment Redis
   * blinked.
   *
   * @throws when it too cannot answer.
   */
  isRevoked(claims: JwtClaims): Promise<boolean>;
}

export interface AuthGuardOptions {
  /**
   * What a request means when neither the cache nor the fallback can answer.
   *
   * `'deny'` (the default) is correct: uncertainty about revocation must fall
   * to refusal, or a Redis outage becomes a window in which every revoked
   * session works again. `'allow'` exists for a deployment that would rather
   * survive a cache outage than hold revocation — a real trade, but one that
   * has to be made explicitly and written down, never inherited from a default.
   */
  onRevocationUnavailable?: 'deny' | 'allow';
}

export const TOKEN_VERIFIER = Symbol('auth-kit:TokenVerifier');
export const REVOCATION_CHECKER = Symbol('auth-kit:RevocationChecker');
export const VERIFIED_CLAIMS_SINK = Symbol('auth-kit:VerifiedClaimsSink');
export const REVOCATION_FALLBACK = Symbol('auth-kit:RevocationFallback');
export const AUTH_GUARD_OPTIONS = Symbol('auth-kit:AuthGuardOptions');

@Injectable()
export class AuthGuard implements CanActivate {
  private readonly logger = new Logger(AuthGuard.name);

  constructor(
    private readonly reflector: Reflector,
    @Inject(TOKEN_VERIFIER) private readonly verifier: TokenVerifier,
    @Inject(REVOCATION_CHECKER) private readonly revocations: RevocationChecker,
    @Inject(VERIFIED_CLAIMS_SINK) private readonly sink: VerifiedClaimsSink,
    // Optional, and the omission is the common case: only the IAM owns the
    // `session` table. A module that binds nothing here denies when the cache
    // is unavailable, which is the right default for a process that cannot
    // check for itself.
    @Optional()
    @Inject(REVOCATION_FALLBACK)
    private readonly fallback: RevocationFallback | null = null,
    @Optional()
    @Inject(AUTH_GUARD_OPTIONS)
    private readonly options: AuthGuardOptions = {},
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;

    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_METADATA, [
      context.getHandler(),
      context.getClass(),
    ]);
    // A public route is let through with **no** claims attached, so the
    // transaction wrapper applies no RLS context and every tenant policy
    // matches nothing. Public means unauthenticated, not privileged.
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<{
      headers: Record<string, string | string[] | undefined>;
    }>();

    const token = bearerTokenOf(request.headers['authorization']);
    if (token === undefined) throw new UnauthorizedException('Authentication is required');

    let claims: JwtClaims;
    try {
      claims = await this.verifier.verify(token);
    } catch (error) {
      throw this.refuse(error);
    }

    if (await this.isRevoked(claims)) {
      throw this.refuse(
        new TokenVerificationError(TokenRejection.REVOKED, 'Session has been revoked'),
      );
    }

    this.sink.accept(request, claims);
    return true;
  }

  /**
   * Cache first; database only when the cache could not answer.
   *
   * The happy path is one Redis `EXISTS` and no SQL, which is what makes this
   * affordable on every request (Doc 03 §6).
   */
  private async isRevoked(claims: JwtClaims): Promise<boolean> {
    try {
      return await this.revocations.isRevoked(claims.sid);
    } catch (cacheError) {
      this.logger.warn(
        `Revocation cache unavailable (${messageOf(cacheError)}); ` +
          (this.fallback ? 'falling back to the database' : 'no database fallback'),
      );

      if (this.fallback) {
        try {
          return await this.fallback.isRevoked(claims);
        } catch (dbError) {
          this.logger.error(
            `Revocation fallback also failed (${messageOf(dbError)})`,
          );
        }
      }

      // Both sources are down. Deny unless the deployment said otherwise.
      return (this.options.onRevocationUnavailable ?? 'deny') === 'deny';
    }
  }

  /** One shape of refusal, with the reason kept out of the response. */
  private refuse(error: unknown): UnauthorizedException {
    if (error instanceof TokenVerificationError) {
      this.logger.debug(`Token refused: ${error.reason}`);
    } else {
      this.logger.warn(`Token verification failed: ${messageOf(error)}`);
    }
    return new UnauthorizedException('Authentication is required');
  }
}

/**
 * The token from an `Authorization` header, or `undefined`.
 *
 * The scheme is matched case-insensitively (RFC 7235 makes it so) but the token
 * is taken verbatim: trimming or re-casing it would change the bytes the
 * signature covers. A repeated header arrives as an array — ambiguous, and
 * therefore refused rather than resolved by picking one.
 */
function bearerTokenOf(header: string | string[] | undefined): string | undefined {
  if (typeof header !== 'string') return undefined;
  const [scheme, ...rest] = header.split(' ');
  if (scheme?.toLowerCase() !== 'bearer' || rest.length !== 1) return undefined;
  return rest[0] === '' ? undefined : rest[0];
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
