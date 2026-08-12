/**
 * The validated environment, as an injectable (Doc 08 §5).
 *
 * `loadEnv()` already memoizes per process, so this module exists for
 * *substitutability* rather than caching: a test overrides `ENV` with a
 * fixture instead of mutating `process.env` and hoping nothing else read it
 * first. Nothing below this line should ever reach for `process.env` directly.
 */

import { Global, Module } from '@nestjs/common';
import { type EnvConfig, loadEnv } from '@plantops/config';

/** Injection token for {@link EnvConfig}. */
export const ENV = Symbol('ENV');

@Global()
@Module({
  providers: [{ provide: ENV, useFactory: (): EnvConfig => loadEnv() }],
  exports: [ENV],
})
export class ConfigModule {}
