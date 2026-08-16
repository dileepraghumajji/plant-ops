/**
 * The client-admin user surface (Doc 06 §8, Doc 01 §3.6).
 *
 * `AuditModule` and `DatabaseModule` for the reason `RolesModule` gives:
 * nothing here holds a connection of its own — every statement runs on the
 * request transaction `TenantContextInterceptor` opened — and every mutation
 * records itself through the one audit path (Doc 10 §3).
 *
 * `AuthModule` is the third, and it is the interesting one. `PATCH
 * /iam/users/:id` is where an administrator locks or disables somebody, and that
 * transition belongs to `AccountStateService` — which lives beside the login
 * path that enforces it, because the failed-attempt policy reaches the same
 * state by another road and the two must not drift into two vocabularies
 * (migration 0014). Importing the module the state machine lives in is what
 * keeps this surface a *caller* of that rule rather than a second copy of it.
 *
 * `UsersService` is exported: Session 20's bindings API has to resolve a user and
 * check they belong to the caller's client before granting them anything
 * (Doc 02 §6).
 *
 * `BulkUploadService` is a sibling rather than a method on `UsersService`, and
 * not exported. It shares the create path's *validator* — `createUserSchema`,
 * literally the same object — but nothing else: it writes one statement for N
 * rows, adjudicates instead of throwing, and produces a report rather than a
 * DTO. Folding it in would have put a second, differently-shaped write path
 * behind the file every other user operation lives in, for no reuse beyond the
 * table name.
 */

import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { DatabaseModule } from '../database/database.module';
import { BulkUploadService } from './bulk-upload.service';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';

@Module({
  imports: [AuditModule, AuthModule, DatabaseModule],
  controllers: [UsersController],
  providers: [UsersService, BulkUploadService],
  exports: [UsersService],
})
export class UsersModule {}
