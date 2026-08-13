/**
 * `JwksVerifier` — local verification against a published key set (Doc 03 §1).
 *
 * Real RSA keys and a real JWKS document throughout. Mocking the crypto would
 * leave the interesting half untested: what matters is that a genuine signature
 * verifies under the key its `kid` names, that a genuine signature under
 * *another* key does not, and that the rotation and refetch behaviour holds
 * without either stalling on a dead IAM or hammering a live one.
 */

import {
  JWKS_CACHE_MAX_AGE_SECONDS,
  SubjectType,
  type JwtClaims,
} from '@plantops/contracts';
import { createPublicKey, generateKeyPairSync, type KeyObject } from 'node:crypto';
import { TokenRejection, TokenVerificationError } from './claims';
import { JwksVerifier } from './jwks-verifier';
import { privateKeyFromPem, signCompactJws } from './jws';

const ISSUER = 'plantops-iam';
const JWKS_URI = 'https://iam.example.test/iam/.well-known/jwks.json';

function generatePair(bits = 2048) {
  return generateKeyPairSync('rsa', {
    modulusLength: bits,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
}

// Generated once: 2048-bit keygen dominates the suite otherwise.
const KEY_A = generatePair();
const KEY_B = generatePair();
const WEAK = generatePair(1024);

/** A JWKS entry for a PEM public key, as `keys.service.ts` would publish it. */
function jwkFor(publicKeyPem: string, kid: string): Record<string, unknown> {
  const jwk = (createPublicKey(publicKeyPem) as KeyObject).export({
    format: 'jwk',
  }) as Record<string, unknown>;
  return { ...jwk, kid, use: 'sig', alg: 'RS256' };
}

function claims(overrides: Partial<JwtClaims> = {}): JwtClaims {
  const now = Math.floor(Date.now() / 1000);
  return {
    iss: ISSUER,
    sub: 'user-1',
    sty: SubjectType.USER,
    cid: 'client-1',
    sid: 'session-1',
    iat: now,
    exp: now + 900,
    ...overrides,
  };
}

function tokenSignedWith(privateKeyPem: string, kid: string, payload = claims()) {
  return signCompactJws(
    { ...payload },
    privateKeyFromPem(privateKeyPem, 'test'),
    kid,
  );
}

/** A `fetch` that serves a fixed document and counts how often it was asked. */
function jwksServer(keys: Record<string, unknown>[]) {
  const fetchMock = jest.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ keys }),
  })) as unknown as typeof globalThis.fetch;
  return { fetch: fetchMock, calls: () => (fetchMock as jest.Mock).mock.calls.length };
}

function verifierFor(
  server: ReturnType<typeof jwksServer>,
  overrides: Record<string, unknown> = {},
) {
  return new JwksVerifier({
    jwksUri: JWKS_URI,
    issuer: ISSUER,
    fetch: server.fetch,
    ...overrides,
  });
}

async function expectRejection(
  promise: Promise<unknown>,
  reason: TokenRejection,
): Promise<void> {
  await promise.then(
    () => {
      throw new Error(`Expected rejection with reason "${reason}"`);
    },
    (error: unknown) => {
      expect(error).toBeInstanceOf(TokenVerificationError);
      expect((error as TokenVerificationError).reason).toBe(reason);
    },
  );
}

describe('JwksVerifier', () => {
  it('verifies a genuine token against the key its kid names', async () => {
    const server = jwksServer([jwkFor(KEY_A.publicKey, 'key-a')]);
    const verifier = verifierFor(server);

    const verified = await verifier.verify(tokenSignedWith(KEY_A.privateKey, 'key-a'));

    expect(verified.sub).toBe('user-1');
    expect(verified.cid).toBe('client-1');
  });

  it('rejects a token whose signature belongs to a different key', async () => {
    // The `kid` says key-a; the signature is key-b's. Selection by `kid` means
    // this is a bad signature rather than a lucky match against some other
    // published key — trying every key in turn would make retention during a
    // rotation into a signature oracle.
    const server = jwksServer([
      jwkFor(KEY_A.publicKey, 'key-a'),
      jwkFor(KEY_B.publicKey, 'key-b'),
    ]);
    const verifier = verifierFor(server);

    await expectRejection(
      verifier.verify(tokenSignedWith(KEY_B.privateKey, 'key-a')),
      TokenRejection.BAD_SIGNATURE,
    );
  });

  it('keeps verifying tokens signed by a retired key still in the set', async () => {
    // Doc 03 §1 step 4: the old public key stays published for at least one
    // access-token lifetime, so rotation never invalidates a live token.
    const server = jwksServer([
      jwkFor(KEY_B.publicKey, 'key-b'),
      jwkFor(KEY_A.publicKey, 'key-a'),
    ]);
    const verifier = verifierFor(server);

    await expect(
      verifier.verify(tokenSignedWith(KEY_A.privateKey, 'key-a')),
    ).resolves.toMatchObject({ sub: 'user-1' });
  });

  it('refetches once for an unknown kid, then accepts the newly published key', async () => {
    // The rotation window: this process holds a key set from just before the
    // new key was published. Rejecting without looking would turn every
    // rotation into a burst of spurious 401s lasting one cache TTL.
    let published = [jwkFor(KEY_A.publicKey, 'key-a')];
    const fetchMock = jest.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ keys: published }),
    })) as unknown as typeof globalThis.fetch;

    const verifier = new JwksVerifier({
      jwksUri: JWKS_URI,
      issuer: ISSUER,
      fetch: fetchMock,
      minRefetchIntervalSeconds: 0,
    });

    await verifier.verify(tokenSignedWith(KEY_A.privateKey, 'key-a'));
    published = [jwkFor(KEY_A.publicKey, 'key-a'), jwkFor(KEY_B.publicKey, 'key-b')];

    await expect(
      verifier.verify(tokenSignedWith(KEY_B.privateKey, 'key-b')),
    ).resolves.toMatchObject({ sub: 'user-1' });
  });

  it('rejects an unknown kid rather than trying other keys', async () => {
    const server = jwksServer([jwkFor(KEY_A.publicKey, 'key-a')]);
    const verifier = verifierFor(server, { minRefetchIntervalSeconds: 0 });

    await expectRejection(
      verifier.verify(tokenSignedWith(KEY_A.privateKey, 'no-such-kid')),
      TokenRejection.UNKNOWN_KEY,
    );
  });

  it('does not refetch on every unknown kid — that path is attacker-reachable', async () => {
    const server = jwksServer([jwkFor(KEY_A.publicKey, 'key-a')]);
    // The default floor. Without it, a stream of tokens carrying forged `kid`s
    // is a free way to make every module hammer the IAM.
    const verifier = verifierFor(server);

    for (let i = 0; i < 5; i += 1) {
      await verifier
        .verify(tokenSignedWith(KEY_A.privateKey, `forged-${i}`))
        .catch(() => undefined);
    }

    expect(server.calls()).toBe(1);
  });

  it('serves repeat verifications from cache within the max-age', async () => {
    const server = jwksServer([jwkFor(KEY_A.publicKey, 'key-a')]);
    const verifier = verifierFor(server, {
      cacheMaxAgeSeconds: JWKS_CACHE_MAX_AGE_SECONDS,
    });

    for (let i = 0; i < 3; i += 1) {
      await verifier.verify(tokenSignedWith(KEY_A.privateKey, 'key-a'));
    }

    // The point of local verification: the IAM is off the request path.
    expect(server.calls()).toBe(1);
  });

  it('keeps using the cached keys when the JWKS endpoint is down', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ keys: [jwkFor(KEY_A.publicKey, 'key-a')] }),
      })
      .mockRejectedValue(new Error('connection refused')) as unknown as typeof fetch;

    const verifier = new JwksVerifier({
      jwksUri: JWKS_URI,
      issuer: ISSUER,
      fetch: fetchMock,
      cacheMaxAgeSeconds: 0,
    });

    await verifier.verify(tokenSignedWith(KEY_A.privateKey, 'key-a'));

    // A brief IAM outage must not become a fleet-wide auth outage: the keys
    // already held are almost certainly still correct.
    await expect(
      verifier.verify(tokenSignedWith(KEY_A.privateKey, 'key-a')),
    ).resolves.toMatchObject({ sub: 'user-1' });
  });

  it('applies the shared 60 s leeway to an expired token', async () => {
    const server = jwksServer([jwkFor(KEY_A.publicKey, 'key-a')]);
    const verifier = verifierFor(server);
    const now = Math.floor(Date.now() / 1000);

    const justExpired = tokenSignedWith(
      KEY_A.privateKey,
      'key-a',
      claims({ iat: now - 940, exp: now - 40 }),
    );
    const longExpired = tokenSignedWith(
      KEY_A.privateKey,
      'key-a',
      claims({ iat: now - 1000, exp: now - 100 }),
    );

    // Inside the leeway a token is still live — the IAM and every module must
    // agree on this boundary or minor NTP drift produces spurious 401s.
    await expect(verifier.verify(justExpired)).resolves.toBeDefined();
    await expectRejection(verifier.verify(longExpired), TokenRejection.EXPIRED);
  });

  it('rejects a token from another issuer', async () => {
    const server = jwksServer([jwkFor(KEY_A.publicKey, 'key-a')]);
    const verifier = verifierFor(server);

    await expectRejection(
      verifier.verify(
        tokenSignedWith(KEY_A.privateKey, 'key-a', claims({ iss: 'someone-else' })),
      ),
      TokenRejection.WRONG_ISSUER,
    );
  });

  it('ignores a published key too small to be safe', async () => {
    // RS256 is only as strong as the modulus. A verifier that accepted whatever
    // the endpoint served would accept a key that can be factored, at which
    // point anyone can mint tokens it trusts.
    const server = jwksServer([jwkFor(WEAK.publicKey, 'weak')]);
    const verifier = verifierFor(server, { minRefetchIntervalSeconds: 0 });

    await expectRejection(
      verifier.verify(tokenSignedWith(WEAK.privateKey, 'weak')),
      TokenRejection.UNKNOWN_KEY,
    );
  });

  it('ignores an unusable entry without discarding the rest of the set', async () => {
    const server = jwksServer([
      { kty: 'EC', kid: 'future-ec', crv: 'P-256', x: 'x', y: 'y' },
      { kty: 'RSA', kid: 'malformed', n: 'not-base64url!!', e: 'AQAB' },
      jwkFor(KEY_A.publicKey, 'key-a'),
    ]);
    const verifier = verifierFor(server);

    // One entry the IAM adds in future must not take every token down with it.
    await expect(
      verifier.verify(tokenSignedWith(KEY_A.privateKey, 'key-a')),
    ).resolves.toMatchObject({ sub: 'user-1' });
  });

  it('refuses a document that carries private key material', async () => {
    const privateJwk = {
      ...jwkFor(KEY_A.publicKey, 'key-a'),
      d: 'private-exponent',
    };
    const server = jwksServer([privateJwk]);
    const verifier = verifierFor(server, { minRefetchIntervalSeconds: 0 });

    // A JWKS carrying `d` is a misconfigured or hostile endpoint, and importing
    // it would hand this process signing capability it must never have.
    await expectRejection(
      verifier.verify(tokenSignedWith(KEY_A.privateKey, 'key-a')),
      TokenRejection.UNKNOWN_KEY,
    );
  });

  it('rejects a token that is not a compact JWS at all', async () => {
    const server = jwksServer([jwkFor(KEY_A.publicKey, 'key-a')]);
    const verifier = verifierFor(server);

    await expectRejection(verifier.verify('not-a-token'), TokenRejection.MALFORMED);
    expect(server.calls()).toBe(0);
  });
});
