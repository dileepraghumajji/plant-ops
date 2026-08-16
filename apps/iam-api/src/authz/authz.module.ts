/**
 * The authorization core (Doc 04).
 *
 * Almost empty for now, and deliberately so: Sessions 21–22 fill it with the
 * resolution engine, the versioned grants cache and the real invalidation
 * publisher. What it holds today is the one piece those sessions cannot be
 * allowed to invent later — the invalidation *hook*, which several surfaces
 * already call from `afterCommit()` and whose ordering is the property Doc 04
 * §7.1 cares about.
 *
 * It imports nothing. That is what lets `AuthModule`, `ScopesModule` and
 * `UsersModule` all import it without a cycle, and it stays true in Session 21
 * only if the resolution engine's dependencies (`DatabaseModule`, `RedisModule`)
 * arrive as imports here rather than as a re-export of anything above.
 */

import { Module } from '@nestjs/common';
import { GrantInvalidationService } from './invalidation.service';

@Module({
  providers: [GrantInvalidationService],
  exports: [GrantInvalidationService],
})
export class AuthzModule {}
