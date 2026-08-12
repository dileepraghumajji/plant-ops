/**
 * Key set and JWKS (Doc 03 §1).
 *
 * The assertions that matter most here are negative: that no private material
 * can reach the published document, and that a key set which would break every
 * consumer is refused at boot rather than at the first login.
 */

import { parseEnv, type EnvConfig } from '@plantops/config';
import { generateKeyPairSync } from 'node:crypto';
import { KeyConfigurationError, KeysService } from './keys.service';

function generatePair(bits = 2048) {
  return generateKeyPairSync('rsa', {
    modulusLength: bits,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
}

const KEY_A = generatePair();
const KEY_B = generatePair();
const WEAK = generatePair(1024);

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

const keysWith = (overrides: Record<string, string> = {}) =>
  new KeysService(envWith(overrides));

describe('KeysService — the published JWKS', () => {
  it('publishes the signing key as an RS256 signature key', () => {
    const { keys } = keysWith().jwks();

    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatchObject({ kty: 'RSA', kid: 'key-a', use: 'sig', alg: 'RS256' });
    expect(keys[0]?.n).toEqual(expect.any(String));
    expect(keys[0]?.e).toBe('AQAB');
  });

  it('publishes retained keys alongside the signer, signer first', () => {
    const { keys } = keysWith({
      JWT_RETIRED_PUBLIC_KEYS: JSON.stringify({ 'key-b': KEY_B.publicKey }),
    }).jwks();

    expect(keys.map((key) => key.kid)).toEqual(['key-a', 'key-b']);
  });

  it('never emits private key material', () => {
    const jwks = keysWith({
      JWT_RETIRED_PUBLIC_KEYS: JSON.stringify({ 'key-b': KEY_B.publicKey }),
    }).jwks();

    // `d` is the RSA private exponent; `p`/`q`/`dp`/`dq`/`qi` are the CRT
    // factors. Any of them in a JWKS is a total compromise of the key.
    for (const key of jwks.keys) {
      for (const field of ['d', 'p', 'q', 'dp', 'dq', 'qi'] as const) {
        expect(key).not.toHaveProperty(field);
      }
    }
    // Belt and braces: the serialised document must not contain the PEM either.
    expect(JSON.stringify(jwks)).not.toContain('PRIVATE');
  });

  it('resolves a kid collision in favour of the live signer', () => {
    // A stale entry left in the retained map must not shadow the real signer —
    // that would publish a key that cannot verify anything this instance signs.
    const service = keysWith({
      JWT_RETIRED_PUBLIC_KEYS: JSON.stringify({ 'key-a': KEY_B.publicKey }),
    });

    expect(service.verificationKey('key-a')).toBe(service.signingKey().publicKey);
    expect(service.jwks().keys).toHaveLength(1);
  });

  it('returns undefined for an unpublished kid — the refetch-then-reject path', () => {
    expect(keysWith().verificationKey('never-published')).toBeUndefined();
  });
});

describe('KeysService — boot-time assertions (Doc 03 §1)', () => {
  it('accepts a well-formed key set', () => {
    expect(() =>
      keysWith({
        JWT_RETIRED_PUBLIC_KEYS: JSON.stringify({ 'key-b': KEY_B.publicKey }),
      }).assertKeysUsable(),
    ).not.toThrow();
  });

  it('rejects a public key that is not the pair of the private key', () => {
    // The realistic rotation mistake: one of the two variables updated. Nothing
    // else catches it — signing succeeds and JWKS looks perfectly valid, while
    // every token issued is unverifiable everywhere.
    expect(() =>
      keysWith({ JWT_PUBLIC_KEY: KEY_B.publicKey }).assertKeysUsable(),
    ).toThrow(/does not match JWT_PRIVATE_KEY/);
  });

  it('rejects an RSA key below the minimum size', () => {
    expect(() =>
      keysWith({
        JWT_PRIVATE_KEY: WEAK.privateKey,
        JWT_PUBLIC_KEY: WEAK.publicKey,
      }).assertKeysUsable(),
    ).toThrow(/1024-bit RSA key; the minimum is 2048/);
  });

  it('rejects a retained key that is unreadable, naming its kid', () => {
    expect(() =>
      keysWith({
        JWT_RETIRED_PUBLIC_KEYS: JSON.stringify({
          'key-b': '-----BEGIN PUBLIC KEY-----\nnot-a-key\n-----END PUBLIC KEY-----',
        }),
      }).assertKeysUsable(),
    ).toThrow(/JWT_RETIRED_PUBLIC_KEYS\["key-b"\]/);
  });

  it('reports every problem at once rather than one restart at a time', () => {
    try {
      keysWith({
        JWT_PRIVATE_KEY: WEAK.privateKey,
        JWT_PUBLIC_KEY: KEY_B.publicKey,
      }).assertKeysUsable();
    } catch (error) {
      expect(error).toBeInstanceOf(KeyConfigurationError);
      expect((error as KeyConfigurationError).issues.length).toBeGreaterThan(1);
      return;
    }
    throw new Error('expected the key set to be rejected');
  });

  it('never quotes key material in its error messages', () => {
    try {
      keysWith({
        JWT_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----\nrubbish\n-----END PRIVATE KEY-----',
      }).assertKeysUsable();
    } catch (error) {
      expect((error as Error).message).not.toContain('rubbish');
      return;
    }
    throw new Error('expected the key set to be rejected');
  });
});
