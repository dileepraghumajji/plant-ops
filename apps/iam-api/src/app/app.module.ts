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
 * 2. `JsonBodyMiddleware` / `ManifestBodyMiddleware` / `BulkUploadBodyMiddleware`
 *    — parse the body under a stated ceiling, one of three depending on the
 *    route. Middleware rather than `NestFactory`'s built-in parser so
 *    that an oversized or malformed body reaches the filter instead of
 *    Express's HTML error page; see `common/body-parser.middleware.ts`.
 * 3. `AuthGuard` — verifies the bearer token and checks the session against the
 *    revocation cache (Doc 03 §6). Deny-by-default: a route is authenticated
 *    unless it carries `@Public()`.
 * 4. `RateLimitGuard` — still before any transaction, so a throttled request is
 *    rejected before the expensive work; shedding load after paying for it is
 *    not shedding load.
 * 5. `TenantContextInterceptor` — opens the transaction and applies the RLS
 *    context from the claims the guard established. After the guards, before
 *    the handler.
 * 6. `ZodValidationPipe` — validates and strips the parsed body.
 * 7. `HttpExceptionFilter` — turns whatever came out of all of the above into
 *    the Doc 06 §2 envelope.
 *
 * ## Why body parsing sits ahead of the guards
 *
 * It is the one ordering compromise here. Express parses a body as middleware,
 * and Nest runs all middleware before any guard, so a request is read into
 * memory before it is authenticated or throttled — which is why the ceiling
 * matters: it is what bounds that read. The alternative, parsing after the
 * guards, is not available in this framework, and the guards themselves need
 * nothing from the body (the token is a header, the throttle keys on `sub`).
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

import {
  type MiddlewareConsumer,
  Module,
  type NestModule,
  RequestMethod,
} from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR, APP_PIPE } from '@nestjs/core';
import { AuthGuard } from '@plantops/auth-kit';
import { AuthModule } from '../auth/auth.module';
import { AuthzApiModule } from '../authz/authz-api.module';
import { BindingsModule } from '../bindings/bindings.module';
import { ClientsModule } from '../clients/clients.module';
import {
  BULK_USER_UPLOAD_ROUTE_PATH,
  BulkUploadBodyMiddleware,
  JsonBodyMiddleware,
  MANIFEST_ROUTE_PATH,
  ManifestBodyMiddleware,
} from '../common/body-parser.middleware';
import { HttpExceptionFilter } from '../common/http-exception.filter';
import { RequestIdMiddleware } from '../common/request-id.middleware';
import { TenantContextInterceptor } from '../common/tenant-context.interceptor';
import { RateLimitGuard } from '../common/throttler.guard';
import { ZodValidationPipe } from '../common/validation.pipe';
import { ConfigModule } from '../config/config.module';
import { DatabaseModule } from '../database/database.module';
import { HealthModule } from '../health/health.module';
import { IamModule } from '../iam/iam.module';
import { OpenApiModule } from '../openapi/openapi.module';
import { RedisModule } from '../redis/redis.module';
import { RegistryModule } from '../registry/registry.module';
import { RolesModule } from '../roles/roles.module';
import { ScopesModule } from '../scopes/scopes.module';
import { ServiceAccountsModule } from '../service-accounts/service-accounts.module';
import { UsersModule } from '../users/users.module';

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
    RolesModule,
    UsersModule,
    ServiceAccountsModule,
    BindingsModule,
    AuthzApiModule,
    OpenApiModule,
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

    // Three ceilings, one parser each, and the two exempt routes excluded from
    // the global one rather than parsed twice. `body-parser` would skip the
    // second pass anyway, but "excluded" is a statement about which limit
    // applies and "skipped" is an accident of another library's guard clause.
    const manifestRoute = {
      path: MANIFEST_ROUTE_PATH,
      method: RequestMethod.POST,
    };
    const bulkUploadRoute = {
      path: BULK_USER_UPLOAD_ROUTE_PATH,
      method: RequestMethod.POST,
    };
    consumer
      .apply(ManifestBodyMiddleware)
      .forRoutes(manifestRoute)
      .apply(BulkUploadBodyMiddleware)
      .forRoutes(bulkUploadRoute)
      .apply(JsonBodyMiddleware)
      .exclude(manifestRoute, bulkUploadRoute)
      .forRoutes('*');
  }
}
