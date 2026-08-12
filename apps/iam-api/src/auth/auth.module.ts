/**
 * The `/auth` surface and the token machinery behind it (Doc 03).
 *
 * Session 7 fills in the half that has no session state: key management, token
 * signing and verification, and the published JWKS. `TokenService` and
 * `KeysService` are exported because Session 8 builds login, sessions and the
 * `AuthGuard` on top of them, and Session 11 the service-account exchange —
 * all of which must sign with the same key set rather than grow their own.
 */

import { Module } from '@nestjs/common';
import { JwksController } from './jwks.controller';
import { KeysService } from './keys.service';
import { TokenService } from './token.service';

@Module({
  controllers: [JwksController],
  providers: [KeysService, TokenService],
  exports: [KeysService, TokenService],
})
export class AuthModule {}
