/**
 * argon2id hashing for stored credentials (Doc 03 §7).
 *
 * Two kinds of secret pass through here, and both are hashed the same way:
 *
 * - **User passwords** — low-entropy and human-chosen, which is exactly the
 *   case argon2id's memory-hardness exists for (Session 8).
 * - **Service-account secrets** — high-entropy machine tokens, where the work
 *   factor matters far less. They use the same function anyway: one hashing
 *   path is one thing to audit, and "which algorithm did *this* column use?"
 *   is a question worth never having to ask.
 *
 * The parameters are pinned in {@link ARGON2_OPTIONS} rather than left to the
 * library's defaults. A hash records the parameters it was made with, so
 * verification keeps working across an upgrade — but *new* hashes would
 * silently change strength if the library moved its defaults, and that drift
 * is invisible until someone audits it.
 *
 * Lives in `libs/db` because migration 0011 seeds a hashed secret and
 * `libs/db` is what a migration may import (Doc 08 §2). `apps/iam-api` may
 * import this lib, so Sessions 8 and 11 consume it from here — they must not
 * grow a second hasher.
 */

import { hash, verify, type Algorithm } from '@node-rs/argon2';

/**
 * `Algorithm.Argon2id`, written as its numeric value.
 *
 * `@node-rs/argon2` declares `Algorithm` as an ambient `const enum`, and this
 * workspace compiles with `isolatedModules`, under which reading a member of
 * one is a type error (TS2748) — the emitted JS would need an inlined value the
 * single-file transpiler cannot see. The identifier does exist at runtime
 * (`{ Argon2d: 0, Argon2i: 1, Argon2id: 2 }`), and the ordering is fixed by the
 * argon2 specification, so the literal is stable.
 *
 * `secret-hash.spec.ts` asserts the produced hash actually starts with
 * `$argon2id$`, which is what would catch this being wrong.
 */
const ARGON2ID = 2 as Algorithm;

/**
 * OWASP's recommended argon2id baseline: 19 MiB of memory, 2 iterations, 1
 * lane. Raising these is safe at any time — existing hashes carry their own
 * parameters and still verify; only newly written hashes get the new cost.
 */
export const ARGON2_OPTIONS = {
  algorithm: ARGON2ID,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

/**
 * Hashes a secret for storage. The result is self-describing —
 * `$argon2id$v=19$m=19456,t=2,p=1$<salt>$<digest>` — and embeds a random salt,
 * so no salt column is needed and two identical secrets never collide.
 */
export async function hashSecret(secret: string): Promise<string> {
  return hash(secret, ARGON2_OPTIONS);
}

/**
 * Verifies a candidate against a stored hash.
 *
 * Returns `false` rather than throwing on a malformed or unparseable hash: a
 * corrupt row must read as "wrong secret", never as an exception that a caller
 * might catch into an allow. Timing-safe comparison is the library's job.
 */
export async function verifySecret(storedHash: string, candidate: string): Promise<boolean> {
  try {
    return await verify(storedHash, candidate);
  } catch {
    return false;
  }
}
