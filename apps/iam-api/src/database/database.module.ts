/**
 * The single application data source, shared process-wide.
 *
 * Global for the same reason as {@link RedisModule}: its consumers (the
 * per-request transaction wrapper, `/ready`, and every feature module from
 * Session 7 on) sit in unrelated branches of the module graph, and a second
 * pool per feature would multiply connections against a pooler whose
 * connection ceiling is the constraint being managed (Doc 07 §2).
 */

import { Global, Module } from '@nestjs/common';
import { DatabaseService } from './database.service';

@Global()
@Module({
  providers: [DatabaseService],
  exports: [DatabaseService],
})
export class DatabaseModule {}
