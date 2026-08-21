import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { EnvValidationError, loadEnv, redactEnv } from '@plantops/config';
import {
  RlsStartupCheckError,
  assertRlsEnforceable,
  createAppDataSource,
} from '@plantops/db';
import { config as loadDotenv } from 'dotenv';
import { AppModule } from './app/app.module';
import { NEST_APP_OPTIONS, hardenExpress } from './app/http-hardening';
import { KeyConfigurationError, KeysService } from './auth/keys.service';
import { DeploymentModeError } from './config/deployment-mode';

/**
 * Local `.env` support. A no-op when the file is absent, and it never
 * overrides variables the platform already set — deployed environments get
 * their configuration from the secret store (Doc 08 §5).
 */
loadDotenv();

async function bootstrap() {
  // Validate the environment before anything else starts: a misconfigured
  // deployment must die here, not at its first query (Doc 08 §5).
  const env = loadEnv();

  // Then prove the database connection can actually enforce RLS, before a
  // single request is served (Doc 07 §5, §5.1).
  //
  // This check exists because every RLS bypass is *silent*: policies do not
  // error when they are skipped, they just stop filtering, and the API goes on
  // returning perfectly plausible rows that belong to other tenants. There is
  // no runtime symptom to notice later — so it is checked once, loudly, here.
  //
  // Its own connection, disposed immediately: the assertions are about the
  // credentials in DATABASE_URL, and nothing should be able to serve a request
  // before they have passed.
  const probe = createAppDataSource(env);
  await probe.initialize();
  try {
    await assertRlsEnforceable(probe);
  } finally {
    await probe.destroy();
  }

  // And that the signing keys are usable, before the first token is asked for
  // (Doc 03 §1).
  //
  // `KeysService` parses lazily so the many tests that boot the module need not
  // carry a real keypair; that laziness is exactly why a deployment needs this
  // line. Without it a malformed key, or a public key that is not the pair of
  // the private one, surfaces at the first login rather than at boot — and the
  // mismatched-pair case does not surface at all here: signing succeeds, JWKS
  // serves a valid-looking key, and every token this instance issues fails
  // verification in every consumer.
  new KeysService(env).assertKeysUsable();

  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    ...NEST_APP_OPTIONS,
    logger: logLevelsFor(env.LOG_LEVEL),
  });

  // Body limits, `x-powered-by` and `nosniff`. Shared with the test harness so
  // the header assertions there are about this process (`app/http-hardening.ts`).
  hardenExpress(app);

  // No global prefix: Doc 06 §1 fixes the paths as `/iam`, `/auth`, `/health`
  // and `/ready`, and controllers declare those themselves. A prefix here
  // would silently move every documented path.

  // Lets `onModuleDestroy` / `onApplicationShutdown` run — which is what closes
  // the database pool and Redis connection on SIGTERM. Without it a rolling
  // deploy leaks a pool per replacement instance until the pooler refuses new
  // connections.
  app.enableShutdownHooks();

  // Express's own `trust proxy`, driven by the same flag the throttle reads,
  // so `req.ip` cannot mean one thing to the framework and another to the
  // guard keyed on it.
  app.set('trust proxy', env.TRUST_PROXY);

  if (env.CORS_ALLOWED_ORIGINS.length > 0) {
    app.enableCors({
      origin: [...env.CORS_ALLOWED_ORIGINS],
      // The admin UI sends `Authorization`, not cookies; credentials stay off
      // so a wildcard-adjacent misconfiguration cannot become a session leak.
      credentials: false,
    });
  }

  await app.listen(env.PORT);

  Logger.log(`🚀 iam-api (${env.NODE_ENV}) listening on http://localhost:${env.PORT}`);
  // Only ever log the redacted view — the raw config holds connection strings,
  // the signing key, and the bootstrap secret (Doc 07 §8, Doc 10 §8).
  Logger.debug(redactEnv(env), 'Env');
}

/** Nest's logger takes the enabled levels, not a threshold. */
function logLevelsFor(level: string) {
  const order = ['error', 'warn', 'log', 'debug', 'verbose'] as const;
  const index = order.indexOf(level as (typeof order)[number]);
  return order.slice(0, index + 1);
}

bootstrap().catch((error: unknown) => {
  if (error instanceof EnvValidationError) {
    // A stack trace adds nothing here; the operator needs the variable names.
    Logger.error(error.message, undefined, 'Bootstrap');
  } else if (
    error instanceof RlsStartupCheckError ||
    error instanceof KeyConfigurationError ||
    error instanceof DeploymentModeError
  ) {
    // Likewise: the operator needs the failed assertions and the fix, not a
    // stack through NestFactory.
    Logger.error(error.message, undefined, 'Bootstrap');
  } else {
    Logger.error(error, undefined, 'Bootstrap');
  }
  process.exit(1);
});
