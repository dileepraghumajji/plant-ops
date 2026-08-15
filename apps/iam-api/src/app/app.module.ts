/**
 * The root module — the cross-cutting stack every feature module inherits.
 *
 * Registered as `APP_*` providers rather than wired in `main.ts`, so a test
 * that builds this module gets the same pipeline the process does. That is the
 * point: an error-envelope or RLS-context test that runs against a *different*
 * pipeline from production proves nothing about production.
 *
 * Order of execution per request, and why each piece sits where it does:
 *
 * 1. `RequestIdMiddleware` — first, so everything after it has an id to log
 *    and to put in an error envelope.
 * 2. `AuthGuard` — verifies the bearer token and checks the session against the
 *    revocation cache (Doc 03 §6). Deny-by-default: a route is authenticated
 *    unless it carries `@Public()`.
 * 3. `RateLimitGuard` — still before any transaction or body parsing, so a
 *    throttled request is rejected before the expensive work; shedding load
 *    after paying for it is not shedding load.
 * 4. `TenantContextInterceptor` — opens the transaction and applies the RLS
 *    context from the claims the guard established. After the guards, before
 *    the handler.
 * 5. `ZodValidationPipe` — parses and strips the body.
 * 6. `HttpExceptionFilter` — turns whatever came out of all of the above into
 *    the Doc 06 §2 envelope.
 *
 * ## Why authentication runs before throttling
 *
 * Nest runs global guards in declaration order, so this array *is* the order.
 * Putting `AuthGuard` first is what lets `RateLimitGuard` key its counters by
 * `sub` rather than by IP — which matters because IP is a poor identity here:
 * a plant's terminals share one NAT address and would share one budget, while
 * a single stolen credential would escape its budget simply by moving between
 * addresses.
 *
 * The cost of that order is that an unauthenticated flood pays for a signature
 * verification before being refused. An RSA-2048 verify is tens of
 * microseconds against a rate limiter's Redis round-trip, so the trade is
 * lopsided in favour of the better bucketing. The one genuinely expensive
 * unauthenticated path — argon2id on `POST /auth/login` — is `@Public()` and so
 * never reaches the verifier at all; it is protected by its own tight
 * fail-closed limit instead.
 */

import { type MiddlewareConsumer, Module, type NestModule } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR, APP_PIPE } from '@nestjs/core';
import { AuthGuard } from '@plantops/auth-kit';
import { AuthModule } from '../auth/auth.module';
import { ClientsModule } from '../clients/clients.module';
import { HttpExceptionFilter } from '../common/http-exception.filter';
import { RequestIdMiddleware } from '../common/request-id.middleware';
import { TenantContextInterceptor } from '../common/tenant-context.interceptor';
import { RateLimitGuard } from '../common/throttler.guard';
import { ZodValidationPipe } from '../common/validation.pipe';
import { ConfigModule } from '../config/config.module';
import { DatabaseModule } from '../database/database.module';
import { HealthModule } from '../health/health.module';
import { IamModule } from '../iam/iam.module';
import { RedisModule } from '../redis/redis.module';
import { RegistryModule } from '../registry/registry.module';
import { ScopesModule } from '../scopes/scopes.module';
import { ServiceAccountsModule } from '../service-accounts/service-accounts.module';

@Module({
  imports: [
    ConfigModule,
    DatabaseModule,
    RedisModule,
    HealthModule,
    AuthModule,
    IamModule,
    RegistryModule,
    ClientsModule,
    ScopesModule,
    ServiceAccountsModule,
  ],
  providers: [
    { provide: APP_FILTER, useClass: HttpExceptionFilter },
    // Order-sensitive: see the note above. AuthGuard, then the throttle.
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_GUARD, useClass: RateLimitGuard },
    { provide: APP_INTERCEPTOR, useClass: TenantContextInterceptor },
    { provide: APP_PIPE, useClass: ZodValidationPipe },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestIdMiddleware).forRoutes('*');
  }
}
