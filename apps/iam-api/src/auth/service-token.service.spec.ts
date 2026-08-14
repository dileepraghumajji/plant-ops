/**
 * `ServiceTokenService` against a fake database and a real signer (Doc 03 §5).
 *
 * The database is faked because everything it would decide here is a plain
 * lookup — `iam.auth_lookup_service_account` reports, it does not judge — and
 * the judging is what this suite is about: which reason each refusal records,
 * that none of them are distinguishable from outside, and that the token issued
 * on the way through has the shape §5 requires.
 *
 * The *signer* is real, with genuine RSA keys, because the claims are the
 * deliverable: an ephemeral `sid`, `sty=service`, and a TTL the schema caps at
 * five minutes. A stubbed `TokenService` would let all three be asserted against
 * nothing.
 *
 * The exchange against a live Postgres — a revoked account failing the *next*
 * exchange, the audit row landing outside the rolled-back transaction — is
 * `service-accounts.integration.spec.ts`.
 */

import { parseEnv, type EnvConfig } from '@plantops/config';
import {
  IamErrorCode,
  JWT_CLAIM_KEYS,
  SubjectType,
  type JwtClaims,
} from '@plantops/contracts';
import { SERVICE_TOKEN_FAILURE_REASONS, hashSecret } from '@plantops/db';
import { generateKeyPairSync } from 'node:crypto';
import type { IamException } from '../common/iam.exception';
import type { DatabaseService } from '../database/database.service';
import { KeysService } from './keys.service';
import { ServiceTokenService } from './service-token.service';
import { TokenService } from './token.service';

const KEY = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

const ACCOUNT_ID = '11111111-1111-4111-8111-111111111111';
const CLIENT_ID = '22222222-2222-4222-8222-222222222222';
const PLATFORM_CLIENT_ID = '33333333-3333-4333-8333-333333333333';
const SECRET = 'the-account-secret';

/**
 * A real argon2id hash of {@link SECRET}, computed once.
 *
 * `hashSecret` is deliberately expensive (19 MiB, two passes), and every case
 * below verifies against this row — computing it per test would put a second on
 * the suite for no coverage.
 */
let secretHash: string;

interface RecordedQuery {
  sql: string;
  parameters: unknown[];
}

interface AccountRow {
  service_account_id: string;
  client_id: string | null;
  token_client_id: string | null;
  account_status: string;
  client_status: string | null;
  key_hash: string;
}

function activeRow(overrides: Partial<AccountRow> = {}): AccountRow {
  return {
    service_account_id: ACCOUNT_ID,
    client_id: CLIENT_ID,
    token_client_id: CLIENT_ID,
    account_status: 'active',
    client_status: 'active',
    key_hash: secretHash,
    ...overrides,
  };
}

interface Harness {
  service: ServiceTokenService;
  tokens: TokenService;
  queries: RecordedQuery[];
  /** Set to make the audit write throw, standing in for a database blip. */
  auditFails: { value: boolean };
}

function envWith(overrides: Record<string, string> = {}): EnvConfig {
  return parseEnv({
    NODE_ENV: 'test',
    DATABASE_URL: 'postgresql://app:pw@localhost:6543/plantops_iam',
    DATABASE_DIRECT_URL: 'postgresql://owner:pw@localhost:5432/plantops_iam',
    REDIS_URL: 'redis://localhost:6379',
    JWT_SIGNING_KEY_ID: 'key-a',
    JWT_PRIVATE_KEY: KEY.privateKey,
    JWT_PUBLIC_KEY: KEY.publicKey,
    PLATFORM_BOOTSTRAP_SECRET: 'x'.repeat(48),
    ...overrides,
  });
}

/** `rows` are returned to the lookup; the audit call gets an empty result. */
function harness(rows: AccountRow[], overrides: Record<string, string> = {}): Harness {
  const queries: RecordedQuery[] = [];
  const auditFails = { value: false };

  const database = {
    dataSource: {
      query: async (sql: string, parameters: unknown[] = []): Promise<unknown[]> => {
        queries.push({ sql, parameters });
        if (sql.includes('auth_record_service_token_failure')) {
          if (auditFails.value) throw new Error('the database is unreachable');
          return [];
        }
        return rows;
      },
    },
  } as unknown as DatabaseService;

  const env = envWith(overrides);
  const tokens = new TokenService(env, new KeysService(env));

  return {
    service: new ServiceTokenService(tokens, database),
    tokens,
    queries,
    auditFails,
  };
}

const exchange = (state: Harness, secret = SECRET) =>
  state.service.exchange({ accountKey: 'sa_a-key', accountSecret: secret });

/** The reason code recorded by the failure call, if one was made. */
function recordedReason(state: Harness): string | undefined {
  const call = state.queries.find((query) =>
    query.sql.includes('auth_record_service_token_failure'),
  );
  return call?.parameters[1] as string | undefined;
}

beforeAll(async () => {
  secretHash = await hashSecret(SECRET);
});

describe('ServiceTokenService.exchange — the token it issues (Doc 03 §5)', () => {
  it('issues a verifiable access token and no refresh token', async () => {
    const state = harness([activeRow()]);

    const response = await exchange(state);

    // Doc 03 §5: "no refresh; re-request as needed". The response type has no
    // slot for one, and this is the assertion that keeps it that way.
    expect(Object.keys(response).sort()).toEqual(['access_token', 'expires_in']);
    expect(state.tokens.verifyAccessToken(response.access_token)).toBeDefined();
  });

  it('names the account as the subject, with sty=service', async () => {
    const state = harness([activeRow()]);

    const claims = await claimsOf(state);

    expect(claims.sub).toBe(ACCOUNT_ID);
    expect(claims.sty).toBe(SubjectType.SERVICE);
    expect(claims.cid).toBe(CLIENT_ID);
  });

  it('carries exactly the seven Doc 03 §2 claims', async () => {
    const state = harness([activeRow()]);
    const response = await exchange(state);

    const payload = JSON.parse(
      Buffer.from(response.access_token.split('.')[1] as string, 'base64url').toString(
        'utf8',
      ),
    ) as Record<string, unknown>;

    // A service token is not a lesser token with fewer claims, nor a richer one
    // carrying the account's grants: it is the same closed set.
    expect(Object.keys(payload).sort()).toEqual([...JWT_CLAIM_KEYS].sort());
  });

  it('lives at most five minutes (Doc 03 §5)', async () => {
    const state = harness([activeRow()]);

    const response = await exchange(state);

    // The TTL *is* the revocation window for an identity whose sid is backed by
    // no row, which is why `@plantops/config` caps it rather than merely
    // defaulting it.
    expect(response.expires_in).toBeLessThanOrEqual(300);
    const claims = state.tokens.verifyAccessToken(response.access_token);
    expect(claims.exp - claims.iat).toBe(response.expires_in);
  });

  it('is shorter-lived than a human token from the same signer', async () => {
    const state = harness([activeRow()]);

    const service = await exchange(state);
    const human = state.tokens.issueAccessToken({
      subjectId: ACCOUNT_ID,
      subjectType: SubjectType.USER,
      clientId: CLIENT_ID,
      sessionId: '44444444-4444-4444-8444-444444444444',
    });

    expect(service.expires_in).toBeLessThan(human.expiresIn);
  });

  it('gives every exchange a fresh ephemeral sid', async () => {
    const first = await claimsOf(harness([activeRow()]));
    const second = await claimsOf(harness([activeRow()]));

    // Ephemeral and backed by no `session` row (Doc 03 §5). Two exchanges by the
    // same account must not share one, or revoking a session that does not
    // exist would be the *only* thing that could ever affect both.
    expect(first.sid).not.toBe(second.sid);
    expect(first.sid).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it('writes no session row — the lookup is the only statement it runs', async () => {
    const state = harness([activeRow()]);

    await exchange(state);

    expect(state.queries).toHaveLength(1);
    expect(state.queries[0]?.sql).toContain('auth_lookup_service_account');
  });

  it('authenticates a platform-level account into the platform tenant', async () => {
    // `client_id` null means platform-level (Doc 01 §3.7), but `cid` is required
    // and the RLS context is derived from it — so the lookup resolves the
    // platform client and that is what the token names. This is what makes the
    // bootstrap identity usable at all.
    const state = harness([
      activeRow({ client_id: null, token_client_id: PLATFORM_CLIENT_ID }),
    ]);

    expect((await claimsOf(state)).cid).toBe(PLATFORM_CLIENT_ID);
  });
});

describe('ServiceTokenService.exchange — refusals (Doc 03 §5)', () => {
  /**
   * The rows are built by a thunk, not held as values: `activeRow()` reads
   * {@link secretHash}, which `beforeAll` computes — and a `describe` body runs
   * before that, so an eager array would carry `undefined` as every key hash and
   * quietly turn all five cases into `bad_secret`.
   */
  const cases: Array<[string, () => AccountRow[], string, string]> = [
    ['an unknown key', () => [], 'unknown_account', SECRET],
    ['a wrong secret', () => [activeRow()], 'bad_secret', 'not-the-secret'],
    [
      'a revoked account',
      () => [activeRow({ account_status: 'revoked' })],
      'account_revoked',
      SECRET,
    ],
    [
      'a suspended tenant',
      () => [activeRow({ client_status: 'suspended' })],
      'client_suspended',
      SECRET,
    ],
    [
      'an account whose tenant cannot be resolved',
      () => [activeRow({ client_status: null, token_client_id: null })],
      'client_suspended',
      SECRET,
    ],
  ];

  it.each(cases)('refuses %s with a 401', async (_label, rows, _reason, secret) => {
    const state = harness(rows());

    await expect(exchange(state, secret)).rejects.toMatchObject({
      code: IamErrorCode.INVALID_CREDENTIALS,
    });
  });

  it.each(cases)('records %s as its own reason', async (_label, rows, reason, secret) => {
    const state = harness(rows());

    await exchange(state, secret).catch(() => undefined);

    // The audit trail keeps the distinction the response throws away: an
    // operator debugging an integration needs to know whether the key was wrong
    // or the secret was.
    expect(recordedReason(state)).toBe(reason);
  });

  it('only ever records a reason the function will accept', async () => {
    for (const [, rows, reason, secret] of cases) {
      const state = harness(rows());
      await exchange(state, secret).catch(() => undefined);

      // The closed set is enforced inside the definer function, which *raises*
      // on an unknown code — so a typo here would surface as a swallowed error
      // and a silently missing audit row rather than a test failure.
      expect(SERVICE_TOKEN_FAILURE_REASONS).toContain(reason);
      expect(recordedReason(state)).toBe(reason);
    }
  });

  it('gives every refusal the same message and status', async () => {
    const errors: IamException[] = [];
    for (const [, rows, , secret] of cases) {
      errors.push(
        (await exchange(harness(rows()), secret).catch(
          (error: IamException) => error,
        )) as IamException,
      );
    }

    // A response that distinguishes "revoked" from "wrong secret" tells the
    // holder of a stolen credential exactly how much the owner knows.
    const [first] = errors;
    for (const error of errors) {
      expect(error.message).toBe(first?.message);
      expect(error.getStatus()).toBe(401);
    }
  });

  it('checks the account status only after the secret', async () => {
    const state = harness([activeRow({ account_status: 'revoked' })]);

    await exchange(state, 'not-the-secret').catch(() => undefined);

    // Told "revoked" without presenting the right secret, a caller learns the
    // key is real and that somebody turned it off.
    expect(recordedReason(state)).toBe('bad_secret');
  });

  it('never lets the secret or the stored hash reach the audit call', async () => {
    const state = harness([activeRow()]);

    await exchange(state, 'not-the-secret').catch(() => undefined);

    const parameters = JSON.stringify(
      state.queries.flatMap((query) => query.parameters),
    );
    expect(parameters).not.toContain('not-the-secret');
    expect(parameters).not.toContain('$argon2');
  });

  it('still refuses when the audit write fails', async () => {
    const state = harness([]);
    state.auditFails.value = true;

    // Refusing is the security-relevant outcome. Turning a lost audit row into a
    // 500 would hand a caller a way to tell one failure mode from another.
    await expect(exchange(state)).rejects.toMatchObject({
      code: IamErrorCode.INVALID_CREDENTIALS,
    });
  });

  it('audits nothing on a successful exchange', async () => {
    const state = harness([activeRow()]);

    await exchange(state);

    // Deliberate (migration 0015's header): a machine collecting a five-minute
    // token forever would fill the trail with heartbeats, and the account is
    // already named on every action it goes on to take.
    expect(recordedReason(state)).toBeUndefined();
  });
});

async function claimsOf(state: Harness): Promise<JwtClaims> {
  const response = await exchange(state);
  return state.tokens.verifyAccessToken(response.access_token);
}
