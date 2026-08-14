/**
 * Minting the two halves of a service-account credential (Doc 03 §5, §7).
 *
 * ## Two values, and only one of them is a secret
 *
 * `account_key` is a public lookup handle: it identifies the account in the
 * exchange, in a log line, and in the list an operator reads. `account_secret`
 * is the credential, shown once at create and rotate and stored only as an
 * argon2id hash (Doc 03 §7). Keeping them separate is what lets the key be
 * displayed, searched and audited without the secret ever being adjacent to it.
 *
 * ## Why the key is generated rather than chosen
 *
 * `service_account.key` is globally unique (migration 0003) — it has to be,
 * because the exchange carries no tenant and the key must resolve an account on
 * its own. A caller-supplied key therefore has a cross-tenant uniqueness
 * constraint behind it, and a 409 on "acme-gatepass" would tell the caller that
 * *another tenant* already has an account by that name. That is a
 * cross-tenant existence oracle in a field nobody needs to choose.
 *
 * 128 random bits removes the question: collisions are not a thing that happens,
 * so create never has to fail for a reason it cannot explain, and the key leaks
 * nothing about who owns it. The `sa_` prefix is for humans and for secret
 * scanners — a bare base64url string in a config file is unidentifiable, and a
 * prefixed one can be recognised on sight and pattern-matched by tooling.
 *
 * ## Why the secret is 256 bits and hashed with argon2id anyway
 *
 * The entropy makes the work factor almost pointless — there is nothing to brute
 * force — and it is used regardless, because `@plantops/db`'s `hashSecret` is the
 * one hashing path in the system (see `secret-hash.ts`). "Which algorithm did
 * *this* column use?" is a question worth never having to ask, and the cost is
 * paid once per exchange rather than per request.
 *
 * That is also why this file, unlike `refresh-token.util.ts`, has no hash
 * function of its own: the stored form is argon2id via `hashSecret`, salted and
 * therefore not comparable by equality, so verification goes through
 * `verifySecret` rather than a lookup.
 */

import { randomBytes } from 'node:crypto';

/**
 * Prefix on every generated key. Chosen to be recognisable and inert: it is not
 * parsed, and the bootstrap account's `platform-bootstrap` key (migration 0011)
 * deliberately does not carry it — the prefix marks a *generated* key, not a
 * valid one.
 */
export const SERVICE_ACCOUNT_KEY_PREFIX = 'sa_';

/** 16 bytes — 128 bits, which is a uniqueness guarantee, not a secret. */
const KEY_BYTES = 16;

/** 32 bytes, as everywhere else a bearer secret is minted in this codebase. */
const SECRET_BYTES = 32;

/**
 * Bounds enforced at the DTO, because both values reach the database and one
 * reaches argon2 on an unauthenticated endpoint — and argon2id hashes whatever
 * it is handed, so an unbounded field is unbounded memory-hard work per request.
 * Stated with room to spare over the 25 and 43 characters actually minted.
 */
export const SERVICE_ACCOUNT_KEY_MAX_LENGTH = 128;
export const SERVICE_ACCOUNT_SECRET_MAX_LENGTH = 256;

/** A fresh public lookup handle. Unique by construction, not by retry. */
export function mintAccountKey(): string {
  return `${SERVICE_ACCOUNT_KEY_PREFIX}${randomBytes(KEY_BYTES).toString('base64url')}`;
}

/** A fresh secret. Returned once, stored only as an argon2id hash. */
export function mintAccountSecret(): string {
  return randomBytes(SECRET_BYTES).toString('base64url');
}
