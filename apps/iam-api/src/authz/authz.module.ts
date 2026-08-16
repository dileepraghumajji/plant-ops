/**
 * The authorization core (Doc 04).
 *
 * Three providers, and one property that shapes the whole file: **it imports
 * nothing above itself.** `AuthModule`, `ScopesModule`, `UsersModule` and
 * `BindingsModule` all import this one — for the invalidation hook they fire
 * after commit — so anything it imported back would be a cycle.
 *
 * Session 21 keeps that true, exactly as the Session 20 version of this header
 * promised it would: the resolution engine's dependencies arrive as
 * `DatabaseModule` and `RedisModule`, which are leaves, and nothing here is a
 * re-export of anything above.
 *
 * ## Why the controller is not here
 *
 * `authz.controller.ts` needs `TokenService` for `POST /iam/introspect`, and
 * `TokenService` lives in `AuthModule` — which already imports this module. So
 * the HTTP surface lives in {@link AuthzApiModule} (`authz-api.module.ts`),
 * which imports both and is imported by nobody. Splitting the *providers* from
 * their *routes* is the smaller price: the alternative is a `forwardRef` pair
 * between the two largest modules in the application, which would make the
 * initialisation order of the guard's own dependencies an implementation detail
 * of Nest's cycle resolution.
 *
 * ## What is exported and who consumes it
 *
 * - {@link GrantInvalidationService} — the post-commit hook the four surfaces
 *   above already call. Session 22 replaces its body with the real publish.
 * - {@link ResolverService} — the entry point for the endpoints today and for
 *   Session 23's `PermissionGuard` tomorrow, which calls
 *   `grantsFor(runner.manager, …)` on its own connection
 *   (`docs/adr/0001-permission-guard-connection-strategy.md`).
 * - {@link GrantsCacheService} — exported for Session 22, whose invalidation
 *   service bumps a subject's version through it rather than naming a Redis key
 *   of its own.
 */

import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { RedisModule } from '../redis/redis.module';
import { GrantsCacheService } from './grants-cache.service';
import { GrantInvalidationService } from './invalidation.service';
import { ResolverService } from './resolver.service';

@Module({
  imports: [DatabaseModule, RedisModule],
  providers: [GrantInvalidationService, GrantsCacheService, ResolverService],
  exports: [GrantInvalidationService, GrantsCacheService, ResolverService],
})
export class AuthzModule {}
