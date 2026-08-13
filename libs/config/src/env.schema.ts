/**
 * Validated environment schema (Doc 08 §5).
 *
 * Boot fails here, loudly, rather than three layers deep at the first query:
 * a missing `DATABASE_DIRECT_URL` or a malformed signing key is a startup
 * error, not a runtime surprise. Defaults come from `@plantops/contracts` so
 * the IAM and every consuming module agree on the same numbers.
 */

import {
  ACCESS_TOKEN_TTL_SECONDS,
  GRANTS_CACHE_MAX_TTL_SECONDS,
  GRANTS_CACHE_TTL_SECONDS,
  IAM_ISSUER,
  REFRESH_REUSE_GRACE_MAX_SECONDS,
  REFRESH_REUSE_GRACE_MIN_SECONDS,
  REFRESH_REUSE_GRACE_SECONDS,
  REFRESH_TOKEN_TTL_SECONDS,
  SERVICE_ACCESS_TOKEN_MAX_TTL_SECONDS,
  SERVICE_ACCESS_TOKEN_TTL_SECONDS,
} from '@plantops/contracts';
import { z } from 'zod';

/** Minimum length for the out-of-band platform bootstrap secret (Doc 07 §8). */
export const BOOTSTRAP_SECRET_MIN_LENGTH = 32;

/**
 * Throttle and readiness defaults.
 *
 * These stay here rather than in `@plantops/contracts`: contracts holds values
 * the IAM and its consumers must *agree* on (token TTLs, the skew leeway), and
 * a rate limit is not one of them — it is per-deployment ops tuning that no
 * consuming module can observe.
 */
export const DEFAULT_RATE_LIMIT_WINDOW_SECONDS = 60;
export const DEFAULT_RATE_LIMIT_MAX_REQUESTS = 120;
export const DEFAULT_READINESS_TIMEOUT_MS = 2_000;

/**
 * Account-lockout and password-reset policy (Doc 03 §7–8).
 *
 * Here rather than in `@plantops/contracts` for the same reason the rate limits
 * are: no consuming module can observe either value. A module sees a locked
 * account only as a login it never gets a token from, and a reset token never
 * leaves the IAM at all.
 *
 * **Five attempts**, because the threshold trades two failures against each
 * other. Too high and it stops bounding an online guessing attack; too low and
 * a shared gate terminal with a sticky keyboard locks a shift supervisor out
 * mid-shift. Five is the common floor in NIST 800-63B-adjacent practice and
 * leaves room for the ordinary "wrong one of my two passwords" twice over.
 *
 * **One hour**, because a reset link is a bearer credential sitting in an inbox.
 * Long enough to survive a delivery delay and a walk back to the office;
 * short enough that a mailbox compromised next week finds nothing usable.
 */
export const DEFAULT_LOGIN_MAX_FAILED_ATTEMPTS = 5;
export const MAX_LOGIN_MAX_FAILED_ATTEMPTS = 100;
export const DEFAULT_PASSWORD_RESET_TTL_SECONDS = 3_600;
export const MAX_PASSWORD_RESET_TTL_SECONDS = 86_400;

const NODE_ENVS = ['development', 'test', 'production'] as const;
export type NodeEnv = (typeof NODE_ENVS)[number];

const LOG_LEVELS = ['error', 'warn', 'log', 'debug', 'verbose'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

/** Postgres connection string, either accepted scheme. */
const postgresUrl = (label: string) =>
  z
    .string()
    .trim()
    .min(1, `${label} is required`)
    .refine((value) => hasScheme(value, ['postgres:', 'postgresql:']), {
      message: `${label} must be a postgres:// or postgresql:// connection string`,
    });

const redisUrl = z
  .string()
  .trim()
  .min(1, 'REDIS_URL is required')
  .refine((value) => hasScheme(value, ['redis:', 'rediss:']), {
    message: 'REDIS_URL must be a redis:// or rediss:// connection string',
  });

/**
 * A usable connection string: right scheme *and* a host. The host check
 * matters — `new URL('redis:6379')` parses happily as an opaque URL, and a
 * scheme-only check would wave it through to fail at connect time instead.
 */
function hasScheme(value: string, schemes: string[]): boolean {
  try {
    const url = new URL(value);
    return schemes.includes(url.protocol) && url.host !== '';
  } catch {
    return false;
  }
}

/**
 * PEM key material. Secret stores and `.env` files routinely carry keys with
 * literal `\n` sequences instead of real newlines; unescape before validating
 * so a correct key is not rejected for its transport encoding.
 */
const pem = (label: string, marker: string) =>
  z
    .string()
    .min(1, `${label} is required`)
    .transform((value) => value.replace(/\\n/g, '\n').trim())
    .refine((value) => value.includes(marker), {
      message: `${label} must be a PEM-encoded key containing "${marker}"`,
    });

/** `kid` → PEM map of public keys retained for rotation (Doc 03 §1). */
const retiredPublicKeys = z
  .string()
  .transform((value, ctx) => {
    if (value.trim() === '') return {} as Record<string, string>;
    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch {
      ctx.addIssue({
        code: 'custom',
        message:
          'JWT_RETIRED_PUBLIC_KEYS must be a JSON object mapping kid → PEM public key',
      });
      return z.NEVER;
    }
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      Array.isArray(parsed) ||
      !Object.values(parsed).every((v) => typeof v === 'string')
    ) {
      ctx.addIssue({
        code: 'custom',
        message:
          'JWT_RETIRED_PUBLIC_KEYS must be a JSON object mapping kid → PEM public key',
      });
      return z.NEVER;
    }
    return Object.fromEntries(
      Object.entries(parsed as Record<string, string>).map(([kid, key]) => [
        kid,
        key.replace(/\\n/g, '\n').trim(),
      ]),
    );
  })
  .default({});

const seconds = (label: string, fallback: number, max?: number) => {
  let schema = z.coerce
    .number({ error: `${label} must be a number of seconds` })
    .int(`${label} must be a whole number of seconds`)
    .positive(`${label} must be greater than zero`);
  if (max !== undefined) {
    schema = schema.max(max, `${label} must be at most ${max} seconds`);
  }
  return schema.default(fallback);
};

const boolish = (fallback: boolean) =>
  z
    .enum(['true', 'false', '1', '0'], {
      error: 'must be one of: true, false, 1, 0',
    })
    .transform((value) => value === 'true' || value === '1')
    .default(fallback);

const millis = (label: string, fallback: number) =>
  z.coerce
    .number({ error: `${label} must be a number of milliseconds` })
    .int(`${label} must be a whole number of milliseconds`)
    .positive(`${label} must be greater than zero`)
    .default(fallback);

/**
 * Comma-separated allow-list. Empty means *no* cross-origin browser access,
 * which is the right default for an API whose only browser client is deployed
 * separately and must be named explicitly.
 */
const originList = z
  .string()
  .default('')
  .transform((value) =>
    value
      .split(',')
      .map((origin) => origin.trim())
      .filter((origin) => origin !== ''),
  )
  .pipe(
    z.array(
      z
        .string()
        .refine((origin) => origin === '*' || hasScheme(origin, ['http:', 'https:']), {
          message:
            'CORS_ALLOWED_ORIGINS entries must be http(s) origins (or "*"), comma-separated',
        }),
    ),
  );

export const envSchema = z.object({
  NODE_ENV: z.enum(NODE_ENVS).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  LOG_LEVEL: z.enum(LOG_LEVELS).default('log'),

  /**
   * Application connection — the Supabase **pooler** endpoint. TypeORM must
   * disable prepared statements against PgBouncer transaction mode (Doc 07 §2).
   */
  DATABASE_URL: postgresUrl('DATABASE_URL'),
  /** **Direct** (non-pooled) endpoint; migrations only (Doc 07 §2). */
  DATABASE_DIRECT_URL: postgresUrl('DATABASE_DIRECT_URL'),
  DATABASE_SSL: boolish(false),

  REDIS_URL: redisUrl,
  /**
   * Namespace for every key this deployment writes. Managed Redis is routinely
   * shared between staging and production; without a prefix, a staging deploy
   * evicting `perms:*` silently invalidates production's grants cache.
   */
  REDIS_KEY_PREFIX: z.string().trim().default('plantops:'),

  /**
   * Trust `X-Forwarded-For` when resolving the client IP.
   *
   * On in exactly one situation: the app sits behind a proxy that *rewrites*
   * the header (Railway, a load balancer). On elsewhere and every caller
   * chooses their own rate-limit bucket by sending the header themselves —
   * which is the same as having no IP rate limiting at all.
   */
  TRUST_PROXY: boolish(false),

  /** Browser origins allowed to call the API; empty disables CORS entirely. */
  CORS_ALLOWED_ORIGINS: originList,

  RATE_LIMIT_ENABLED: boolish(true),
  /** Fixed-window length for the global throttle (Doc 06 §2 — 429). */
  RATE_LIMIT_WINDOW_SECONDS: seconds(
    'RATE_LIMIT_WINDOW_SECONDS',
    DEFAULT_RATE_LIMIT_WINDOW_SECONDS,
  ),
  /**
   * Requests per window per caller. Deliberately loose: this is the blanket
   * limit protecting the process, not the credential-stuffing defence — Session
   * 8 tightens `/auth/*` to single digits with `@RateLimit`.
   */
  RATE_LIMIT_MAX_REQUESTS: z.coerce
    .number({ error: 'RATE_LIMIT_MAX_REQUESTS must be a number' })
    .int('RATE_LIMIT_MAX_REQUESTS must be a whole number')
    .positive('RATE_LIMIT_MAX_REQUESTS must be greater than zero')
    .default(DEFAULT_RATE_LIMIT_MAX_REQUESTS),

  /**
   * Per-dependency budget for `/ready`. A readiness probe that blocks on a
   * hung Postgres never answers, and the orchestrator reads "no answer" as a
   * timeout it cannot explain; answering 503 quickly is the useful behaviour.
   */
  READINESS_TIMEOUT_MS: millis('READINESS_TIMEOUT_MS', DEFAULT_READINESS_TIMEOUT_MS),

  JWT_ISSUER: z.string().trim().min(1).default(IAM_ISSUER),
  /** `kid` of the key currently signing (Doc 03 §1). */
  JWT_SIGNING_KEY_ID: z.string().trim().min(1, 'JWT_SIGNING_KEY_ID is required'),
  JWT_PRIVATE_KEY: pem('JWT_PRIVATE_KEY', 'PRIVATE KEY'),
  JWT_PUBLIC_KEY: pem('JWT_PUBLIC_KEY', 'PUBLIC KEY'),
  /**
   * Public keys kept in JWKS after a rotation, so tokens signed by the previous
   * key still verify until they expire (Doc 03 §1 step 4).
   */
  JWT_RETIRED_PUBLIC_KEYS: retiredPublicKeys,

  ACCESS_TOKEN_TTL_SECONDS: seconds(
    'ACCESS_TOKEN_TTL_SECONDS',
    ACCESS_TOKEN_TTL_SECONDS,
  ),
  REFRESH_TOKEN_TTL_SECONDS: seconds(
    'REFRESH_TOKEN_TTL_SECONDS',
    REFRESH_TOKEN_TTL_SECONDS,
  ),
  /** Doc 03 §5 caps service tokens at 5 min — the TTL *is* the kill window. */
  SERVICE_TOKEN_TTL_SECONDS: seconds(
    'SERVICE_TOKEN_TTL_SECONDS',
    SERVICE_ACCESS_TOKEN_TTL_SECONDS,
    SERVICE_ACCESS_TOKEN_MAX_TTL_SECONDS,
  ),
  /** Concurrent-refresh grace window, 10–30 s (Doc 03 §4). */
  REFRESH_REUSE_GRACE_SECONDS: seconds(
    'REFRESH_REUSE_GRACE_SECONDS',
    REFRESH_REUSE_GRACE_SECONDS,
    REFRESH_REUSE_GRACE_MAX_SECONDS,
  ).refine((value) => value >= REFRESH_REUSE_GRACE_MIN_SECONDS, {
    message: `REFRESH_REUSE_GRACE_SECONDS must be at least ${REFRESH_REUSE_GRACE_MIN_SECONDS} seconds`,
  }),
  /**
   * Consecutive failed logins that lock an account (Doc 03 §8).
   *
   * Floored at 1 rather than allowing 0 to mean "off". A security control with
   * an off switch spelled as a falsy default is one that gets disabled by an
   * empty environment variable; an operator who genuinely wants no lockout can
   * say so out loud with a large number.
   */
  LOGIN_MAX_FAILED_ATTEMPTS: z.coerce
    .number({ error: 'LOGIN_MAX_FAILED_ATTEMPTS must be a number' })
    .int('LOGIN_MAX_FAILED_ATTEMPTS must be a whole number')
    .min(1, 'LOGIN_MAX_FAILED_ATTEMPTS must be at least 1')
    .max(
      MAX_LOGIN_MAX_FAILED_ATTEMPTS,
      `LOGIN_MAX_FAILED_ATTEMPTS must be at most ${MAX_LOGIN_MAX_FAILED_ATTEMPTS}`,
    )
    .default(DEFAULT_LOGIN_MAX_FAILED_ATTEMPTS),

  /** How long a password-reset token stays usable; ≤24 h (Doc 03 §7). */
  PASSWORD_RESET_TTL_SECONDS: seconds(
    'PASSWORD_RESET_TTL_SECONDS',
    DEFAULT_PASSWORD_RESET_TTL_SECONDS,
    MAX_PASSWORD_RESET_TTL_SECONDS,
  ),

  /** Safety net behind invalidation; ≤10 min (Doc 04 §6). */
  GRANTS_CACHE_TTL_SECONDS: seconds(
    'GRANTS_CACHE_TTL_SECONDS',
    GRANTS_CACHE_TTL_SECONDS,
    GRANTS_CACHE_MAX_TTL_SECONDS,
  ),

  /**
   * Secret for the very first platform identity (Doc 07 §8). Supplied
   * out-of-band, never committed, rotated immediately after first use — and
   * never logged (see `redactEnv`).
   */
  PLATFORM_BOOTSTRAP_SECRET: z
    .string()
    .min(
      BOOTSTRAP_SECRET_MIN_LENGTH,
      `PLATFORM_BOOTSTRAP_SECRET must be at least ${BOOTSTRAP_SECRET_MIN_LENGTH} characters`,
    ),
});

/** The validated, fully-defaulted environment. */
export type EnvConfig = z.infer<typeof envSchema>;

/** Every variable the schema reads — used by the `.env.example` drift test. */
export const ENV_KEYS = Object.keys(envSchema.shape) as Array<keyof EnvConfig>;

/**
 * Values that must never reach a log line, an audit payload, or an error
 * message (Doc 03 §7, Doc 07 §8, Doc 10 §8).
 */
export const SECRET_ENV_KEYS = [
  'DATABASE_URL',
  'DATABASE_DIRECT_URL',
  'REDIS_URL',
  'JWT_PRIVATE_KEY',
  'PLATFORM_BOOTSTRAP_SECRET',
] as const satisfies readonly (keyof EnvConfig)[];

export type SecretEnvKey = (typeof SECRET_ENV_KEYS)[number];
