/**
 * The platform application registry (Doc 06 §4, Doc 02 §2).
 *
 * One module for the three services behind one controller, because they are one
 * transaction's worth of work: a nav node needs its application, a
 * `menu_permission` row needs both a nav node and a permission, and every one of
 * those lookups runs on the same request transaction (`entityManager()`).
 * Splitting them across modules would put a Nest boundary through a sequence
 * that Doc 02 §2 describes as a single registration.
 *
 * `AuditModule` and `DatabaseModule` carry the usual pair, for the reason
 * `ServiceAccountsModule` gives: nothing here holds a connection of its own, the
 * interim platform check reads the RLS context `TenantContextInterceptor`
 * already applied, and every mutation records itself through the one audit path
 * (Doc 10 §3).
 *
 * `AuthzModule` is Session 22's, for the manifest row of Doc 04 §7 —
 * soft-deactivating a permission changes no binding and therefore fires no other
 * invalidation, while making the key inert everywhere it was granted.
 *
 * `NavigationModule` is Session 24's, and it is the same shape of dependency one
 * layer over: a nav-node or `menu_permission` edit here bumps that module's
 * `app_nav_version` after commit, so a cached tree for the application is treated
 * as stale (Doc 05 §6). The arrow points from the writer to whoever cached the
 * old answer, exactly as it does at `AuthzModule` — see `navigation.module.ts`
 * for why it does not point back.
 *
 * `ManifestService` (Session 14) is the declarative form of exactly these
 * operations, and it composes them rather than re-implementing the inserts —
 * which is why it sits in the same module and takes all three as dependencies.
 *
 * The services are exported because other sessions reach for them: the IAM's
 * own manifest is upserted through `ManifestService` like any application's
 * (`tools/seed-iam-manifest.ts`), and Session 24 hangs nav-catalog version
 * invalidation off the catalog writers.
 */

import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { AuthzModule } from '../authz/authz.module';
import { DatabaseModule } from '../database/database.module';
import { NavigationModule } from '../navigation/navigation.module';
import { ApplicationsController } from './applications.controller';
import { ApplicationsService } from './applications.service';
import { ManifestService } from './manifest.service';
import { NavService } from './nav.service';
import { PermissionsService } from './permissions.service';

@Module({
  imports: [AuditModule, AuthzModule, DatabaseModule, NavigationModule],
  controllers: [ApplicationsController],
  providers: [ApplicationsService, PermissionsService, NavService, ManifestService],
  exports: [ApplicationsService, PermissionsService, NavService, ManifestService],
})
export class RegistryModule {}
