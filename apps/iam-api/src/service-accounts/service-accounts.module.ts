/**
 * The `/iam/service-accounts` surface (Doc 06 §10).
 *
 * Its own module rather than a third controller in `AuthModule`, because what it
 * does is administer rows: create, list, rotate, revoke, audited under the
 * caller's RLS context. That is the shape of Session 13's registry and Session
 * 16's user admin, not the shape of the token machinery. The exchange those
 * credentials feed — `POST /auth/token` — stays in `AuthModule` where the
 * signing keys are.
 *
 * `DatabaseModule` and `AuditModule` are the only imports: every query runs on
 * the ambient request transaction (`entityManager()`), the interim permission
 * check reads the RLS context that `TenantContextInterceptor` already put
 * there, and every mutation records itself through the one audit path
 * (Doc 10 §3).
 */

import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { DatabaseModule } from '../database/database.module';
import { ServiceAccountsController } from './service-accounts.controller';
import { ServiceAccountsService } from './service-accounts.service';

@Module({
  imports: [AuditModule, DatabaseModule],
  controllers: [ServiceAccountsController],
  providers: [ServiceAccountsService],
  exports: [ServiceAccountsService],
})
export class ServiceAccountsModule {}
