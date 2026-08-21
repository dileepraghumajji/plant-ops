import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ENV_KEYS } from './env.schema.js';
import { type EnvSource, parseEnv } from './load-env.js';

/**
 * `deploy/.env.template` and `deploy/docker-compose.prod.yml`, checked together.
 *
 * These two files are the entire configuration surface of an installation we
 * will never be able to log into. `libs/config` refuses to start on a bad
 * environment — correctly — so on a plant server with no egress, a variable the
 * template forgot to mention becomes a support call about an error message
 * naming something the operator has never seen.
 *
 * `env-example.spec.ts` makes the same argument for the developer's template
 * and can make it more simply: `.env.example` *is* the environment, so parsing
 * it is the whole test. Here the environment is assembled from two files —
 * `.env` supplies what an operator chooses, the compose file overrides what the
 * stack decides — and the property worth having is that the assembly parses.
 * Checking either file alone would miss the case that actually breaks an
 * install: a variable neither of them sets.
 */
const DEPLOY_DIR = join(__dirname, '..', '..', '..', 'deploy');
const TEMPLATE = readFileSync(join(DEPLOY_DIR, '.env.template'), 'utf-8');
const COMPOSE = readFileSync(join(DEPLOY_DIR, 'docker-compose.prod.yml'), 'utf-8');

/**
 * Variables the *deployment* reads and the application never sees: compose
 * interpolates them into image tags, published ports and connection strings.
 *
 * Listed explicitly rather than pattern-matched, so that adding one is a
 * decision. The alternative — allowing anything with a `PLANTOPS_` or
 * `POSTGRES_` prefix — would let a typo'd `PLANTOPS_ADMIN_EMIAL` sit in the
 * template forever, silently never read by anything.
 */
const DEPLOYMENT_KEYS = [
  'PLANTOPS_VERSION',
  'PLANTOPS_HTTP_PORT',
  'PLANTOPS_APP_ROLE',
  'PLANTOPS_APP_PASSWORD',
  'PLANTOPS_CLIENT_NAME',
  'PLANTOPS_CLIENT_SLUG',
  'PLANTOPS_ADMIN_EMAIL',
  'PLANTOPS_ADMIN_NAME',
  'PLANTOPS_ADMIN_PASSWORD',
  'POSTGRES_USER',
  'POSTGRES_PASSWORD',
  'POSTGRES_DB',
  'TRUSTED_PROXY_CIDRS',
] as const;

/**
 * What an operator fills into the blanks. Values that are *shaped* right and
 * obviously fake — the point is to prove the assembled environment parses, and
 * a fixture that looked like a real credential would be a real credential in a
 * test file.
 */
const OPERATOR_ANSWERS: EnvSource = {
  POSTGRES_PASSWORD: 'test-owner-password',
  PLANTOPS_APP_PASSWORD: 'test-app-password',
  JWT_SIGNING_KEY_ID: 'test-key-1',
  JWT_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----\\nMIIB...\\n-----END PRIVATE KEY-----',
  JWT_PUBLIC_KEY: '-----BEGIN PUBLIC KEY-----\\nMIIB...\\n-----END PUBLIC KEY-----',
  PLATFORM_BOOTSTRAP_SECRET: 'z'.repeat(48),
  PLANTOPS_CLIENT_NAME: 'Test Manufacturing',
  PLANTOPS_CLIENT_SLUG: 'test-manufacturing',
  PLANTOPS_ADMIN_EMAIL: 'admin@example.com',
  PLANTOPS_ADMIN_NAME: 'Test Admin',
  PLANTOPS_ADMIN_PASSWORD: 'a-long-enough-password',
  PLANTOPS_VERSION: '1.0.0-test',
  // The same slug the installer is told to create, which is the pairing
  // `bootstrap.sh` asserts. A template that shipped these two disagreeing would
  // produce a stack that installs and then refuses to start.
  SINGLE_TENANT_CLIENT_SLUG: 'test-manufacturing',
};

/** `KEY=value` lines, quotes stripped, comments and blanks skipped. */
function assignments(contents: string): EnvSource {
  const entries: EnvSource = {};
  for (const line of contents.split(/\r?\n/)) {
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line.trim());
    if (!match) continue;
    entries[match[1]] = match[2].replace(/^["'](.*)["']$/, '$1');
  }
  return entries;
}

/** Keys that appear at all — assigned, or commented out as documentation. */
function documentedKeys(contents: string): Set<string> {
  const keys = new Set<string>();
  for (const line of contents.split(/\r?\n/)) {
    const match = /^#?\s*([A-Z][A-Z0-9_]*)=/.exec(line.trim());
    if (match) keys.add(match[1]);
  }
  return keys;
}

/**
 * The `environment:` mapping of one compose service.
 *
 * A focused reader rather than a YAML parser, for one reason: `libs/config`
 * depends on `@plantops/contracts` and `zod` and nothing else (Doc 08 §2), and
 * a test is not a good enough reason to widen that. The block being read is a
 * flat `KEY: value` mapping, which is a shape this can handle honestly.
 *
 * It would read nothing at all if the file switched to compose's list form
 * (`- KEY=value`), so the caller asserts a plausible count — a silently empty
 * result would turn every assertion below into a tautology.
 */
function serviceEnvironment(compose: string, service: string): EnvSource {
  const lines = compose.split(/\r?\n/);
  const serviceAt = lines.findIndex((line) => line.trimEnd() === `  ${service}:`);
  if (serviceAt < 0) throw new Error(`no service "${service}" in the compose file`);

  const envAt = lines.findIndex(
    (line, index) => index > serviceAt && line.trimEnd() === '    environment:',
  );
  if (envAt < 0) throw new Error(`service "${service}" declares no environment`);

  const entries: EnvSource = {};
  for (const line of lines.slice(envAt + 1)) {
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue;
    // Any line indented less than the mapping's entries has left the block.
    if (!line.startsWith('      ')) break;
    const match = /^ {6}([A-Z][A-Z0-9_]*):\s*(.*)$/.exec(line);
    if (!match) continue;
    entries[match[1]] = match[2].trim().replace(/^["'](.*)["']$/, '$1');
  }
  return entries;
}

/**
 * `${VAR}`, `${VAR:-default}` and `${VAR:?message}` against a source.
 *
 * The `:?` form is compose's "required, and here is what to say if it is
 * missing". Resolving it like `${VAR}` is right for this test: what it means
 * for the *application* is identical, and whether compose would have refused to
 * start is a question about compose, not about whether the environment is valid.
 */
function interpolate(value: string, source: EnvSource): string {
  return value.replace(
    /\$\{([A-Z][A-Z0-9_]*)(?::([-?])([^}]*))?\}/g,
    (_match, name: string, operator: string | undefined, argument: string) => {
      const resolved = source[name];
      if (resolved !== undefined && resolved !== '') return resolved;
      return operator === '-' ? argument : (resolved ?? '');
    },
  );
}

describe('deploy/.env.template', () => {
  const documented = documentedKeys(TEMPLATE);
  const assigned = assignments(TEMPLATE);

  it.each(ENV_KEYS)('documents %s', (key) => {
    expect(documented.has(key)).toBe(true);
  });

  it('documents nothing that neither the application nor the deployment reads', () => {
    const known = new Set<string>([...ENV_KEYS, ...DEPLOYMENT_KEYS]);
    expect([...documented].filter((key) => !known.has(key))).toEqual([]);
  });

  it('ships every required value blank rather than pre-filled', () => {
    // A template that arrives with a working-looking password is a template
    // whose password reaches production. Blank is what makes the operator
    // generate one — and what makes `bootstrap.sh` able to refuse to proceed.
    for (const key of [
      'POSTGRES_PASSWORD',
      'PLANTOPS_APP_PASSWORD',
      'JWT_PRIVATE_KEY',
      'JWT_PUBLIC_KEY',
      'JWT_SIGNING_KEY_ID',
      'PLATFORM_BOOTSTRAP_SECRET',
      'PLANTOPS_ADMIN_PASSWORD',
    ]) {
      expect(assigned[key]).toBe('');
    }
  });

  it('names the same organisation twice, and blank in both places', () => {
    // `PLANTOPS_CLIENT_SLUG` tells the installer which organisation to create;
    // `SINGLE_TENANT_CLIENT_SLUG` tells the application which one it serves.
    // The installer refuses to proceed if they disagree, and that check is only
    // meaningful while both are the operator's to fill in — a template that
    // pre-filled either would make the disagreement the default.
    expect(assigned['PLANTOPS_CLIENT_SLUG']).toBe('');
    expect(assigned['SINGLE_TENANT_CLIENT_SLUG']).toBe('');
  });
});

describe('deploy/docker-compose.prod.yml + .env.template', () => {
  const operatorEnv: EnvSource = { ...assignments(TEMPLATE), ...OPERATOR_ANSWERS };
  const overrides = serviceEnvironment(COMPOSE, 'iam-api');

  it('reads a non-trivial environment block from the compose file', () => {
    // Guards the reader itself: every assertion below would pass vacuously
    // against an empty mapping.
    expect(Object.keys(overrides).length).toBeGreaterThan(8);
    expect(overrides).toHaveProperty('DATABASE_URL');
  });

  it('assembles into an environment the application accepts — copy, fill, boot', () => {
    const assembled: EnvSource = { ...operatorEnv };
    for (const [key, raw] of Object.entries(overrides)) {
      assembled[key] = interpolate(raw ?? '', operatorEnv);
    }

    expect(() => parseEnv(assembled)).not.toThrow();
  });

  it('hands the application no bootstrap secret, whatever the operator left in .env', () => {
    // The acceptance criterion of roadmap Session 42, asserted where it can
    // actually be checked: the operator's `.env` still carries the secret —
    // the migration container needs it — and the API service must not receive
    // it regardless.
    expect(operatorEnv.PLATFORM_BOOTSTRAP_SECRET).not.toBe('');

    const assembled: EnvSource = { ...operatorEnv };
    for (const [key, raw] of Object.entries(overrides)) {
      assembled[key] = interpolate(raw ?? '', operatorEnv);
    }

    expect(parseEnv(assembled).PLATFORM_BOOTSTRAP_SECRET).toBeUndefined();
  });

  it('connects the application as a role that is not the schema owner', () => {
    // The single most consequential line in the deployment: PostgreSQL exempts
    // a table's owner from its own row-level security policies, so an
    // application connected as the owner is one with no tenant isolation at
    // all — and nothing about it looks wrong from the outside.
    const appUrl = interpolate(overrides.DATABASE_URL ?? '', operatorEnv);
    const ownerUrl = interpolate(overrides.DATABASE_DIRECT_URL ?? '', operatorEnv);

    expect(new URL(appUrl).username).toBe(operatorEnv.PLANTOPS_APP_ROLE);
    expect(new URL(ownerUrl).username).toBe(operatorEnv.POSTGRES_USER);
    expect(new URL(appUrl).username).not.toBe(new URL(ownerUrl).username);
  });
});
