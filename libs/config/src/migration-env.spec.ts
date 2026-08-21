import { ENV_KEYS, MIGRATION_ENV_KEYS, envSchema, migrationEnvSchema } from './env.schema.js';

/**
 * The release step's environment (Doc 08 §6).
 *
 * `tools/release-migrate.ts` boots through `migrationEnvSchema` rather than the
 * full one so that the job which applies migrations never has to hold the
 * signing key or the bootstrap secret. That is a security property, and it only
 * holds while two things stay true: the subset is genuinely a subset (so a
 * change to how a connection string is validated cannot apply to the app and
 * miss the migrator), and it genuinely excludes the secrets (so nobody
 * "helpfully" adds `DATABASE_URL` back to make some future check easier).
 *
 * Both are asserted here, because neither is visible at the call site.
 */
describe('migrationEnvSchema', () => {
  const VALID = {
    DATABASE_DIRECT_URL: 'postgresql://plantops:pw@db.example.com:5432/plantops_iam',
  };

  it('needs nothing but the direct URL', () => {
    const parsed = migrationEnvSchema.parse(VALID);
    expect(parsed.DATABASE_DIRECT_URL).toBe(VALID.DATABASE_DIRECT_URL);
    // Defaults, so a release job sets two variables rather than four.
    expect(parsed.NODE_ENV).toBe('development');
    expect(parsed.DATABASE_SSL).toBe(false);
  });

  it('reads no variable the full schema does not also define', () => {
    const known = new Set<string>(ENV_KEYS);
    expect(MIGRATION_ENV_KEYS.filter((key) => !known.has(key))).toEqual([]);
  });

  it('reuses the full schema’s own field declarations', () => {
    for (const key of MIGRATION_ENV_KEYS) {
      expect(migrationEnvSchema.shape[key]).toBe(envSchema.shape[key]);
    }
  });

  it('carries the TLS trust anchor — the release step opens a real connection too', () => {
    // Not a credential, so its presence here is not a widening of the blast
    // radius the narrow schema exists to keep small. Its *absence* would be a
    // hole: the migration would be the one connection in the system unable to
    // verify the server it is applying DDL to.
    expect(MIGRATION_ENV_KEYS as readonly string[]).toContain('DATABASE_CA_CERT');
  });

  it.each(['JWT_PRIVATE_KEY', 'PLATFORM_BOOTSTRAP_SECRET', 'REDIS_URL', 'DATABASE_URL'])(
    'does not require %s — a migration never uses it',
    (key) => {
      expect(MIGRATION_ENV_KEYS as readonly string[]).not.toContain(key);
    },
  );

  it('still rejects a malformed connection string', () => {
    const result = migrationEnvSchema.safeParse({ DATABASE_DIRECT_URL: 'db.example.com' });
    expect(result.success).toBe(false);
  });

  it('rejects a missing connection string rather than defaulting one', () => {
    // The failure mode this prevents: a release job with a typo'd secret name
    // silently migrating whatever `localhost` happens to be.
    expect(migrationEnvSchema.safeParse({}).success).toBe(false);
  });

  it('parses a filled-in environment that also carries the app variables', () => {
    // A developer's shell, or the container in Session 41 that gets the whole
    // env file. Extra keys are ignored, not an error.
    const parsed = migrationEnvSchema.parse({
      ...VALID,
      NODE_ENV: 'production',
      DATABASE_SSL: 'true',
      DATABASE_URL: 'postgresql://plantops_app:pw@pooler.example.com:6543/plantops_iam',
      PLATFORM_BOOTSTRAP_SECRET: 'x'.repeat(32),
    });
    expect(parsed).toEqual({
      NODE_ENV: 'production',
      DATABASE_SSL: true,
      DATABASE_DIRECT_URL: VALID.DATABASE_DIRECT_URL,
    });
  });
});
