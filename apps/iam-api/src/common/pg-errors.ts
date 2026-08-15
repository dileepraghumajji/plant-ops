/**
 * The SQLSTATEs this API reacts to by name.
 *
 * Two of them, and both mean "your request lost a race, not that it was wrong":
 *
 * - **40001 `serialization_failure`** — the transaction could not be serialized
 *   against a concurrent one. Only reachable at `REPEATABLE READ` or above,
 *   which today is the scope-node move of Doc 04 §7.1.
 * - **40P01 `deadlock_detected`** — two transactions each hold what the other
 *   wants and Postgres broke the tie. Reachable at any isolation level.
 *
 * They are grouped because the correct response to both is identical and is the
 * one Doc 04 §7.1 prescribes: **retry the whole transaction**. Neither leaves any
 * partial effect behind — Postgres has already rolled the block back — so a
 * retry starts from committed state rather than from a half-applied one.
 *
 * `23505` is deliberately not here. A unique violation means the request
 * conflicts with data that already exists, and retrying it would fail again;
 * `registry/conflict.ts` turns that one into a 409 with a message instead.
 */

import { QueryFailedError } from 'typeorm';

/** `serialization_failure` — a `REPEATABLE READ` / `SERIALIZABLE` conflict. */
export const PG_SERIALIZATION_FAILURE = '40001';

/** `deadlock_detected`. */
export const PG_DEADLOCK_DETECTED = '40P01';

/**
 * Is this a lost race that a retry could win?
 *
 * Reads the driver's `code` rather than matching on a message, which is
 * localized and version-dependent.
 */
export function isSerializationFailure(error: unknown): boolean {
  if (!(error instanceof QueryFailedError)) return false;
  const code = (error as QueryFailedError & { code?: string }).code;
  return code === PG_SERIALIZATION_FAILURE || code === PG_DEADLOCK_DETECTED;
}
