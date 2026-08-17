/**
 * Everything `PermissionGuard` depends on, exported so `AppModule` can
 * construct it (Doc 04 §8, Doc 08 §4).
 *
 * The same shape `AuthModule` uses for `AuthGuard`, and for the same reason
 * stated there: **the order of the global guards is a security property**, so
 * they are all declared as `APP_GUARD` in one array in `app.module.ts` rather
 * than scattered across the modules that supply their collaborators. What lives
 * here is the collaborators.
 *
 * Three bindings and one class:
 *
 * - **{@link GRANTS_SOURCE} → {@link IamGrantsSource}.** The IAM resolves grants
 *   from its own engine on its own connection
 *   (`docs/adr/0001-permission-guard-connection-strategy.md`). A future module
 *   binds a cached `/iam/permissions/resolve` call instead, and nothing else
 *   about the guard changes — that substitution is the whole reason the guard
 *   depends on a port.
 * - **{@link VERIFIED_CLAIMS_SOURCE} → {@link RequestClaimsSource}.** The read
 *   side of the sink `AuthGuard` writes through.
 * - **{@link DENIAL_AUDITOR} → {@link GuardDenialAuditor}.** Optional in the
 *   library; bound here because the IAM owns `audit_trail` (Doc 10 §3).
 * - **{@link ScopeResolver}**, which is a plain class rather than a token, and
 *   is exported so both the guard and any service that wants Doc 04 §5's
 *   `allowedPaths` resolve the same instance.
 *
 * `AuthzModule` is imported for the resolution engine and the grants cache;
 * `AuditModule` and `DatabaseModule` are leaves. Nothing here imports
 * `AuthModule`, so the cycle `authz.module.ts` guards against stays impossible.
 */

import { Module } from '@nestjs/common';
import {
  DENIAL_AUDITOR,
  GRANTS_SOURCE,
  ScopeResolver,
  VERIFIED_CLAIMS_SOURCE,
} from '@plantops/auth-kit';
import { AuditModule } from '../audit/audit.module';
import { DatabaseModule } from '../database/database.module';
import { AuthzModule } from './authz.module';
import { GuardDenialAuditor } from './denial-auditor';
import { IamGrantsSource } from './grants-source';
import { RequestClaimsSource } from './request-claims.source';

@Module({
  imports: [AuditModule, AuthzModule, DatabaseModule],
  providers: [
    IamGrantsSource,
    RequestClaimsSource,
    GuardDenialAuditor,
    ScopeResolver,
    { provide: GRANTS_SOURCE, useExisting: IamGrantsSource },
    { provide: VERIFIED_CLAIMS_SOURCE, useExisting: RequestClaimsSource },
    { provide: DENIAL_AUDITOR, useExisting: GuardDenialAuditor },
  ],
  exports: [ScopeResolver, GRANTS_SOURCE, VERIFIED_CLAIMS_SOURCE, DENIAL_AUDITOR],
})

export class PermissionGuardModule {}
