/**
 * The client-admin role surface (Doc 06 §7, Doc 01 §4.2).
 *
 * `AuditModule` and `DatabaseModule` carry the usual pair, for the reason
 * `ScopesModule` gives: nothing here holds a connection of its own — every
 * statement runs on the request transaction `TenantContextInterceptor` opened —
 * and every mutation records itself through the one audit path (Doc 10 §3).
 *
 * `AuthzModule` joins them in Session 22. Two of Doc 04 §7's rows are this
 * service's — a role's permissions edited, a role deleted — and both invalidate
 * *every subject bound to the role*, which is the widest fan-out in the table.
 * The dependency points downward, like every other consumer's: `AuthzModule`
 * imports nothing above itself, which is what keeps the six surfaces that call
 * the invalidation hook from forming a cycle through it.
 *
 * `RolesService` is exported: Session 20's bindings API has to resolve a role and
 * check it belongs to the caller's client before granting it (Doc 02 §6), and
 * that answer lives here.
 */

import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { AuthzModule } from '../authz/authz.module';
import { DatabaseModule } from '../database/database.module';
import { RolesController } from './roles.controller';
import { RolesService } from './roles.service';

@Module({
  imports: [AuditModule, AuthzModule, DatabaseModule],
  controllers: [RolesController],
  providers: [RolesService],
  exports: [RolesService],
})
export class RolesModule {}
