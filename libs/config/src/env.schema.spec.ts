import {
  ACCESS_TOKEN_TTL_SECONDS,
  CLOCK_SKEW_LEEWAY_SECONDS,
  IAM_ISSUER,
} from '@plantops/contracts';
import {
  BOOTSTRAP_SECRET_MIN_LENGTH,
  DEFAULT_RATE_LIMIT_MAX_REQUESTS,
  DEFAULT_RATE_LIMIT_WINDOW_SECONDS,
  DEFAULT_READINESS_TIMEOUT_MS,
  ENV_KEYS,
  SECRET_ENV_KEYS,
} from './env.schema.js';
import {
  EnvValidationError,
  type EnvSource,
  isSecretEnvKey,
  loadEnv,
  parseEnv,
  redactEnv,
  resetEnvCache,
} from './load-env.js';

const PRIVATE_KEY =
  '-----BEGIN PRIVATE KEY-----\nMIIBVgIBADANBg\n-----END PRIVATE KEY-----';
const PUBLIC_KEY =
  '-----BEGIN PUBLIC KEY-----\nMIIBIjANBgkqhki\n-----END PUBLIC KEY-----';

/** The smallest environment that boots — every required variable, nothing else. */
function validEnv(overrides: EnvSource = {}): EnvSource {
  return {
    DATABASE_URL: 'postgresql://app:pw@localhost:6543/plantops_iam',
    DATABASE_DIRECT_URL: 'postgresql://app:pw@localhost:5432/plantops_iam',
    REDIS_URL: 'redis://localhost:6379',
    JWT_SIGNING_KEY_ID: 'key-2026-08',
    JWT_PRIVATE_KEY: PRIVATE_KEY,
    JWT_PUBLIC_KEY: PUBLIC_KEY,
    PLATFORM_BOOTSTRAP_SECRET: 'b'.repeat(BOOTSTRAP_SECRET_MIN_LENGTH),
    ...overrides,
  };
}

function issuesOf(source: EnvSource): string[] {
  try {
    parseEnv(source);
  } catch (error) {
    if (error instanceof EnvValidationError) return [...error.issues];
    throw error;
  }
  throw new Error('expected parseEnv to reject this environment');
}

describe('parseEnv — required variables', () => {
  const REQUIRED = [
    'DATABASE_URL',
    'DATABASE_DIRECT_URL',
    'REDIS_URL',
    'JWT_SIGNING_KEY_ID',
    'JWT_PRIVATE_KEY',
    'JWT_PUBLIC_KEY',
    'PLATFORM_BOOTSTRAP_SECRET',
  ] as const;

  it.each(REQUIRED)('aborts when %s is missing', (key) => {
    const source = validEnv();
    delete source[key];
    expect(issuesOf(source)).toEqual([`${key}: is required but was not set`]);
  });

  it('reports every problem at once, not just the first', () => {
    const issues = issuesOf({});
    expect(issues).toHaveLength(REQUIRED.length);
    for (const key of REQUIRED) {
      expect(issues.some((issue) => issue.startsWith(`${key}:`))).toBe(true);
    }
  });

  it('names the offending variable without echoing its value', () => {
    const secret = 'postgres://user:hunter2@db/plantops';
    const issues = issuesOf(validEnv({ DATABASE_URL: secret.replace('postgres', 'http') }));
    expect(issues[0]).toContain('DATABASE_URL');
    expect(issues.join('\n')).not.toContain('hunter2');
  });

  it('accepts the minimal valid environment', () => {
    expect(() => parseEnv(validEnv())).not.toThrow();
  });
});

describe('parseEnv — connection strings', () => {
  it.each([
    ['http://localhost:5432/db'],
    ['localhost:5432'],
    [''],
    ['mysql://localhost:3306/db'],
  ])('rejects %s as a database URL', (url) => {
    expect(issuesOf(validEnv({ DATABASE_URL: url }))[0]).toContain(
      'DATABASE_URL',
    );
  });

  it.each([
    ['postgres://app:pw@host:6543/db'],
    ['postgresql://app:pw@host:6543/db?sslmode=require'],
  ])('accepts %s', (url) => {
    expect(parseEnv(validEnv({ DATABASE_URL: url })).DATABASE_URL).toBe(url);
  });

  it('requires the direct URL separately from the pooler URL (Doc 07 §2)', () => {
    const source = validEnv();
    delete source.DATABASE_DIRECT_URL;
    expect(issuesOf(source)).toEqual([
      'DATABASE_DIRECT_URL: is required but was not set',
    ]);
  });

  it.each([['http://localhost:6379'], ['redis:6379']])(
    'rejects %s as a redis URL',
    (url) => {
      expect(issuesOf(validEnv({ REDIS_URL: url }))[0]).toContain('REDIS_URL');
    },
  );

  it('accepts rediss:// for managed TLS instances', () => {
    expect(
      parseEnv(validEnv({ REDIS_URL: 'rediss://user:pw@redis.example:6379' }))
        .REDIS_URL,
    ).toBe('rediss://user:pw@redis.example:6379');
  });
});

describe('parseEnv — JWT key configuration', () => {
  it('rejects key material that is not PEM', () => {
    expect(issuesOf(validEnv({ JWT_PRIVATE_KEY: 'not-a-key' }))[0]).toContain(
      'JWT_PRIVATE_KEY',
    );
    expect(
      issuesOf(validEnv({ JWT_PUBLIC_KEY: PRIVATE_KEY }))[0],
    ).toContain('JWT_PUBLIC_KEY');
  });

  it('unescapes \\n-encoded PEM keys from secret stores', () => {
    const escaped = PRIVATE_KEY.replace(/\n/g, '\\n');
    expect(parseEnv(validEnv({ JWT_PRIVATE_KEY: escaped })).JWT_PRIVATE_KEY).toBe(
      PRIVATE_KEY,
    );
  });

  it('defaults the issuer to the shared constant', () => {
    expect(parseEnv(validEnv()).JWT_ISSUER).toBe(IAM_ISSUER);
  });

  it('parses retained public keys for rotation (Doc 03 §1)', () => {
    const retired = JSON.stringify({ 'key-2026-05': PUBLIC_KEY });
    expect(
      parseEnv(validEnv({ JWT_RETIRED_PUBLIC_KEYS: retired }))
        .JWT_RETIRED_PUBLIC_KEYS,
    ).toEqual({ 'key-2026-05': PUBLIC_KEY });
  });

  it('defaults retained keys to an empty set', () => {
    expect(parseEnv(validEnv()).JWT_RETIRED_PUBLIC_KEYS).toEqual({});
  });

  it.each([['not json'], ['["a"]'], ['{"kid":1}']])(
    'rejects malformed retained keys: %s',
    (value) => {
      expect(
        issuesOf(validEnv({ JWT_RETIRED_PUBLIC_KEYS: value }))[0],
      ).toContain('JWT_RETIRED_PUBLIC_KEYS');
    },
  );
});

describe('parseEnv — TTLs and spec bounds', () => {
  it('defaults token TTLs to the shared constants', () => {
    const env = parseEnv(validEnv());
    expect(env.ACCESS_TOKEN_TTL_SECONDS).toBe(ACCESS_TOKEN_TTL_SECONDS);
    expect(env.SERVICE_TOKEN_TTL_SECONDS).toBe(300);
    expect(env.GRANTS_CACHE_TTL_SECONDS).toBe(600);
    expect(env.REFRESH_REUSE_GRACE_SECONDS).toBe(15);
  });

  it('coerces numeric strings', () => {
    expect(
      parseEnv(validEnv({ ACCESS_TOKEN_TTL_SECONDS: '600' }))
        .ACCESS_TOKEN_TTL_SECONDS,
    ).toBe(600);
  });

  it('refuses a service-token TTL above the Doc 03 §5 cap of 5 minutes', () => {
    expect(
      issuesOf(validEnv({ SERVICE_TOKEN_TTL_SECONDS: '900' }))[0],
    ).toContain('SERVICE_TOKEN_TTL_SECONDS');
  });

  it('refuses a grants-cache TTL above the Doc 04 §6 cap of 10 minutes', () => {
    expect(
      issuesOf(validEnv({ GRANTS_CACHE_TTL_SECONDS: '3600' }))[0],
    ).toContain('GRANTS_CACHE_TTL_SECONDS');
  });

  it.each([['5'], ['60']])(
    'refuses a refresh grace window of %s s (Doc 03 §4 allows 10–30)',
    (value) => {
      expect(
        issuesOf(validEnv({ REFRESH_REUSE_GRACE_SECONDS: value }))[0],
      ).toContain('REFRESH_REUSE_GRACE_SECONDS');
    },
  );

  it('defaults the account-lockout and reset policy (Doc 03 §7–8)', () => {
    const env = parseEnv(validEnv());
    expect(env.LOGIN_MAX_FAILED_ATTEMPTS).toBe(5);
    expect(env.PASSWORD_RESET_TTL_SECONDS).toBe(3_600);
  });

  it.each([['0'], ['-1'], ['500'], ['2.5']])(
    'refuses a lockout threshold of %s',
    (value) => {
      // Zero especially: a security control with an off switch spelled as a
      // falsy value is one that gets disabled by an empty variable.
      expect(
        issuesOf(validEnv({ LOGIN_MAX_FAILED_ATTEMPTS: value }))[0],
      ).toContain('LOGIN_MAX_FAILED_ATTEMPTS');
    },
  );

  it('refuses a reset TTL above 24 hours', () => {
    expect(
      issuesOf(validEnv({ PASSWORD_RESET_TTL_SECONDS: '172800' }))[0],
    ).toContain('PASSWORD_RESET_TTL_SECONDS');
  });

  it.each([['0'], ['-30'], ['abc'], ['12.5']])(
    'refuses a nonsensical TTL: %s',
    (value) => {
      expect(
        issuesOf(validEnv({ ACCESS_TOKEN_TTL_SECONDS: value }))[0],
      ).toContain('ACCESS_TOKEN_TTL_SECONDS');
    },
  );
});

describe('parseEnv — bootstrap secret and other defaults', () => {
  it('requires a bootstrap secret of real length (Doc 07 §8)', () => {
    expect(
      issuesOf(validEnv({ PLATFORM_BOOTSTRAP_SECRET: 'short' }))[0],
    ).toContain('PLATFORM_BOOTSTRAP_SECRET');
  });

  it('applies operational defaults', () => {
    const env = parseEnv(validEnv());
    expect(env.NODE_ENV).toBe('development');
    expect(env.PORT).toBe(3000);
    expect(env.LOG_LEVEL).toBe('log');
    expect(env.DATABASE_SSL).toBe(false);
  });

  it('parses boolean-ish flags', () => {
    expect(parseEnv(validEnv({ DATABASE_SSL: 'true' })).DATABASE_SSL).toBe(true);
    expect(parseEnv(validEnv({ DATABASE_SSL: '1' })).DATABASE_SSL).toBe(true);
    expect(parseEnv(validEnv({ DATABASE_SSL: '0' })).DATABASE_SSL).toBe(false);
    expect(issuesOf(validEnv({ DATABASE_SSL: 'yes' }))[0]).toContain(
      'DATABASE_SSL',
    );
  });

  it.each([['staging'], ['prod']])('rejects unknown NODE_ENV %s', (value) => {
    expect(issuesOf(validEnv({ NODE_ENV: value }))[0]).toContain('NODE_ENV');
  });

  it('ignores unrelated variables in the environment', () => {
    expect(() =>
      parseEnv(validEnv({ PATH: '/usr/bin', SOME_OTHER_TOOL: 'x' })),
    ).not.toThrow();
  });

  it('returns a frozen config', () => {
    const env = parseEnv(validEnv());
    expect(Object.isFrozen(env)).toBe(true);
  });
});

describe('parseEnv — HTTP and throttle ops settings', () => {
  it('defaults to a namespaced Redis, no CORS, and an untrusted proxy', () => {
    const env = parseEnv(validEnv());
    expect(env.REDIS_KEY_PREFIX).toBe('plantops:');
    expect(env.CORS_ALLOWED_ORIGINS).toEqual([]);
    // Trusting X-Forwarded-For by default would let any caller pick their own
    // rate-limit bucket, so the safe value is the default.
    expect(env.TRUST_PROXY).toBe(false);
  });

  it('applies the throttle and readiness defaults', () => {
    const env = parseEnv(validEnv());
    expect(env.RATE_LIMIT_ENABLED).toBe(true);
    expect(env.RATE_LIMIT_WINDOW_SECONDS).toBe(DEFAULT_RATE_LIMIT_WINDOW_SECONDS);
    expect(env.RATE_LIMIT_MAX_REQUESTS).toBe(DEFAULT_RATE_LIMIT_MAX_REQUESTS);
    expect(env.READINESS_TIMEOUT_MS).toBe(DEFAULT_READINESS_TIMEOUT_MS);
  });

  it('splits and trims the CORS origin list', () => {
    const env = parseEnv(
      validEnv({
        CORS_ALLOWED_ORIGINS: 'https://admin.plantops.io, http://localhost:4200 ,',
      }),
    );
    expect(env.CORS_ALLOWED_ORIGINS).toEqual([
      'https://admin.plantops.io',
      'http://localhost:4200',
    ]);
  });

  it('rejects a CORS entry that is not an origin', () => {
    expect(issuesOf(validEnv({ CORS_ALLOWED_ORIGINS: 'admin.plantops.io' }))[0]).toContain(
      'CORS_ALLOWED_ORIGINS',
    );
  });

  it.each([
    ['RATE_LIMIT_MAX_REQUESTS', '0'],
    ['RATE_LIMIT_WINDOW_SECONDS', '-1'],
    ['READINESS_TIMEOUT_MS', 'soon'],
  ])('rejects a nonsensical %s', (key, value) => {
    expect(issuesOf(validEnv({ [key]: value }))[0]).toContain(key);
  });
});

describe('loadEnv', () => {
  afterEach(() => resetEnvCache());

  it('parses once and returns the same object', () => {
    const source = validEnv();
    expect(loadEnv(source)).toBe(loadEnv(source));
  });

  it('re-parses after the cache is reset', () => {
    const first = loadEnv(validEnv());
    resetEnvCache();
    expect(loadEnv(validEnv())).not.toBe(first);
  });

  it('throws on an invalid environment rather than returning a partial config', () => {
    expect(() => loadEnv({})).toThrow(EnvValidationError);
  });
});

describe('redactEnv', () => {
  it('masks every secret before anything can log it', () => {
    const redacted = redactEnv(parseEnv(validEnv()));
    for (const key of SECRET_ENV_KEYS) {
      expect(redacted[key]).toBe('[redacted]');
    }
    const serialized = JSON.stringify(redacted);
    expect(serialized).not.toContain('hunter2');
    expect(serialized).not.toContain('BEGIN PRIVATE KEY');
    expect(serialized).not.toContain('b'.repeat(BOOTSTRAP_SECRET_MIN_LENGTH));
  });

  it('keeps operational values readable', () => {
    const redacted = redactEnv(parseEnv(validEnv({ PORT: '8080' })));
    expect(redacted.PORT).toBe(8080);
    expect(redacted.NODE_ENV).toBe('development');
    expect(redacted.JWT_SIGNING_KEY_ID).toBe('key-2026-08');
  });

  it('summarizes public key material by kid instead of dumping PEM', () => {
    const redacted = redactEnv(
      parseEnv(
        validEnv({
          JWT_RETIRED_PUBLIC_KEYS: JSON.stringify({ old: PUBLIC_KEY }),
        }),
      ),
    );
    expect(redacted.JWT_PUBLIC_KEY).toBe('[pem]');
    expect(redacted.JWT_RETIRED_PUBLIC_KEYS).toEqual(['old']);
  });

  it('covers every key of the config', () => {
    expect(Object.keys(redactEnv(parseEnv(validEnv()))).sort()).toEqual(
      [...ENV_KEYS].sort(),
    );
  });
});

describe('isSecretEnvKey', () => {
  it('classifies connection strings and key material as secret', () => {
    expect(isSecretEnvKey('PLATFORM_BOOTSTRAP_SECRET')).toBe(true);
    expect(isSecretEnvKey('DATABASE_URL')).toBe(true);
    expect(isSecretEnvKey('PORT')).toBe(false);
  });
});

describe('re-exported shared constants', () => {
  it('exposes the clock-skew leeway Doc 03 §6 expects from libs/config', () => {
    expect(CLOCK_SKEW_LEEWAY_SECONDS).toBe(60);
  });
});
