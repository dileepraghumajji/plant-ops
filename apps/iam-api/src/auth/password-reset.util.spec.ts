/**
 * Properties of the reset token itself (Doc 03 §7).
 *
 * The flow that spends one is `account-state.integration.spec.ts`, against a
 * real database. What is here is the part with no database in it: that the
 * secret is big and unpredictable, and that the stored form is a one-way
 * function of it that compares by equality.
 */

import { RESET_TOKEN_MAX_LENGTH, hashResetToken, mintResetToken } from './password-reset.util';

describe('mintResetToken', () => {
  it('produces 256 bits, base64url-encoded', () => {
    const token = mintResetToken();

    // 32 bytes → 43 base64url characters, unpadded.
    expect(token).toHaveLength(43);
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('fits inside the bound the DTO enforces', () => {
    expect(mintResetToken().length).toBeLessThanOrEqual(RESET_TOKEN_MAX_LENGTH);
  });

  it('never repeats', () => {
    // Not a randomness test — that is the CSPRNG's job — but it does catch the
    // class of mistake where a "token" is derived from something stable, like a
    // user id or a timestamp with second resolution.
    const tokens = new Set(Array.from({ length: 500 }, () => mintResetToken()));
    expect(tokens.size).toBe(500);
  });

  it('carries no address, unlike a refresh token', () => {
    // Deliberate: a reset token travels through email, and every identifier
    // baked into it leaks with it. A hash that matches nothing is simply
    // refused, so there is no row that needs finding.
    expect(mintResetToken()).not.toContain('~');
  });
});

describe('hashResetToken', () => {
  it('is deterministic, so the stored form can be compared for equality', () => {
    const token = mintResetToken();

    // The reason this is SHA-256 rather than argon2id: a salted hash is
    // different every time it is computed, and the lookup is `where token_hash = $1`.
    expect(hashResetToken(token)).toBe(hashResetToken(token));
  });

  it('does not reveal the token', () => {
    const token = mintResetToken();
    const hash = hashResetToken(token);

    expect(hash).not.toBe(token);
    expect(hash).not.toContain(token);
  });

  it('separates tokens that differ by one character', () => {
    const first = 'a'.repeat(43);
    const second = `${'a'.repeat(42)}b`;

    expect(hashResetToken(first)).not.toBe(hashResetToken(second));
  });

  it('is url- and header-safe, so it survives every transport it meets', () => {
    expect(hashResetToken(mintResetToken())).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});
