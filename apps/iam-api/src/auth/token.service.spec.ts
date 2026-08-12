/**
 * Token issuance and verification (Doc 03 §1–2, §5–6).
 *
 * Real RSA keys throughout, generated once for the file. Mocking the crypto
 * would leave the interesting half untested: the properties worth asserting
 * here are that a *genuine* signature verifies, that a genuinely tampered one
 * does not, and that a forged header cannot talk the verifier into a different
 * algorithm. None of those survive a stubbed signer.
 */

import { parseEnv, type EnvConfig } from '@plantops/config';
import { JWT_CLAIM_KEYS, SubjectType } from '@plantops/contracts';
import { createHmac, createSign, generateKeyPairSync } from 'node:crypto';
import { KeysService } from './keys.service';
import { TokenRejection, TokenService, TokenVerificationError } from './token.service';

function generatePair() {
  return generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
}

// Generated once: 2048-bit keygen is slow enough that per-test generation
// dominates the suite's runtime.
const KEY_A = generatePair();
const KEY_B = generatePair();

function envWith(overrides: Record<string, string> = {}): EnvConfig {
  return parseEnv({
    NODE_ENV: 'test',
    DATABASE_URL: 'postgresql://app:pw@localhost:6543/plantops_iam',
    DATABASE_DIRECT_URL: 'postgresql://owner:pw@localhost:5432/plantops_iam',
    REDIS_URL: 'redis://localhost:6379',
    JWT_SIGNING_KEY_ID: 'key-a',
    JWT_PRIVATE_KEY: KEY_A.privateKey,
    JWT_PUBLIC_KEY: KEY_A.publicKey,
    PLATFORM_BOOTSTRAP_SECRET: 'x'.repeat(48),
    ...overrides,
  });
}

function serviceWith(overrides: Record<string, string> = {}): TokenService {
  const env = envWith(overrides);
  return new TokenService(env, new KeysService(env));
}

const SUBJECT = {
  subjectId: '11111111-1111-4111-8111-111111111111',
  subjectType: SubjectType.USER,
  clientId: '22222222-2222-4222-8222-222222222222',
  sessionId: '33333333-3333-4333-8333-333333333333',
} as const;

/** Rebuilds a token with a modified payload, signed by `privateKey`. */
function resign(
  payload: Record<string, unknown>,
  privateKey: string,
  kid: string,
  header: Record<string, unknown> = {},
): string {
  const head = Buffer.from(
    JSON.stringify({ alg: 'RS256', typ: 'JWT', kid, ...header }),
  ).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signer = createSign('sha256');
  signer.update(`${head}.${body}`);
  return `${head}.${body}.${signer.sign(privateKey).toString('base64url')}`;
}

describe('TokenService — issuance (Doc 03 §2)', () => {
  it('signs a token that verifies through the published key', () => {
    const service = serviceWith();
    const { accessToken, claims } = service.issueAccessToken(SUBJECT);

    expect(service.verifyAccessToken(accessToken)).toEqual(claims);
  });

  it('carries exactly the seven Doc 03 §2 claims and nothing else', () => {
    const { accessToken } = serviceWith().issueAccessToken(SUBJECT);
    const payload = JSON.parse(
      Buffer.from(accessToken.split('.')[1] as string, 'base64url').toString('utf8'),
    );

    // Set comparison, not a subset check: the assertion is that permissions,
    // roles and scopes are *absent*, which a subset check would not catch.
    expect(Object.keys(payload).sort()).toEqual([...JWT_CLAIM_KEYS].sort());
  });

  it('names the signing key in the header so verifiers can select it', () => {
    const { accessToken } = serviceWith().issueAccessToken(SUBJECT);
    const header = JSON.parse(
      Buffer.from(accessToken.split('.')[0] as string, 'base64url').toString('utf8'),
    );

    expect(header).toMatchObject({ alg: 'RS256', typ: 'JWT', kid: 'key-a' });
  });

  it('sets exp from the human TTL for a user subject', () => {
    const now = new Date('2026-01-01T00:00:00Z');
    const { claims, expiresIn } = serviceWith().issueAccessToken(SUBJECT, now);

    expect(expiresIn).toBe(900);
    expect(claims.exp - claims.iat).toBe(900);
    expect(claims.iat).toBe(Math.floor(now.getTime() / 1000));
  });

  it('caps a service token at the shorter TTL — the revocation window (Doc 03 §5)', () => {
    const { expiresIn, claims } = serviceWith().issueAccessToken({
      ...SUBJECT,
      subjectType: SubjectType.SERVICE,
    });

    expect(expiresIn).toBe(300);
    expect(claims.sty).toBe(SubjectType.SERVICE);
  });
});

describe('TokenService — verification (Doc 03 §6)', () => {
  function expectRejection(fn: () => unknown, reason: TokenRejection) {
    try {
      fn();
    } catch (error) {
      expect(error).toBeInstanceOf(TokenVerificationError);
      expect((error as TokenVerificationError).reason).toBe(reason);
      return;
    }
    throw new Error(`expected a ${reason} rejection, but verification succeeded`);
  }

  it('rejects a token whose payload was edited after signing', () => {
    const service = serviceWith();
    const { accessToken } = service.issueAccessToken(SUBJECT);
    const [head, , signature] = accessToken.split('.');

    // Swap the tenant — the claim RLS trusts absolutely (Doc 07 §5).
    const forged = Buffer.from(
      JSON.stringify({
        ...service.verifyAccessToken(accessToken),
        cid: '99999999-9999-4999-8999-999999999999',
      }),
    ).toString('base64url');

    expectRejection(
      () => service.verifyAccessToken(`${head}.${forged}.${signature}`),
      TokenRejection.BAD_SIGNATURE,
    );
  });

  it('rejects a token signed by a key that is not published', () => {
    const service = serviceWith();
    const claims = service.issueAccessToken(SUBJECT).claims;

    expectRejection(
      () => service.verifyAccessToken(resign({ ...claims }, KEY_B.privateKey, 'key-b')),
      TokenRejection.UNKNOWN_KEY,
    );
  });

  it('rejects a valid signature presented under another published kid', () => {
    // Both keys are in JWKS, so the verifier *could* find a key that works if
    // it tried them all. It must not: selection is by kid alone, or key
    // retention becomes a signature oracle.
    const service = serviceWith({
      JWT_RETIRED_PUBLIC_KEYS: JSON.stringify({ 'key-b': KEY_B.publicKey }),
    });
    const claims = service.issueAccessToken(SUBJECT).claims;

    expectRejection(
      () => service.verifyAccessToken(resign({ ...claims }, KEY_B.privateKey, 'key-a')),
      TokenRejection.BAD_SIGNATURE,
    );
  });

  it('rejects alg: none — the unsigned-token forgery', () => {
    const service = serviceWith();
    const claims = service.issueAccessToken(SUBJECT).claims;
    const head = Buffer.from(
      JSON.stringify({ alg: 'none', typ: 'JWT', kid: 'key-a' }),
    ).toString('base64url');
    const body = Buffer.from(JSON.stringify(claims)).toString('base64url');

    // Signature segment must be non-empty to reach the algorithm check; an
    // empty one is caught earlier as malformed. Either way it never verifies.
    expectRejection(
      () => service.verifyAccessToken(`${head}.${body}.AA`),
      TokenRejection.UNSUPPORTED_ALGORITHM,
    );
  });

  it('rejects HS256 forged with the public key as the HMAC secret', () => {
    const service = serviceWith();
    const claims = service.issueAccessToken(SUBJECT).claims;

    const head = Buffer.from(
      JSON.stringify({ alg: 'HS256', typ: 'JWT', kid: 'key-a' }),
    ).toString('base64url');
    const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
    const mac = createHmac('sha256', KEY_A.publicKey)
      .update(`${head}.${body}`)
      .digest('base64url');

    expectRejection(
      () => service.verifyAccessToken(`${head}.${body}.${mac}`),
      TokenRejection.UNSUPPORTED_ALGORITHM,
    );
  });

  it('rejects an expired token, allowing the 60 s leeway (Doc 03 §6)', () => {
    const service = serviceWith();
    const issuedAt = new Date('2026-01-01T00:00:00Z');
    const { accessToken } = service.issueAccessToken(SUBJECT, issuedAt);

    // exp is issuedAt + 900. At +930 the leeway still covers it; at +961 it
    // does not.
    const withinLeeway = new Date(issuedAt.getTime() + 930_000);
    expect(service.verifyAccessToken(accessToken, withinLeeway).sub).toBe(
      SUBJECT.subjectId,
    );

    const past = new Date(issuedAt.getTime() + 961_000);
    expectRejection(
      () => service.verifyAccessToken(accessToken, past),
      TokenRejection.EXPIRED,
    );
  });

  it('rejects a token issued further in the future than the leeway allows', () => {
    const service = serviceWith();
    const future = new Date('2026-01-01T00:10:00Z');
    const { accessToken } = service.issueAccessToken(SUBJECT, future);

    expectRejection(
      () => service.verifyAccessToken(accessToken, new Date('2026-01-01T00:00:00Z')),
      TokenRejection.NOT_YET_VALID,
    );
  });

  it('rejects a token from another issuer', () => {
    const service = serviceWith();
    const claims = service.issueAccessToken(SUBJECT).claims;

    expectRejection(
      () =>
        service.verifyAccessToken(
          resign({ ...claims, iss: 'somebody-else' }, KEY_A.privateKey, 'key-a'),
        ),
      TokenRejection.WRONG_ISSUER,
    );
  });

  it('rejects a validly-signed token carrying extra claims', () => {
    const service = serviceWith();
    const claims = service.issueAccessToken(SUBJECT).claims;

    // Permissions in a token is the specific thing Doc 03 §2 forbids: it would
    // survive a grant revocation for the life of the token.
    expectRejection(
      () =>
        service.verifyAccessToken(
          resign(
            { ...claims, permissions: ['iam.client.users.write'] },
            KEY_A.privateKey,
            'key-a',
          ),
        ),
      TokenRejection.BAD_CLAIMS,
    );
  });

  it.each([
    ['a missing claim', (c: Record<string, unknown>) => omit(c, 'sid')],
    ['a non-string cid', (c: Record<string, unknown>) => ({ ...c, cid: 42 })],
    ['an empty sub', (c: Record<string, unknown>) => ({ ...c, sub: '' })],
    ['a non-integer exp', (c: Record<string, unknown>) => ({ ...c, exp: 1.5 })],
    ['an unknown sty', (c: Record<string, unknown>) => ({ ...c, sty: 'robot' })],
  ])('rejects %s even when the signature is genuine', (_label, mutate) => {
    const service = serviceWith();
    const claims = service.issueAccessToken(SUBJECT).claims;

    expectRejection(
      () =>
        service.verifyAccessToken(
          resign(mutate({ ...claims }), KEY_A.privateKey, 'key-a'),
        ),
      TokenRejection.BAD_CLAIMS,
    );
  });

  it.each([
    ['not three segments', 'a.b'],
    ['non-base64url characters', 'aa+/.bb.cc'],
    ['a payload that is not JSON', 'eyJhbGciOiJSUzI1NiIsImtpZCI6ImtleS1hIn0.bm90anNvbg.AA'],
    ['no kid in the header', 'eyJhbGciOiJSUzI1NiJ9.e30.AA'],
    ['nothing at all', ''],
  ])('rejects %s as malformed', (_label, token) => {
    expectRejection(
      () => serviceWith().verifyAccessToken(token),
      TokenRejection.MALFORMED,
    );
  });
});

describe('TokenService — key rotation (Doc 03 §1)', () => {
  it('keeps tokens signed by the previous key valid after the switch', () => {
    // Step 3 has happened: key-b signs, key-a is retained in JWKS.
    const before = serviceWith();
    const { accessToken } = before.issueAccessToken(SUBJECT);

    const after = serviceWith({
      JWT_SIGNING_KEY_ID: 'key-b',
      JWT_PRIVATE_KEY: KEY_B.privateKey,
      JWT_PUBLIC_KEY: KEY_B.publicKey,
      JWT_RETIRED_PUBLIC_KEYS: JSON.stringify({ 'key-a': KEY_A.publicKey }),
    });

    // The whole point of the retention step: an in-flight token does not care
    // that the signer moved on.
    expect(after.verifyAccessToken(accessToken).sub).toBe(SUBJECT.subjectId);
    // And the new signer works in the same instance.
    expect(
      after.verifyAccessToken(after.issueAccessToken(SUBJECT).accessToken).sub,
    ).toBe(SUBJECT.subjectId);
  });

  it('rejects tokens from a key once it has been retired out of JWKS', () => {
    const before = serviceWith();
    const { accessToken } = before.issueAccessToken(SUBJECT);

    // Step 4: key-a removed entirely.
    const after = serviceWith({
      JWT_SIGNING_KEY_ID: 'key-b',
      JWT_PRIVATE_KEY: KEY_B.privateKey,
      JWT_PUBLIC_KEY: KEY_B.publicKey,
    });

    expect(() => after.verifyAccessToken(accessToken)).toThrow(TokenVerificationError);
  });
});

function omit(source: Record<string, unknown>, key: string) {
  const copy = { ...source };
  delete copy[key];
  return copy;
}
