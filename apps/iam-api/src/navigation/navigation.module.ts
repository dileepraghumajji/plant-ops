/**
 * Dynamic navigation (Doc 05).
 *
 * `AuthzModule` is the only import, and it is the only one needed: the resolution
 * engine is where the grants come from, `RedisModule` and `ConfigModule` are
 * global, and nothing here injects a `DataSource`. Like `authz-api.module.ts`,
 * this module deliberately omits `DatabaseModule` — `NavigationService` reads
 * through `entityManager()`, the request transaction `TenantContextInterceptor`
 * opened, so a connection of its own would be one it had no business holding.
 *
 * ## Why `RegistryModule` imports *this* one, and not the other way round
 *
 * {@link NavCatalogCacheService} is exported for the catalog writers —
 * `registry/nav.service.ts` and `registry/manifest.service.ts` — which bump
 * `app_nav_version` after commit when they change a nav node or a mapping
 * (Doc 05 §6). So the arrow points from the writers to the resolver, which is the
 * same direction `RegistryModule` already points at `AuthzModule` for
 * `GrantInvalidationService`: a surface that changes something announces it to
 * whoever cached the old answer, and never the reverse.
 *
 * Nothing in the other direction exists to tempt anyone. `NavigationService`
 * reads `nav_node`, `menu_permission` and `client_application` with its own two
 * statements rather than through `NavService.tree()`, because the two return
 * different things for different readers: `tree()` is the platform admin's whole
 * catalog including inactive rows and their gates, and this is one subject's
 * pruned view with the gates removed. `nav.service.ts` says the same from its
 * side.
 */

import { Module } from '@nestjs/common';
import { AuthzModule } from '../authz/authz.module';
import { NavCatalogCacheService } from './nav-catalog-cache.service';
import { NavigationController } from './navigation.controller';
import { NavigationService } from './navigation.service';

@Module({
  imports: [AuthzModule],
  controllers: [NavigationController],
  providers: [NavigationService, NavCatalogCacheService],
  exports: [NavCatalogCacheService],
})
export class NavigationModule {}
