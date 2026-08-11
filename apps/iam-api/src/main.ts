import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { EnvValidationError, loadEnv, redactEnv } from '@plantops/config';
import { config as loadDotenv } from 'dotenv';
import { AppModule } from './app/app.module';

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

  const app = await NestFactory.create(AppModule, {
    logger: logLevelsFor(env.LOG_LEVEL),
  });
  const globalPrefix = 'api';
  app.setGlobalPrefix(globalPrefix);
  await app.listen(env.PORT);

  Logger.log(
    `🚀 iam-api (${env.NODE_ENV}) listening on http://localhost:${env.PORT}/${globalPrefix}`,
  );
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
  } else {
    Logger.error(error, undefined, 'Bootstrap');
  }
  process.exit(1);
});
