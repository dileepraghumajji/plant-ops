/**
 * Minting and matching password-reset tokens (Doc 03 §7).
 *
 * ## The shape: one secret, no address
 *
 * A refresh token carries its session id in front of the secret, because reuse
 * detection has to find the row even when the hash matches nothing
 * (`refresh-token.util.ts` sets out why). A reset token needs no such thing: a
 * hash that matches nothing means the token is not one we issued, and the only
 * correct response is a flat refusal. There is no row to punish, so there is
 * nothing to address.
 *
 * That absence is worth keeping. A reset token travels through email, which is
 * to say through logs, previews, forwarding rules and whatever scans the
 * mailbox; every identifier baked into it is an identifier that leaks with it.
 * A bare secret leaks nothing but itself, and by the time it does the row it
 * belongs to may already be spent.
 *
 * ## The hash is SHA-256, and the password it sets is argon2id
 *
 * Both are correct and the difference is the input. A reset token is 256 bits
 * from the system CSPRNG: the search space *is* the key space, a work factor
 * buys nothing against it, and a salt would break the equality comparison the
 * lookup depends on. The password the token is exchanged for is human-chosen
 * and low-entropy, which is exactly the case argon2id exists for — so
 * {@link PasswordResetService} hashes that with `@plantops/db`'s `hashSecret`.
 *
 * ## Where the comparison happens
 *
 * Not here. Only the hash crosses into Postgres, and
 * `iam.auth_complete_password_reset` compares it under `for update` — because
 * the check and the spend have to be atomic, or two concurrent presentations of
 * one token would each set a password.
 */

import { createHash, randomBytes } from 'node:crypto';

/** 32 bytes, as everywhere else a bearer secret is minted in this codebase. */
const RESET_SECRET_BYTES = 32;

/**
 * 43 characters of base64url, stated with room to spare and enforced at the
 * DTO: the value reaches a hash function on an unauthenticated endpoint.
 */
export const RESET_TOKEN_MAX_LENGTH = 128;

/** A fresh reset token. Never stored; only its hash is. */
export function mintResetToken(): string {
  return randomBytes(RESET_SECRET_BYTES).toString('base64url');
}

/** The stored form of a reset token — never the token itself. */
export function hashResetToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('base64url');
}
