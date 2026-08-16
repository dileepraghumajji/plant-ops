/**
 * The HTTP surface of the authorization core (Doc 06 §11).
 *
 * Split from {@link AuthzModule} for one structural reason, stated there in
 * full: `AuthModule` imports the core (for the grant-invalidation hook its
 * account-state transitions fire), so the core cannot import `AuthModule` back —
 * and `POST /iam/introspect` needs `TokenService`, which is `AuthModule`'s.
 *
 * This module is the leaf that resolves it. It imports both, is imported only by
 * `AppModule`, and exports nothing: the resolution endpoints are consumed over
 * HTTP by other processes, never by another module in this one.
 *
 * `DatabaseModule` is not imported. Nothing here holds a connection — the
 * controller passes `entityManager()`, the request transaction
 * `TenantContextInterceptor` opened, into a resolver that takes its executor as
 * a parameter (`docs/adr/0001-permission-guard-connection-strategy.md`).
 */

import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AuthzModule } from './authz.module';
import { AuthzController } from './authz.controller';
import { IntrospectService } from './introspect.service';

@Module({
  imports: [AuthModule, AuthzModule],
  controllers: [AuthzController],
  providers: [IntrospectService],
})
export class AuthzApiModule {}
