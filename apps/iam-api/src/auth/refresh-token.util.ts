/**
 * Minting, formatting and matching opaque refresh tokens (Doc 03 §1, §4).
 *
 * ## The shape: `<session id>~<secret>`
 *
 * A refresh token is two parts. The secret is 256 bits from the system CSPRNG
 * and is the only half that authenticates anything; the session id in front of
 * it is an *address*, so that any token — current, one generation old, or five —
 * names the row that has to judge it.
 *
 * That addressing is what makes Doc 03 §4's hardest case answerable at all.
 * Reuse detection has to revoke the session when a token "older than one
 * generation" turns up, and an old generation's hash is stored nowhere: looked
 * up by hash, such a token is indistinguishable from noise and the compromised
 * session would be left running. Looked up by id, the row is found, the hash
 * matches neither generation, and the session dies as it should.
 *
 * Nothing is given away by that. The session id is already the `sid` claim of
 * the access token the same client is carrying (Doc 03 §2), so anyone in a
 * position to read a session id out of a refresh token is holding a token that
 * could simply call `/auth/logout`.
 *
 * `~` as the separator, not `.`: a refresh token is deliberately not a JWT, and
 * a dot-delimited string invites both readers and code to treat it as one. `~`
 * is unreserved in URLs (RFC 3986) and outside the base64url alphabet, so the
 * split is unambiguous and the token still survives headers, JSON and URLs
 * unescaped.
 *
 * ## Why the hash is not argon2, when passwords are
 *
 * A password is low-entropy and human-chosen, so its stored form must be
 * expensive to attack — that is the whole reason argon2id exists.
 *
 * A refresh secret is 256 bits from the CSPRNG. There is nothing to brute
 * force: the search space *is* the key space, and a work factor buys nothing
 * against it. What a salt would cost, however, is real — the stored hash is
 * compared for equality against the value a caller presents, and a salted hash
 * is different every time it is computed.
 *
 * SHA-256 is the right primitive for exactly this shape: deterministic, so it
 * compares; preimage-resistant, so a leaked database row does not yield the
 * token. This is the standard treatment for high-entropy bearer secrets and it
 * is not a weakening of Doc 03 §7 — that section governs *credentials a human
 * chooses*.
 *
 * ## Where the comparison happens
 *
 * Not here. Only the hash crosses into Postgres, and
 * `iam.auth_rotate_refresh_token` compares it against both generations inside
 * the same statement that locks the row — because the comparison and the
 * rotation have to be atomic, not because equality is delicate. Timing a
 * `text = text` reveals whether a *hash* matches, and an attacker who can
 * compute that hash already holds the token.
 */

import { createHash, randomBytes } from 'node:crypto';

/**
 * 32 bytes. Below ~128 bits a bearer token starts to be worth attacking online;
 * 256 removes the question entirely and costs 43 characters.
 */
const REFRESH_SECRET_BYTES = 32;

/** The one character that is neither in a UUID nor in base64url. */
const REFRESH_TOKEN_SEPARATOR = '~';

/**
 * 36 (uuid) + 1 + 43 (base64url of 32 bytes) = 80. The bound is stated with
 * room to spare and enforced at the DTO, because the value reaches a hash
 * function on an unauthenticated endpoint.
 */
export const REFRESH_TOKEN_MAX_LENGTH = 128;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SECRET_PATTERN = /^[A-Za-z0-9_-]{16,}$/;

export interface ParsedRefreshToken {
  /** The `session.id` the token addresses — an address, not a credential. */
  sessionId: string;
  /** The half that actually proves anything. */
  secret: string;
}

/** A fresh secret, base64url. Never stored; only its hash is. */
export function mintRefreshSecret(): string {
  return randomBytes(REFRESH_SECRET_BYTES).toString('base64url');
}

/** The stored form of a refresh secret — never the secret itself (Doc 03 §1). */
export function hashRefreshSecret(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('base64url');
}

/** The token a client receives: the session it belongs to, then the secret. */
export function formatRefreshToken(sessionId: string, secret: string): string {
  return `${sessionId}${REFRESH_TOKEN_SEPARATOR}${secret}`;
}

/**
 * Splits a presented token, or returns `null` if it is not one.
 *
 * Strict on both halves — a well-formed uuid and a plausible secret — because
 * the session id goes on to a `uuid` query parameter and a malformed one would
 * surface as a 500 rather than the 401 a bad token deserves. Everything this
 * rejects is refused generically by the caller: a token that does not parse and
 * a token that names no session are the same answer, and telling them apart
 * would say whether a session id exists.
 */
export function parseRefreshToken(token: string): ParsedRefreshToken | null {
  if (token.length > REFRESH_TOKEN_MAX_LENGTH) return null;

  const separator = token.indexOf(REFRESH_TOKEN_SEPARATOR);
  if (separator === -1) return null;

  const sessionId = token.slice(0, separator);
  const secret = token.slice(separator + 1);
  if (!UUID_PATTERN.test(sessionId) || !SECRET_PATTERN.test(secret)) return null;

  return { sessionId, secret };
}
