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
 * 2. `RateLimitGuard` — a guard, so a throttled request is rejected before a
 *    transaction is opened or a body is parsed. Shedding load after paying for
 *    the work is not shedding load.
 * 3. `TenantContextInterceptor` — opens the transaction and applies the RLS
 *    context. After the guard, before the handler.
 * 4. `ZodValidationPipe` — parses and strips the body.
 * 5. `HttpExceptionFilter` — turns whatever came out of all of the above into
 *    the Doc 06 §2 envelope.
 */

import { type MiddlewareConsumer, Module, type NestModule } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR, APP_PIPE } from '@nestjs/core';
import { AuthModule } from '../auth/auth.module';
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

@Module({
  imports: [
    ConfigModule,
    DatabaseModule,
    RedisModule,
    HealthModule,
    AuthModule,
    IamModule,
  ],
  providers: [
    { provide: APP_FILTER, useClass: HttpExceptionFilter },
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
