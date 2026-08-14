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
 * The services are exported because Session 14's `ManifestService` is the
 * declarative form of exactly these operations and will compose them rather than
 * re-implement the inserts.
 */

import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { DatabaseModule } from '../database/database.module';
import { ApplicationsController } from './applications.controller';
import { ApplicationsService } from './applications.service';
import { NavService } from './nav.service';
import { PermissionsService } from './permissions.service';

@Module({
  imports: [AuditModule, DatabaseModule],
  controllers: [ApplicationsController],
  providers: [ApplicationsService, PermissionsService, NavService],
  exports: [ApplicationsService, PermissionsService, NavService],
})
export class RegistryModule {}
