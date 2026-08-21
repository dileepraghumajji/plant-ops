/**
 * Fail-fast environment loading (Doc 08 §5).
 *
 * `parseEnv` is pure and takes its source explicitly so it can be tested
 * without touching `process.env`; `loadEnv` is the memoized process-wide
 * accessor applications use.
 */

import { z } from 'zod';
import {
  ENV_KEYS,
  type EnvConfig,
  SECRET_ENV_KEYS,
  type SecretEnvKey,
  envSchema,
} from './env.schema.js';

/** Anything string-keyed and string-valued — `process.env`, or a test fixture. */
export type EnvSource = Record<string, string | undefined>;

/**
 * Thrown when the environment is invalid. The message lists every problem at
 * once (fixing them one boot at a time is miserable) and never echoes a value
 * back — an invalid `DATABASE_URL` still contains a password.
 */
export class EnvValidationError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(
      `Invalid environment configuration:\n${issues
        .map((issue) => `  - ${issue}`)
        .join('\n')}`,
    );
    this.name = 'EnvValidationError';
    this.issues = issues;
  }
}

/**
 * Validates a source of environment variables.
 *
 * @throws {EnvValidationError} listing every invalid or missing variable.
 */
export function parseEnv(source: EnvSource = process.env): EnvConfig {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    throw new EnvValidationError(formatIssues(result.error, source));
  }
  return Object.freeze(result.data);
}

function formatIssues(error: z.ZodError, source: EnvSource): string[] {
  return error.issues.map((issue) => {
    const name = issue.path.join('.') || '(root)';
    const missing = issue.path.length === 1 && source[name] === undefined;
    return `${name}: ${missing ? 'is required but was not set' : issue.message}`;
  });
}

let cached: EnvConfig | undefined;

/**
 * Returns the validated environment, parsing it once per process.
 *
 * Call this at the very top of `main()` so a misconfigured deployment dies at
 * boot instead of at the first request.
 */
export function loadEnv(source: EnvSource = process.env): EnvConfig {
  cached ??= parseEnv(source);
  return cached;
}

/** Drops the memoized environment. For tests and nothing else. */
export function resetEnvCache(): void {
  cached = undefined;
}

const REDACTED = '[redacted]';

/**
 * A log-safe view of the environment: connection strings (which carry
 * passwords), the signing key, and the bootstrap secret are masked.
 *
 * The bootstrap secret in particular must never appear in logs or audit
 * payloads (Doc 07 §8, Doc 10 §8) — log this, never the config object.
 */
export function redactEnv(env: EnvConfig): Record<string, unknown> {
  const secrets = new Set<string>(SECRET_ENV_KEYS);
  // Driven by `ENV_KEYS` rather than by the object's own entries, so an
  // *unset optional* variable is reported as `undefined` instead of vanishing.
  // The difference is not cosmetic: "DATABASE_CA_CERT: undefined" in a boot log
  // is the answer to a `SELF_SIGNED_CERT_IN_CHAIN` failure, and an absent line
  // is indistinguishable from a variable nobody thought to look for.
  return Object.fromEntries(
    ENV_KEYS.map((key) => [
      key,
      secrets.has(key) ? REDACTED : redactNonSecret(key, env[key]),
    ]),
  );
}

/** Key *material* is masked even when the key itself is public. */
function redactNonSecret(key: string, value: unknown): unknown {
  if (value === undefined) return undefined;
  // Public, but pages long — the fact that one is configured is the whole
  // signal; the bytes are noise that pushes the useful lines off the screen.
  if (key === 'JWT_PUBLIC_KEY' || key === 'DATABASE_CA_CERT') return '[pem]';
  if (key === 'JWT_RETIRED_PUBLIC_KEYS') {
    return Object.keys(value as Record<string, string>);
  }
  return value;
}

export function isSecretEnvKey(key: string): key is SecretEnvKey {
  return (SECRET_ENV_KEYS as readonly string[]).includes(key);
}
