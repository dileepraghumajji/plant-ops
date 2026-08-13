/**
 * Password verification for login (Doc 03 §3, §7).
 *
 * Hashing itself is `@plantops/db`'s `hashSecret`/`verifySecret` — one argon2id
 * path for the whole system, so there is never a question of which algorithm a
 * given column used. What is here is the part specific to *authenticating*: the
 * work that has to happen even when there is nobody to authenticate.
 *
 * ## Why a verification runs for users that do not exist
 *
 * Doc 03 §3 requires an unknown user and a bad password to be indistinguishable.
 * Returning early for the unknown user satisfies that in the response body and
 * breaks it in the timing: argon2id is deliberately expensive — tens of
 * milliseconds — so "no such user" would answer in one millisecond and "wrong
 * password" in fifty. That gap is measurable over the network and turns login
 * into a user-enumeration oracle, which is precisely what the generic 401 was
 * protecting against.
 *
 * So {@link verifyPasswordCandidate} verifies against {@link DUMMY_HASH} when
 * no hash was found, and returns false. Same code path, same cost, same
 * observable behaviour.
 *
 * This is *not* a constant-time guarantee. argon2 timing varies a little, and
 * the surrounding request has database work whose duration differs by branch.
 * It removes the order-of-magnitude difference, which is the part an attacker
 * can actually use; a truly flat login is a bigger project than this and buys
 * little (Doc 03 §3 asks for no enumeration hints, not for a side-channel-free
 * endpoint).
 */

import { verifySecret } from '@plantops/db';
import { z } from 'zod';

/**
 * A genuine argon2id hash of 32 random bytes that were never recorded.
 *
 * Hard-coded rather than computed at boot for two reasons: a computed one would
 * make the module's cost depend on when it is first imported, and a literal is
 * inspectable — a reviewer can see the parameters it carries instead of
 * trusting that the generator was called correctly.
 *
 * It must be a *parseable* hash, not a plausible-looking string: `verifySecret`
 * returns false without doing any work on a malformed one, which would restore
 * the very timing gap this exists to close. Its parameters match
 * `ARGON2_OPTIONS` (m=19456, t=2, p=1) for the same reason, and
 * `password.util.spec.ts` asserts both.
 */
export const DUMMY_HASH =
  '$argon2id$v=19$m=19456,t=2,p=1$rFHL74OeCwnhEmyPqH4Wpw$4W9pas2aphMGb8u2rNubWMLflKJ6+ILFP0kPiElvT4s';

/**
 * True when `candidate` matches `storedHash`.
 *
 * `storedHash` is nullable because that is how the absence of a user, or of a
 * password identity for one, arrives here — and the whole point is that those
 * cases cost the same as a wrong password.
 */
export async function verifyPasswordCandidate(
  storedHash: string | null | undefined,
  candidate: string,
): Promise<boolean> {
  if (storedHash === null || storedHash === undefined || storedHash === '') {
    await verifySecret(DUMMY_HASH, candidate);
    return false;
  }
  return verifySecret(storedHash, candidate);
}

/**
 * Minimum password policy (Doc 03 §7).
 *
 * Length only, deliberately. Composition rules ("one uppercase, one symbol")
 * push people toward `Password1!` and are not what NIST 800-63B recommends;
 * length is the term that actually matters. The breach-list check Doc 03 §7
 * calls optional is a Session 10 concern, alongside reset.
 *
 * The upper bound is not a policy but a denial-of-service control: argon2id
 * hashes whatever it is given, and an unbounded field is an unbounded amount of
 * memory-hard work per request.
 */
export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 256;

export const passwordSchema = z
  .string()
  .min(PASSWORD_MIN_LENGTH, `Password must be at least ${PASSWORD_MIN_LENGTH} characters`)
  .max(PASSWORD_MAX_LENGTH, `Password must be at most ${PASSWORD_MAX_LENGTH} characters`);
