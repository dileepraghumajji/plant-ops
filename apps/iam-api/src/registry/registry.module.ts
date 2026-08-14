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
 * `AuditModule` and `DatabaseModule` are the only imports, for the reason
 * `ServiceAccountsModule` gives: nothing here holds a connection of its own, the
 * interim platform check reads the RLS context `TenantContextInterceptor`
 * already applied, and every mutation records itself through the one audit path
 * (Doc 10 §3).
 *
 * `ManifestService` (Session 14) is the declarative form of exactly these
 * operations, and it composes them rather than re-implementing the inserts —
 * which is why it sits in the same module and takes all three as dependencies.
 *
 * The services are exported because later sessions reach for them: Session 23
 * seeds the IAM's own manifest through `ManifestService`, and Session 22 hangs
 * nav-cache invalidation off the catalog writers.
 */

import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { DatabaseModule } from '../database/database.module';
import { ApplicationsController } from './applications.controller';
import { ApplicationsService } from './applications.service';
import { ManifestService } from './manifest.service';
import { NavService } from './nav.service';
import { PermissionsService } from './permissions.service';

@Module({
  imports: [AuditModule, DatabaseModule],
  controllers: [ApplicationsController],
  providers: [ApplicationsService, PermissionsService, NavService, ManifestService],
  exports: [ApplicationsService, PermissionsService, NavService, ManifestService],
})
export class RegistryModule {}
