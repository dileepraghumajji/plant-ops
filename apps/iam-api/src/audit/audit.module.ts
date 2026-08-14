/**
 * The audit layer (Doc 10 §3).
 *
 * Providers only — the read API (`GET /iam/audit`, Doc 06 §12) is Session 25's
 * and brings the controller with it. What exists now is the writer every
 * feature module needs, so this module is imported rather than mounted.
 *
 * `DatabaseModule` is here for the denial path alone: {@link AuditService.record}
 * uses the ambient request transaction and needs no injected data source, but
 * `recordDenial` opens its own connection precisely because the request's is
 * about to be rolled back.
 */

import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { AuditService } from './audit.service';

@Module({
  imports: [DatabaseModule],
  providers: [AuditService],
  exports: [AuditService],
})
export class AuditModule {}
