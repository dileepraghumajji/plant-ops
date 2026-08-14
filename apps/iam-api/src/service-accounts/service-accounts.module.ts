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
 * `DatabaseModule` is the only import: every query runs on the ambient request
 * transaction (`entityManager()`), and the interim permission check reads the
 * RLS context that `TenantContextInterceptor` already put there.
 */

import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { ServiceAccountsController } from './service-accounts.controller';
import { ServiceAccountsService } from './service-accounts.service';

@Module({
  imports: [DatabaseModule],
  controllers: [ServiceAccountsController],
  providers: [ServiceAccountsService],
  exports: [ServiceAccountsService],
})
export class ServiceAccountsModule {}
