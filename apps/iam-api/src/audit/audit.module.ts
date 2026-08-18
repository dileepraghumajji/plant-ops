/**
 * The audit layer — the writer every module uses, and the reader one controller
 * exposes (Doc 10 §3, §7).
 *
 * `DatabaseModule` is here for the denial path alone: {@link AuditService.record}
 * uses the ambient request transaction and needs no injected data source, but
 * `recordDenial` opens its own connection precisely because the request's is
 * about to be rolled back. The read side needs nothing beyond the request
 * transaction and so injects no data source either.
 *
 * ## One module, imported everywhere, mounting a controller
 *
 * Every feature module imports this one for the writer, so `AuditController`
 * reaches the router through a module that is already in the graph — Nest
 * instantiates a module once however many times it is imported, so the routes
 * are registered once. That is why Session 25 added a controller here rather
 * than a module of its own: reading the trail needs the request transaction and
 * nothing else, and a second module would exist only to hold one class.
 *
 * Only {@link AuditService} is exported. The query and export services are this
 * module's internals — a feature module that wanted to read the trail would be
 * doing something the read API is for, and exporting them would make that easy
 * to do by accident.
 */

import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { AuditExportService } from './audit-export.service';
import { AuditQueryService } from './audit-query.service';
import { AuditController } from './audit.controller';
import { AuditService } from './audit.service';

@Module({
  imports: [DatabaseModule],
  controllers: [AuditController],
  providers: [AuditService, AuditQueryService, AuditExportService],
  exports: [AuditService],
})
export class AuditModule {}
