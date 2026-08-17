/**
 * The client-admin grant surface (Doc 06 §9, Doc 01 §4.5).
 *
 * `AuditModule` and `DatabaseModule` for the reason `RolesModule` gives: nothing
 * here holds a connection of its own — every statement runs on the request
 * transaction `TenantContextInterceptor` opened — and every mutation records
 * itself through the one audit path (Doc 10 §3). `AuthzModule` supplies the
 * grant-invalidation hook a bind or unbind fires after commit (Doc 04 §7).
 *
 * The other four are the interesting ones, and they are why this module is last
 * in Phase 4 rather than anywhere else. A binding is the only row in the system
 * that names four things at once, and Doc 02 §6 requires three of them to be the
 * caller's own. Each of those questions already has exactly one answer somewhere
 * — `UsersService.findRow`, `ServiceAccountsService.findRow`,
 * `RolesService.findRow`, `ScopesService.findRow` — and each of those modules
 * exports its service saying, in its own header, that Session 20 is who it is
 * exported *for*.
 *
 * Importing the four rather than writing four `select … where client_id = $1 and
 * id = $2` statements here is not tidiness. It is what keeps "is this role mine"
 * a single definition: a local copy would be correct the day it was written and
 * would then have to be found again every time one of those surfaces changed
 * what visible means — which is the drift `audit-actions.ts` and
 * `authz/iam-permissions.ts` both exist to prevent, applied to the one place
 * where getting it wrong grants somebody access.
 *
 * No cycle: each of the four imports only `AuditModule`, `AuthModule`,
 * `AuthzModule` and `DatabaseModule`, and none of them imports this one. Nothing
 * is exported from here — a binding is written through the API or not at all.
 */

import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { AuthzModule } from '../authz/authz.module';
import { DatabaseModule } from '../database/database.module';
import { RolesModule } from '../roles/roles.module';
import { ScopesModule } from '../scopes/scopes.module';
import { ServiceAccountsModule } from '../service-accounts/service-accounts.module';
import { UsersModule } from '../users/users.module';
import { BindingsController } from './bindings.controller';
import { BindingsService } from './bindings.service';

@Module({
  imports: [
    AuditModule,
    AuthzModule,
    DatabaseModule,
    RolesModule,
    ScopesModule,
    ServiceAccountsModule,
    UsersModule,
  ],
  controllers: [BindingsController],
  providers: [BindingsService],
})
export class BindingsModule {}
