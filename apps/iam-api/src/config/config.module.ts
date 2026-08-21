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
import { DeploymentController } from './deployment.controller';
import { DeploymentModeService } from './deployment-mode';
import { ENV } from './env.token';

@Global()
@Module({
  // `@Global()` applies to providers, not controllers; this one is registered
  // here because it sits next to the service it exposes, and because a module
  // of its own for one route would be a file to open on the way to nothing.
  controllers: [DeploymentController],
  providers: [
    { provide: ENV, useFactory: (): EnvConfig => loadEnv() },
    DeploymentModeService,
  ],
  exports: [ENV, DeploymentModeService],
})
export class ConfigModule {}
