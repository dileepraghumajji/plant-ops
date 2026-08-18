/**
 * What each `IamErrorCode` says to a person (Doc 06 §2 → the screen).
 *
 * The server's `message` is written for an operator reading a log: accurate,
 * terse, and occasionally about a constraint name. This is the other half —
 * what an admin should be told and, more usefully, what they should do next.
 * It lives in `libs/ui` because it is copy, and copy is part of the design
 * language: the gatepass console must not invent a second, differently-worded
 * explanation of a 403.
 *
 * Two rules the table obeys, both from the spec rather than from taste:
 *
 * - **A denial never speculates about what exists.** Doc 06 §2 requires that a
 *   403 not reveal whether the target exists in another tenant, and copy is
 *   exactly where that leaks: "this role belongs to another client" would say
 *   out loud what the status code was careful not to.
 * - **`ACCOUNT_LOCKED` gets its own words.** Doc 03 §8 makes 423 a distinct
 *   state with a distinct remedy — an administrator unlocks it; retrying the
 *   password never will — and Doc 09's login screen is required to say so
 *   rather than folding it into "sign-in failed".
 */

import { IamErrorCode } from '@plantops/contracts';

/** How prominently a failure should be shown. */
export type ErrorTone = 'error' | 'warning' | 'info';

export interface ErrorCopy {
  /** Headline. A statement of what happened, never an apology. */
  title: string;
  /** One or two sentences: what it means, and what to do. */
  description: string;
  tone: ErrorTone;
  /** Whether repeating the same request could plausibly succeed. */
  retryable: boolean;
}

const COPY: Readonly<Record<IamErrorCode, ErrorCopy>> = Object.freeze({
  [IamErrorCode.VALIDATION_FAILED]: {
    title: 'Check the highlighted fields',
    description: 'Some values were rejected. Correct them and submit again.',
    tone: 'warning',
    retryable: false,
  },
  [IamErrorCode.AUTH_REQUIRED]: {
    title: 'Your session has ended',
    description: 'Sign in again to continue.',
    tone: 'info',
    retryable: false,
  },
  [IamErrorCode.INVALID_CREDENTIALS]: {
    title: 'Sign-in failed',
    description:
      'That email and password combination was not accepted for this client. Check the client, the address and the password, then try again.',
    tone: 'error',
    retryable: true,
  },
  [IamErrorCode.PERMISSION_DENIED]: {
    title: 'You do not have access to this',
    description:
      'Your roles do not include the permission this screen needs. An administrator can grant it by binding you to a role that carries it.',
    tone: 'warning',
    retryable: false,
  },
  [IamErrorCode.SCOPE_DENIED]: {
    title: 'Not permitted here',
    description:
      'You hold this permission, but not at a place in the organisation that covers what you are trying to reach. Access follows the org tree — ask for a binding higher up, or at the right node.',
    tone: 'warning',
    retryable: false,
  },
  [IamErrorCode.NOT_FOUND]: {
    title: 'Not found',
    description: 'This item no longer exists, or you cannot reach it.',
    tone: 'info',
    retryable: false,
  },
  [IamErrorCode.CONFLICT]: {
    title: 'That conflicts with something already there',
    description:
      'A record with these details already exists, or the change would break a rule the server enforces. The details below say which.',
    tone: 'warning',
    retryable: false,
  },
  [IamErrorCode.ACCOUNT_LOCKED]: {
    title: 'This account is locked',
    description:
      'Too many failed sign-in attempts, or an administrator locked it. Signing in will keep failing until an administrator unlocks the account — a password reset will not clear the lock.',
    tone: 'error',
    retryable: false,
  },
  [IamErrorCode.RATE_LIMITED]: {
    title: 'Too many requests',
    description: 'You have made too many attempts. Wait a moment and try again.',
    tone: 'warning',
    retryable: true,
  },
  [IamErrorCode.INTERNAL_ERROR]: {
    title: 'Something went wrong on the server',
    description:
      'The request did not complete. If it keeps happening, quote the request id below to whoever runs this deployment.',
    tone: 'error',
    retryable: true,
  },
});

/** Copy for a request that never reached the API at all. */
export const TRANSPORT_ERROR_COPY: ErrorCopy = Object.freeze({
  title: 'Could not reach the server',
  description:
    'The request did not get an answer — the network, a proxy, or the service being down. Check your connection and try again.',
  tone: 'error',
  retryable: true,
});

/** The copy for a code. Unknown codes fall back to the transport wording. */
export function errorCopyFor(code: IamErrorCode | null | undefined): ErrorCopy {
  if (code == null) return TRANSPORT_ERROR_COPY;
  return COPY[code] ?? TRANSPORT_ERROR_COPY;
}
