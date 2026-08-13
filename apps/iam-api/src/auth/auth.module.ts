/**
 * The `/auth` surface, the token machinery behind it, and the wiring that makes
 * `auth-kit`'s guard work inside the IAM (Doc 03).
 *
 * ## Where the guard itself is registered
 *
 * Not here. `AuthGuard` is declared as an `APP_GUARD` in `app.module.ts`,
 * beside the rate limiter, because **the order of the two is a security
 * property** and Nest applies global guards in the order it discovers them.
 * Spreading them across modules would make that order an accident of import
 * sequence. What lives here is everything the guard *depends* on, exported so
 * the root module can construct it.
 *
 * ## The four bindings
 *
 * - **{@link TOKEN_VERIFIER} → `TokenService`.** The IAM verifies with its own
 *   local keys; it *is* the JWKS publisher, so fetching its own document over
 *   HTTP would be a round-trip to itself. Every other process binds
 *   `JwksVerifier` here instead — that substitution is the whole reason the
 *   guard depends on an interface.
 * - **{@link REVOCATION_CHECKER} → the Redis cache.** One `EXISTS` per request
 *   and no SQL on the happy path (Doc 03 §6).
 * - **{@link REVOCATION_FALLBACK} → `SessionService`.** Only the IAM can have
 *   one: it owns the `session` table. A module has no fallback and denies when
 *   the cache is unavailable.
 * - **{@link VERIFIED_CLAIMS_SINK} → `RequestClaimsSink`.** The single place
 *   claims become branded and therefore usable as an RLS context (Doc 07 §5).
 *
 * `TokenService` and `KeysService` stay exported because Session 11
 * (service-account exchange) and Session 23 (`PermissionGuard`) build on them
 * and must sign with the same key set rather than grow their own — as Session
 * 9's `RefreshService`, which lives here, already does.
 *
 * ## A fifth binding, and why it is not among the four
 *
 * `REFRESH_REPLAY_CACHE` is Redis too, but it is not part of the guard's
 * contract and no other process participates in it: Doc 06 §11 has modules
 * verify tokens locally and send their users here to rotate. So it stays
 * unexported, and its key prefix stays out of `@plantops/contracts` — see
 * `refresh-replay.cache.ts`.
 *
 * `PASSWORD_RESET_DELIVERY` (Session 10) is the same kind of thing from the
 * other direction: an outbound port with a deliberately inadequate default, so
 * that the channel is a deployment decision rather than something the auth
 * module picked.
 */

import { Module, type Provider } from '@nestjs/common';
import {
  AUTH_GUARD_OPTIONS,
  REVOCATION_CHECKER,
  REVOCATION_FALLBACK,
  TOKEN_VERIFIER,
  VERIFIED_CLAIMS_SINK,
  type AuthGuardOptions,
} from '@plantops/auth-kit';
import type { EnvConfig } from '@plantops/config';
import { ENV } from '../config/config.module';
import { DatabaseModule } from '../database/database.module';
import { RedisModule } from '../redis/redis.module';
import { AccountStateService } from './account-state.service';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwksController } from './jwks.controller';
import { KeysService } from './keys.service';
import {
  LoggingPasswordResetDelivery,
  PASSWORD_RESET_DELIVERY,
} from './password-reset.delivery';
import { PasswordResetService } from './password-reset.service';
import { refreshReplayCacheProvider } from './refresh-replay.provider';
import { RefreshService } from './refresh.service';
import { REVOCATION_CACHE, revocationCacheProvider } from './revocation.provider';
import { SessionService } from './session.service';
import { TokenService } from './token.service';
import { RequestClaimsSink } from './verified-claims.sink';

/**
 * Deny when neither the revocation cache nor the database can answer.
 *
 * Stated explicitly rather than left to the default, because it is a real
 * trade-off and the next person should see that it was chosen: uncertainty
 * about whether a session is dead has to fall to refusal, or a Redis outage
 * becomes a window in which every revoked session works again.
 */
const AUTH_GUARD_SETTINGS: AuthGuardOptions = { onRevocationUnavailable: 'deny' };

/**
 * Where a reset token goes once it exists (Doc 03 §7).
 *
 * The default binding logs it outside production and refuses to log it inside
 * production — see `password-reset.delivery.ts` for why that split is the whole
 * design. A deployment with a mail transport overrides this provider; nothing
 * else in the module changes, which is the point of the port.
 */
const passwordResetDeliveryProvider: Provider = {
  provide: PASSWORD_RESET_DELIVERY,
  inject: [ENV],
  useFactory: (env: EnvConfig) =>
    new LoggingPasswordResetDelivery(env.NODE_ENV === 'production'),
};

@Module({
  imports: [DatabaseModule, RedisModule],
  controllers: [AuthController, JwksController],
  providers: [
    KeysService,
    TokenService,
    SessionService,
    AuthService,
    RefreshService,
    PasswordResetService,
    AccountStateService,
    RequestClaimsSink,
    passwordResetDeliveryProvider,
    refreshReplayCacheProvider,
    revocationCacheProvider,
    { provide: TOKEN_VERIFIER, useExisting: TokenService },
    { provide: REVOCATION_CHECKER, useExisting: REVOCATION_CACHE },
    { provide: REVOCATION_FALLBACK, useExisting: SessionService },
    { provide: VERIFIED_CLAIMS_SINK, useExisting: RequestClaimsSink },
    { provide: AUTH_GUARD_OPTIONS, useValue: AUTH_GUARD_SETTINGS },
  ],
  exports: [
    KeysService,
    TokenService,
    SessionService,
    // Session 16's user-admin surface calls these transitions from its own
    // controller; the state machine itself stays here, beside the login path
    // that enforces it.
    AccountStateService,
    // The guard's dependencies, so `AppModule` can construct `AuthGuard` in
    // its own injector and thereby fix its position among the global guards.
    TOKEN_VERIFIER,
    REVOCATION_CHECKER,
    REVOCATION_FALLBACK,
    VERIFIED_CLAIMS_SINK,
    AUTH_GUARD_OPTIONS,
  ],
})
export class AuthModule {}
