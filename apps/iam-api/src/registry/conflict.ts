/**
 * Turning a Postgres uniqueness failure into the Doc 06 §2 conflict.
 *
 * `HttpExceptionFilter` already maps SQLSTATE 23505 to a 409, so nothing here is
 * load-bearing for the *status*. What it adds is the message: the filter's is
 * deliberately generic ("The request conflicts with existing data") because it
 * cannot know which constraint fired without quoting a name that reveals
 * columns, and, on the tenant tables, tenants.
 *
 * The registry has no such reticence to observe. Its rows are catalog — no
 * `client_id`, globally readable (Doc 07 §6) — and the caller is a platform
 * admin who just named the key in the request body. Telling them *which* key
 * collided reveals nothing they did not send, and it is the difference between
 * a 409 an operator can fix and one they have to bisect a bulk body to explain.
 *
 * The check-then-insert alternative would produce the same message without this
 * file, and would be wrong: two concurrent registrations of the same key would
 * both find nothing and both proceed, so the index has to be the arbiter
 * regardless. Catching what it throws is the only version with no window.
 */

import { QueryFailedError } from 'typeorm';
import { IamException } from '../common/iam.exception';

/** SQLSTATE 23505 — unique violation. */
const PG_UNIQUE_VIOLATION = '23505';

export function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof QueryFailedError &&
    (error as QueryFailedError & { code?: string }).code === PG_UNIQUE_VIOLATION
  );
}

/**
 * Rethrows `error` as a 409 `CONFLICT` with `message` when it is a uniqueness
 * failure, and unchanged otherwise.
 *
 * Returns `never`, so a `catch` block that calls it needs no `throw` of its own
 * and cannot fall through to a `return undefined` the caller would then have to
 * handle.
 */
export function rethrowAsConflict(error: unknown, message: string): never {
  if (isUniqueViolation(error)) throw IamException.conflict(message);
  throw error;
}
