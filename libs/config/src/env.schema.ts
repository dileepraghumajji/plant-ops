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
 * Request body ceilings (Doc 06 §1).
 *
 * Express's own default is 100 kB applied to everything, which is the wrong
 * number twice over: too generous for `/auth/login`, the one unauthenticated
 * path that pays for an argon2id hash before it can refuse anything, and too
 * small for a manifest upload, which carries an application's whole permission
 * and nav catalogue in one document.
 *
 * So the limit is stated rather than inherited, and the two routes that carry a
 * *document* rather than a form get their own. **64 kB** covers every other body
 * on the surface with room to spare — the largest is
 * `PUT /iam/roles/:id/permissions`, a few hundred uuids.
 *
 * **4 MB** is not a guess: `manifest.dto.ts` caps a manifest at 200 permissions
 * and 200 nav nodes, and every string in it has a maximum length, so the largest
 * document the schema will *accept* is computable — about 2.1 MB, dominated by
 * 200 nodes each carrying 50 `requires` keys of 160 characters. The ceiling sits
 * above that deliberately, which buys the property worth having: a manifest is
 * never refused for its size before it can be refused for its contents, so an
 * operator debugging an upload always gets the error that names the field.
 *
 * **1 MB** for `POST /iam/users/bulk` is the same computation on a smaller
 * document. `MAX_BULK_USER_ROWS` caps it at 500 rows, and a row's fields are
 * bounded by the same schema the single-user create uses — a 320-character
 * address, a 160-character name, a 40-character phone and a status word — so the
 * largest upload the schema accepts is roughly 500 × 600 characters, under
 * 300 kB, and about twice that once a CSV's line breaks are JSON-escaped. 1 MB
 * sits above that for the same reason the manifest's ceiling sits above 2.1 MB:
 * a bulk upload should be refused for its row count, which names the problem,
 * rather than for its byte count, which does not.
 *
 * All three are capped: an operator raising a limit is tuning for a real
 * payload, and a limit large enough to matter as a memory-exhaustion lever
 * should have to be argued for rather than typed into an environment variable.
 */
export const DEFAULT_REQUEST_BODY_LIMIT_BYTES = 65_536;
export const MAX_REQUEST_BODY_LIMIT_BYTES = 1_048_576;
export const DEFAULT_MANIFEST_BODY_LIMIT_BYTES = 4_194_304;
export const MAX_MANIFEST_BODY_LIMIT_BYTES = 16_777_216;
export const DEFAULT_BULK_UPLOAD_BODY_LIMIT_BYTES = 1_048_576;
export const MAX_BULK_UPLOAD_BODY_LIMIT_BYTES = 4_194_304;

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

/**
 * The binding-expiry sweep (Doc 04 §7 last row, Doc 01 §4.5).
 *
 * **Sixty seconds.** The sweep is not what makes an expired binding stop
 * working — `resolve()` filters on `expires_at` directly, so the database stops
 * honouring it on the second it lapses. The sweep exists to evict the *cache*
 * entries that were written while it was still valid, and the worst case it has
 * to beat is `GRANTS_CACHE_TTL_SECONDS`, which would evict them anyway. So the
 * interval is chosen to make the sweep the fast path rather than the safety net:
 * a minute turns a ten-minute staleness bound into a one-minute one, at the cost
 * of one index scan over an index that is empty in steady state (migration 0016).
 *
 * **Zero disables it**, which is the one place in this file a falsy value is
 * allowed to mean "off" — unlike `LOGIN_MAX_FAILED_ATTEMPTS`, whose comment
 * argues the opposite. The difference is what an accidental disable costs. A
 * disabled lockout removes a control with no backstop behind it; a disabled
 * sweep falls back to the grants TTL, which is the bound Doc 04 §7 already
 * accepts by design. Tests need the off switch precisely because it is safe:
 * a timer firing inside an integration run makes cache assertions
 * non-deterministic.
 *
 * **Five hundred rows per tenant per pass.** A cap so one tenant expiring a
 * mass-provisioned batch cannot hold the transaction — and the sweep's Redis
 * fan-out — open behind every other tenant's handful of rows. The remainder is
 * not lost: it stays `expiry_swept_at is null` and the next pass claims it.
 */
export const DEFAULT_EXPIRY_SWEEP_INTERVAL_SECONDS = 60;
export const MAX_EXPIRY_SWEEP_INTERVAL_SECONDS = 3_600;
export const DEFAULT_EXPIRY_SWEEP_BATCH_SIZE = 500;
export const MAX_EXPIRY_SWEEP_BATCH_SIZE = 5_000;

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

/**
 * A PEM certificate bundle — one or more `CERTIFICATE` blocks.
 *
 * Separate from {@link pem} because the failure it guards against is different.
 * `pem` protects key *material*; this protects a trust anchor, and the way that
 * one goes wrong is being pasted as the wrong artefact entirely — a leaf
 * certificate instead of a root, or a private key that happened to be next to
 * it in the downloads folder. Requiring the `CERTIFICATE` marker catches the
 * second immediately; the first surfaces at the first connection, which is
 * where a trust decision belongs anyway.
 */
const certificateChain = (label: string) =>
  z
    .string()
    .transform((value) => value.replace(/\\n/g, '\n').trim())
    .refine((value) => value.includes('BEGIN CERTIFICATE'), {
      message: `${label} must be a PEM-encoded certificate containing "BEGIN CERTIFICATE"`,
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

const bytes = (label: string, fallback: number, max: number) =>
  z.coerce
    .number({ error: `${label} must be a number of bytes` })
    .int(`${label} must be a whole number of bytes`)
    .positive(`${label} must be greater than zero`)
    .max(max, `${label} must be at most ${max} bytes`)
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
   * The build this process *is*, reported by `/health` (Doc 11 §8, gap 8).
   *
   * Support for any install begins with "what version are you on", and for a
   * self-hosted one there is nobody else to ask: no dashboard we can open, no
   * deploy log we can read, often no network between us and the machine at all.
   * The answer has to come from the running process, over an endpoint that
   * needs no credential — which is what `/health` already is.
   *
   * **Stamped at build, not chosen at run.** Every image sets it from the
   * `APP_VERSION` build argument and labels itself with the same string, so the
   * version travels with the bytes and CI can assert that the tag it pushed and
   * the version the container reports are one value (`.github/workflows/ci.yml`,
   * the `images` job). Overriding it at run time is possible and never useful:
   * it changes what support is told, not what is deployed.
   *
   * The default names the situation rather than guessing a number. A developer
   * running `nx serve` has no build to report and `0.0.0-dev` says exactly that,
   * where `unknown` would read as a stamping failure and the package version
   * would read as a release that was never cut.
   */
  APP_VERSION: z
    .string()
    .trim()
    .min(1, 'APP_VERSION must not be empty')
    .default('0.0.0-dev'),

  /**
   * Application connection — the Supabase **pooler** endpoint. TypeORM must
   * disable prepared statements against PgBouncer transaction mode (Doc 07 §2).
   */
  DATABASE_URL: postgresUrl('DATABASE_URL'),
  /** **Direct** (non-pooled) endpoint; migrations only (Doc 07 §2). */
  DATABASE_DIRECT_URL: postgresUrl('DATABASE_DIRECT_URL'),
  DATABASE_SSL: boolish(false),
  /**
   * Trust anchor for the database's TLS certificate, PEM.
   *
   * Needed whenever the server presents a chain the system CA store does not
   * contain, which is the normal case on managed Postgres rather than the
   * exception. Measured against this project's Supabase pooler
   * (`aws-0-ap-south-1.pooler.supabase.com:5432`): the leaf is
   * `CN=*.pooler.supabase.com`, issued by `Supabase Intermediate 2021 CA`
   * under a self-signed `Supabase Root 2021 CA`. Node rejects that chain with
   * `SELF_SIGNED_CERT_IN_CHAIN`, so without this variable there is no working
   * value for `DATABASE_SSL` at all: `true` cannot connect, and `false` would
   * send the password in cleartext.
   *
   * Supplying the CA is the third option, and the only good one — verification
   * stays **on** (`rejectUnauthorized: true`), it is simply performed against
   * the right root. The usual `rejectUnauthorized: false` workaround encrypts
   * the connection while authenticating nothing, which in a system whose whole
   * premise is that the database is the last line of defence (Doc 07 §5.1) is
   * the wrong trade.
   *
   * Optional: a local docker-compose Postgres speaks no TLS, and a host whose
   * certificate chains to a public root needs no extra anchor.
   */
  DATABASE_CA_CERT: z.preprocess(
    // An empty string means "unset", not "a certificate of length zero".
    //
    // This is not defensiveness for its own sake. GitHub Actions resolves an
    // undefined `${{ vars.X }}` to the empty string rather than omitting the
    // variable, so a release job written to pass the anchor through would hand
    // this schema `''` in every environment that does not need one — and the
    // `BEGIN CERTIFICATE` check would then refuse to boot an environment whose
    // configuration is entirely correct.
    (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
    certificateChain('DATABASE_CA_CERT').optional(),
  ),

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

  /**
   * Serve the generated OpenAPI document at `GET /openapi.json`.
   *
   * Off by default in every environment, not merely in production — see
   * `openapi/openapi.controller.ts` for why a `NODE_ENV`-derived default is the
   * arrangement that eventually publishes one from production.
   */
  OPENAPI_ENABLED: boolish(false),

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

  /** Ceiling for every JSON body except the manifest upload (Doc 06 §1). */
  REQUEST_BODY_LIMIT_BYTES: bytes(
    'REQUEST_BODY_LIMIT_BYTES',
    DEFAULT_REQUEST_BODY_LIMIT_BYTES,
    MAX_REQUEST_BODY_LIMIT_BYTES,
  ),
  /** Ceiling for `POST /iam/applications/:id/manifest` alone (Doc 02 §2). */
  MANIFEST_BODY_LIMIT_BYTES: bytes(
    'MANIFEST_BODY_LIMIT_BYTES',
    DEFAULT_MANIFEST_BODY_LIMIT_BYTES,
    MAX_MANIFEST_BODY_LIMIT_BYTES,
  ),
  /** Ceiling for `POST /iam/users/bulk` alone (Doc 06 §8). */
  BULK_UPLOAD_BODY_LIMIT_BYTES: bytes(
    'BULK_UPLOAD_BODY_LIMIT_BYTES',
    DEFAULT_BULK_UPLOAD_BODY_LIMIT_BYTES,
    MAX_BULK_UPLOAD_BODY_LIMIT_BYTES,
  ),

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
   * How often the binding-expiry sweep runs; **0 disables it** (Doc 04 §7).
   *
   * Not `seconds()`, which rejects zero — see the constants above for why this
   * one variable is allowed an off switch when `LOGIN_MAX_FAILED_ATTEMPTS` is
   * not.
   */
  EXPIRY_SWEEP_INTERVAL_SECONDS: z.coerce
    .number({ error: 'EXPIRY_SWEEP_INTERVAL_SECONDS must be a number of seconds' })
    .int('EXPIRY_SWEEP_INTERVAL_SECONDS must be a whole number of seconds')
    .min(0, 'EXPIRY_SWEEP_INTERVAL_SECONDS must not be negative')
    .max(
      MAX_EXPIRY_SWEEP_INTERVAL_SECONDS,
      `EXPIRY_SWEEP_INTERVAL_SECONDS must be at most ${MAX_EXPIRY_SWEEP_INTERVAL_SECONDS} seconds`,
    )
    .default(DEFAULT_EXPIRY_SWEEP_INTERVAL_SECONDS),

  /** Rows one sweep pass claims per tenant (migration 0016). */
  EXPIRY_SWEEP_BATCH_SIZE: z.coerce
    .number({ error: 'EXPIRY_SWEEP_BATCH_SIZE must be a number' })
    .int('EXPIRY_SWEEP_BATCH_SIZE must be a whole number')
    .positive('EXPIRY_SWEEP_BATCH_SIZE must be greater than zero')
    .max(
      MAX_EXPIRY_SWEEP_BATCH_SIZE,
      `EXPIRY_SWEEP_BATCH_SIZE must be at most ${MAX_EXPIRY_SWEEP_BATCH_SIZE}`,
    )
    .default(DEFAULT_EXPIRY_SWEEP_BATCH_SIZE),

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
})
  /**
   * Both exemptions have to be exemptions. Configured the other way round
   * neither is a smaller ceiling for one route — each is a route that silently
   * rejects bodies every *other* route accepts, which is the least guessable
   * failure this trio can produce. The defaults already satisfy both; only an
   * operator who has changed one of them can trip either.
   */
  /**
   * A trust anchor with TLS switched off is not a smaller configuration — it is
   * a cleartext connection wearing the paperwork of an encrypted one. The
   * realistic way to arrive here is a `DATABASE_SSL` that was flipped to
   * `false` while debugging something else and never flipped back, next to a CA
   * someone deliberately pasted in. Refusing to boot says so; connecting anyway
   * says nothing at all.
   */
  .refine(
    (env) => env.DATABASE_CA_CERT === undefined || env.DATABASE_SSL,
    {
      message:
        'DATABASE_CA_CERT is set but DATABASE_SSL is false — the certificate would be ignored and the connection sent in cleartext. Set DATABASE_SSL=true, or remove the certificate.',
    },
  )
  .refine(
    (env) => env.MANIFEST_BODY_LIMIT_BYTES >= env.REQUEST_BODY_LIMIT_BYTES,
    {
      message:
        'MANIFEST_BODY_LIMIT_BYTES must be at least REQUEST_BODY_LIMIT_BYTES — the manifest route raises the global ceiling, it does not lower it',
    },
  )
  .refine(
    (env) => env.BULK_UPLOAD_BODY_LIMIT_BYTES >= env.REQUEST_BODY_LIMIT_BYTES,
    {
      message:
        'BULK_UPLOAD_BODY_LIMIT_BYTES must be at least REQUEST_BODY_LIMIT_BYTES — the bulk upload route raises the global ceiling, it does not lower it',
    },
  );

/** The validated, fully-defaulted environment. */
export type EnvConfig = z.infer<typeof envSchema>;

/** Every variable the schema reads — used by the `.env.example` drift test. */
export const ENV_KEYS = Object.keys(envSchema.shape) as Array<keyof EnvConfig>;

/**
 * The environment a **migration** needs, and nothing else (Doc 08 §5–6).
 *
 * The release step is not the application. It opens one connection to the
 * direct endpoint, applies DDL, and exits — it never signs a token, never
 * reaches Redis, and never reads the bootstrap secret. Booting it through
 * `envSchema` would nonetheless demand all three, which means the CI job that
 * runs migrations has to be handed `JWT_PRIVATE_KEY` and
 * `PLATFORM_BOOTSTRAP_SECRET` in order to do something neither is involved in.
 *
 * That is a blast radius bought for nothing, so the release step validates this
 * subset instead (`tools/release-migrate.ts`). The three fields are the *same*
 * declarations `envSchema` uses, not parallel ones, so a change to how a
 * connection string is validated cannot apply to the app and miss the migrator.
 *
 * `DATABASE_URL` is deliberately absent. Doc 07 §5.1 requires the two URLs to
 * carry different **roles** — the owner migrates, the app serves — so the
 * migrator having no way to reach the app's credentials is the arrangement
 * working, not a gap in it.
 */
export const migrationEnvSchema = z.object({
  NODE_ENV: envSchema.shape.NODE_ENV,
  DATABASE_DIRECT_URL: envSchema.shape.DATABASE_DIRECT_URL,
  DATABASE_SSL: envSchema.shape.DATABASE_SSL,
  /**
   * Present here even though it is not a credential: the release step opens a
   * TLS connection like any other, so a managed host that needs a trust anchor
   * needs it in the migration job too. Leaving it out would make the migration
   * the one connection in the system that could not verify the server.
   */
  DATABASE_CA_CERT: envSchema.shape.DATABASE_CA_CERT,
});

/** The validated environment of the migration release step. */
export type MigrationEnvConfig = z.infer<typeof migrationEnvSchema>;

/** Every variable the release step reads. A strict subset of {@link ENV_KEYS}. */
export const MIGRATION_ENV_KEYS = Object.keys(
  migrationEnvSchema.shape,
) as Array<keyof MigrationEnvConfig>;

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
