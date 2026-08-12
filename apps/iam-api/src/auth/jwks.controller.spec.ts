/**
 * `GET /iam/.well-known/jwks.json` through the assembled app (Doc 03 §1).
 *
 * Via the harness rather than by calling the controller, because the claims
 * being made are about the *route*: that it is reachable without a token, that
 * it is not swallowed by the transaction wrapper, and that the caching header
 * a rotation depends on actually reaches the wire. None of those are properties
 * of the controller class.
 */

import { generateKeyPairSync } from 'node:crypto';
import { createHarness, testEnv, type Harness } from '../testing/app-harness';

const KEY = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

const JWKS_PATH = '/iam/.well-known/jwks.json';

describe('GET /iam/.well-known/jwks.json', () => {
  let harness: Harness;

  beforeAll(async () => {
    harness = await createHarness({
      env: testEnv({
        JWT_SIGNING_KEY_ID: 'live-key',
        JWT_PRIVATE_KEY: KEY.privateKey,
        JWT_PUBLIC_KEY: KEY.publicKey,
      }),
    });
  });

  afterAll(async () => {
    await harness.close();
  });

  it('serves the key set without authentication', async () => {
    // A verifier has no token yet; requiring one to fetch the keys that verify
    // tokens is a bootstrap that cannot complete.
    const response = await harness.get(JWKS_PATH);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      keys: [
        expect.objectContaining({ kid: 'live-key', kty: 'RSA', use: 'sig', alg: 'RS256' }),
      ],
    });
  });

  it('states its cache lifetime, which is what makes the rotation wait real', async () => {
    const response = await harness.get(JWKS_PATH);

    // Doc 03 §1 step 2 says to wait "at least one cache TTL" before switching
    // signers. `tools/rotate-keys.ts` computes that wait from the same
    // constant; if this header stops matching, the wait is a guess again.
    expect(response.headers.get('cache-control')).toBe('public, max-age=300');
  });

  it('is served as a JWK set', async () => {
    const response = await harness.get(JWKS_PATH);

    expect(response.headers.get('content-type')).toContain('application/jwk-set+json');
  });

  it('answers without touching the database', async () => {
    // Key material comes from the environment. If serving it opened a
    // transaction, every consumer's ability to verify a signature would depend
    // on Postgres being up.
    const before = harness.database.events.length;
    await harness.get(JWKS_PATH);

    expect(harness.database.events).toHaveLength(before);
  });
});
