/**
 * The client-admin role surface (Doc 06 §7, Doc 01 §4.2).
 *
 * `AuditModule` and `DatabaseModule` are the only imports, for the reason
 * `ScopesModule` gives: nothing here holds a connection of its own — every
 * statement runs on the request transaction `TenantContextInterceptor` opened —
 * and every mutation records itself through the one audit path (Doc 10 §3).
 *
 * `RolesService` is exported: Session 20's bindings API has to resolve a role and
 * check it belongs to the caller's client before granting it (Doc 02 §6), and
 * that answer lives here.
 */

import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { DatabaseModule } from '../database/database.module';
import { RolesController } from './roles.controller';
import { RolesService } from './roles.service';

@Module({
  imports: [AuditModule, DatabaseModule],
  controllers: [RolesController],
  providers: [RolesService],
  exports: [RolesService],
})
export class RolesModule {}
