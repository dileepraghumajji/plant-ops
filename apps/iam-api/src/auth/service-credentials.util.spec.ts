/**
 * The two halves of a service-account credential (Doc 03 §5, §7).
 *
 * Small surface, and the properties worth pinning are the ones a refactor could
 * quietly weaken: enough entropy that a key never has to be retried and a secret
 * is never worth guessing, and a prefix that stays on the key so a secret
 * scanner and a human reading a config file can both recognise one.
 */

import { hashSecret, verifySecret } from '@plantops/db';
import {
  SERVICE_ACCOUNT_KEY_MAX_LENGTH,
  SERVICE_ACCOUNT_KEY_PREFIX,
  SERVICE_ACCOUNT_SECRET_MAX_LENGTH,
  mintAccountKey,
  mintAccountSecret,
} from './service-credentials.util';

const BASE64URL = /^[A-Za-z0-9_-]+$/;

describe('mintAccountKey', () => {
  it('carries the prefix that identifies a generated key', () => {
    expect(mintAccountKey().startsWith(SERVICE_ACCOUNT_KEY_PREFIX)).toBe(true);
  });

  it('is base64url after the prefix, so it survives headers, JSON and URLs', () => {
    const body = mintAccountKey().slice(SERVICE_ACCOUNT_KEY_PREFIX.length);
    expect(body).toMatch(BASE64URL);
    // 16 bytes → 22 base64url characters, unpadded.
    expect(body).toHaveLength(22);
  });

  it('fits the bound the DTO enforces', () => {
    expect(mintAccountKey().length).toBeLessThanOrEqual(SERVICE_ACCOUNT_KEY_MAX_LENGTH);
  });

  it('does not repeat', () => {
    // 128 bits is what makes `unique(key)` a constraint that never fires, which
    // is what lets create succeed without a retry loop — and, more to the point,
    // without a 409 that would reveal another tenant's key.
    const keys = new Set(Array.from({ length: 500 }, () => mintAccountKey()));
    expect(keys.size).toBe(500);
  });
});

describe('mintAccountSecret', () => {
  it('is 256 bits of base64url', () => {
    const secret = mintAccountSecret();
    expect(secret).toMatch(BASE64URL);
    expect(secret).toHaveLength(43);
  });

  it('fits the bound the DTO enforces', () => {
    expect(mintAccountSecret().length).toBeLessThanOrEqual(
      SERVICE_ACCOUNT_SECRET_MAX_LENGTH,
    );
  });

  it('does not repeat', () => {
    const secrets = new Set(Array.from({ length: 500 }, () => mintAccountSecret()));
    expect(secrets.size).toBe(500);
  });

  it('carries no prefix — it is not an identifier', () => {
    // The key is meant to be recognisable; the secret is meant to be opaque.
    // A shared prefix would make a leaked secret look like a harmless key.
    expect(mintAccountSecret().startsWith(SERVICE_ACCOUNT_KEY_PREFIX)).toBe(false);
  });

  it('round-trips through the one hashing path in the system', async () => {
    const secret = mintAccountSecret();
    const stored = await hashSecret(secret);

    expect(stored).toMatch(/^\$argon2id\$/);
    expect(stored).not.toContain(secret);
    await expect(verifySecret(stored, secret)).resolves.toBe(true);
    await expect(verifySecret(stored, mintAccountSecret())).resolves.toBe(false);
  });
});
