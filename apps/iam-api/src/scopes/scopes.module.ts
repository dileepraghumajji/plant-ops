/**
 * The client-admin org tree (Doc 06 §6, Doc 01 §3.5).
 *
 * `AuditModule` and `DatabaseModule` are the only imports, for the reason
 * `ClientsModule` gives: nothing here holds a connection of its own — every
 * statement runs on the request transaction `TenantContextInterceptor` opened —
 * and every mutation records itself through the one audit path (Doc 10 §3).
 *
 * `ScopeInvalidationService` is provided here rather than in a shared module
 * because it is a stub with exactly one caller. Session 22 replaces it with the
 * real `authz/invalidation.service.ts`, which will have several, and moving it
 * then is a smaller change than pre-emptively putting a placeholder somewhere
 * central.
 *
 * `ScopesService` is exported: Session 20's bindings API has to resolve a scope
 * node and check it belongs to the caller's client before anchoring a grant to
 * it (Doc 02 §6), and that answer lives here.
 */

import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { DatabaseModule } from '../database/database.module';
import { ScopeInvalidationService } from './scope-invalidation.service';
import { ScopesController } from './scopes.controller';
import { ScopesService } from './scopes.service';

@Module({
  imports: [AuditModule, DatabaseModule],
  controllers: [ScopesController],
  providers: [ScopesService, ScopeInvalidationService],
  exports: [ScopesService],
})
export class ScopesModule {}
