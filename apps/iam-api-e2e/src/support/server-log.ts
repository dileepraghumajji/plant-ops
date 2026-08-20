/**
 * Reading the API's captured output.
 *
 * One thing needs it: the password-reset token. Doc 03 §7's reset is tokenised
 * and single-use, v1 binds no mail transport, and
 * `LoggingPasswordResetDelivery` prints the token to the log outside production
 * precisely so the flow is completable on a developer's machine. That log line
 * is the only place the token exists outside the requester — reading it is what
 * a developer does by hand, and what lets this battery drive
 * invite → reset → login without going behind the API into the database.
 *
 * It is also why the reset half of `auth-flows.e2e.ts` is a *black-box* test: a
 * suite that read `password_reset_token.token_hash` would be asserting on the
 * storage, not on the flow, and would keep passing if delivery broke.
 */

import { readFileSync } from 'node:fs';

/** Nest colourises unless told not to; `api-process.ts` sets `NO_COLOR`, and
 * this is the belt for that pair of braces. */
// eslint-disable-next-line no-control-regex
const ANSI = /\[[0-9;]*m/g;

function logPath(): string {
  const path = process.env['E2E_API_LOG'];
  if (path === undefined) {
    throw new Error('E2E_API_LOG is unset — see support/test-setup.ts.');
  }
  return path;
}

/** The whole captured log, ANSI stripped. */
export function readServerLog(): string {
  return readFileSync(logPath(), 'utf8').replace(ANSI, '');
}

/**
 * Waits for a line matching `pattern` and returns its first capture group.
 *
 * Polling rather than watching: the API writes to the file descriptor directly
 * and a `fs.watch` on Windows reports changes late enough that a watcher is
 * strictly worse than reading a small file every 50 ms.
 *
 * @param after only consider matches beyond this offset — see {@link logSize}.
 *   Without it the second reset in a suite finds the first one's token, which
 *   is a test that passes while the feature is broken.
 */
export async function waitForLogMatch(
  pattern: RegExp,
  after = 0,
  timeoutMs = 15_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const match = pattern.exec(readServerLog().slice(after));
    // `exec` on a non-global regex has no lastIndex to reset, which is why the
    // patterns below are not `/g`.
    if (match?.[1] !== undefined) return match[1];
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  throw new Error(
    `No line matching ${pattern} appeared in ${logPath()} within ${timeoutMs} ms.`,
  );
}

/** The current length of the log — the `after` offset for the next wait. */
export function logSize(): number {
  return readServerLog().length;
}

/** The token `LoggingPasswordResetDelivery` printed after `after`. */
export function waitForResetToken(after: number): Promise<string> {
  return waitForLogMatch(/token:\s*([A-Za-z0-9_-]{16,})/, after);
}
