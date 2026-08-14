/**
 * Tenant provisioning (Doc 06 §5, Doc 02 §3).
 *
 * One module for the three services behind one controller, because they are one
 * onboarding's worth of work and each depends on the one before it: enabling an
 * application needs the client to exist, and seeding an admin needs both. All
 * three run on the same request transaction (`entityManager()`), so a Nest
 * boundary between them would only split a sequence Doc 02 §3 describes as a
 * single registration.
 *
 * `AuditModule` and `DatabaseModule` are the only imports, for the reason
 * `RegistryModule` gives: nothing here holds a connection of its own, the
 * interim platform check reads the RLS context `TenantContextInterceptor` already
 * applied, and every mutation records itself through the one audit path
 * (Doc 10 §3).
 *
 * The services are exported because later sessions reach for them — Session 17's
 * role–permission mapping has to ask which applications a client has enabled
 * (Doc 02 §6), and that answer lives in `ClientApplicationsService`.
 */

import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { DatabaseModule } from '../database/database.module';
import { ClientAdminService } from './client-admin.service';
import { ClientApplicationsService } from './client-applications.service';
import { ClientsController } from './clients.controller';
import { ClientsService } from './clients.service';

@Module({
  imports: [AuditModule, DatabaseModule],
  controllers: [ClientsController],
  providers: [ClientsService, ClientApplicationsService, ClientAdminService],
  exports: [ClientsService, ClientApplicationsService],
})
export class ClientsModule {}
