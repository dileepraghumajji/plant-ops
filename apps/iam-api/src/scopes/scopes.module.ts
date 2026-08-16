/**
 * The client-admin org tree (Doc 06 §6, Doc 01 §3.5).
 *
 * `AuditModule` and `DatabaseModule` are the only imports, for the reason
 * `ClientsModule` gives: nothing here holds a connection of its own — every
 * statement runs on the request transaction `TenantContextInterceptor` opened —
 * and every mutation records itself through the one audit path (Doc 10 §3).
 *
 * `AuthzModule` supplies the grant-invalidation hook a move fires after commit
 * (Doc 04 §7.1). It was a stub provided here while the scope move was its only
 * caller; Session 18's lock/disable transitions made it a second one, and
 * Session 22 replaced the stub with the real bump-and-publish without any
 * caller changing — which is what putting it behind a service bought.
 *
 * `ScopesService` is exported: Session 20's bindings API has to resolve a scope
 * node and check it belongs to the caller's client before anchoring a grant to
 * it (Doc 02 §6), and that answer lives here.
 */

import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { AuthzModule } from '../authz/authz.module';
import { DatabaseModule } from '../database/database.module';
import { ScopesController } from './scopes.controller';
import { ScopesService } from './scopes.service';

@Module({
  imports: [AuditModule, AuthzModule, DatabaseModule],
  controllers: [ScopesController],
  providers: [ScopesService],
  exports: [ScopesService],
})
export class ScopesModule {}
