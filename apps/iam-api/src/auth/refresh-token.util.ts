/**
 * Minting and matching opaque refresh tokens (Doc 03 §1, §4).
 *
 * ## Why these are not argon2, when passwords are
 *
 * A password is low-entropy and human-chosen, so its stored form must be
 * expensive to attack — that is the whole reason argon2id exists, and why every
 * hash it produces embeds a random salt.
 *
 * A refresh token is 256 bits from the system CSPRNG. There is nothing to brute
 * force: the search space *is* the key space, and a work factor buys nothing
 * against it. What a salt would cost, however, is decisive — the refresh flow
 * looks a session up **by** the stored hash (`session_refresh_token_hash_key`,
 * migration 0004), and a salted hash is different every time it is computed, so
 * there would be nothing to look up. It would mean scanning every live session
 * and running argon2 against each.
 *
 * SHA-256 is the right primitive for exactly this shape: deterministic, so it
 * indexes; preimage-resistant, so a leaked database row does not yield the
 * token. This is the standard treatment for high-entropy bearer secrets and it
 * is not a weakening of Doc 03 §7 — that section governs *credentials a human
 * chooses*.
 *
 * ## Comparison
 *
 * Lookup is by equality on an indexed column, which is not constant-time — but
 * it does not need to be. Timing a b-tree probe reveals whether a *hash* exists,
 * and an attacker who can already compute the hash of a token holds the token.
 * There is nothing to learn.
 */

import { createHash, randomBytes } from 'node:crypto';

/**
 * 32 bytes. Below ~128 bits a bearer token starts to be worth attacking online;
 * 256 removes the question entirely and costs 43 characters.
 */
const REFRESH_TOKEN_BYTES = 32;

/**
 * A fresh refresh token, base64url so it survives headers, JSON and URLs
 * without escaping.
 */
export function mintRefreshToken(): string {
  return randomBytes(REFRESH_TOKEN_BYTES).toString('base64url');
}

/** The stored form of a refresh token — never the token itself (Doc 03 §1). */
export function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('base64url');
}
