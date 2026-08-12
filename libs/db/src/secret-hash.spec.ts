/**
 * Unit tests for the shared credential hasher (Doc 03 §7).
 *
 * No database needed. These assert the properties every stored credential in
 * the system depends on — argon2id, pinned parameters, salted, and a verify
 * that fails closed.
 */

import { ARGON2_OPTIONS, hashSecret, verifySecret } from './secret-hash.js';

describe('hashSecret', () => {
  it('produces an argon2id hash with the pinned parameters', async () => {
    const hash = await hashSecret('correct horse battery staple');
    // Self-describing prefix: algorithm, version, then m/t/p. Pinning it here
    // means a library default moving underneath us fails the suite rather than
    // silently weakening every credential written afterwards.
    expect(hash).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    expect(ARGON2_OPTIONS.memoryCost).toBe(19_456);
    expect(ARGON2_OPTIONS.timeCost).toBe(2);
    expect(ARGON2_OPTIONS.parallelism).toBe(1);
  });

  it('never contains the secret', async () => {
    const secret = 'super-secret-value';
    expect(await hashSecret(secret)).not.toContain(secret);
  });

  it('salts, so the same secret hashes differently every time', async () => {
    // Without this, identical passwords would be visibly identical in the
    // table, and one cracked hash would reveal every account sharing it.
    const [a, b] = await Promise.all([hashSecret('same'), hashSecret('same')]);
    expect(a).not.toBe(b);
    await expect(verifySecret(a, 'same')).resolves.toBe(true);
    await expect(verifySecret(b, 'same')).resolves.toBe(true);
  });
});

describe('verifySecret', () => {
  it('accepts the right secret and rejects a wrong one', async () => {
    const hash = await hashSecret('right');
    await expect(verifySecret(hash, 'right')).resolves.toBe(true);
    await expect(verifySecret(hash, 'wrong')).resolves.toBe(false);
  });

  it.each([
    ['an empty string', ''],
    ['a near-miss', 'Right'],
    ['a prefix', 'righ'],
    ['a suffix', 'right '],
  ])('rejects %s', async (_label, candidate) => {
    expect(await verifySecret(await hashSecret('right'), candidate)).toBe(false);
  });

  it.each([
    ['an empty hash', ''],
    ['a plaintext value', 'not-a-hash'],
    ['a truncated hash', '$argon2id$v=19$m=19456'],
    ['a bcrypt hash', '$2b$12$abcdefghijklmnopqrstuv'],
  ])('fails closed on %s rather than throwing', async (_label, storedHash) => {
    // A corrupt or legacy row must read as "wrong secret". Throwing here would
    // put the decision in a caller's catch block, which is where an exception
    // quietly becomes an allow.
    await expect(verifySecret(storedHash, 'anything')).resolves.toBe(false);
  });

  it('round-trips a high-entropy machine secret', async () => {
    // The shape of a service-account secret (Doc 03 §5).
    const secret = Buffer.from(
      Array.from({ length: 32 }, (_, i) => (i * 37) % 256),
    ).toString('base64url');
    await expect(verifySecret(await hashSecret(secret), secret)).resolves.toBe(true);
  });
});
