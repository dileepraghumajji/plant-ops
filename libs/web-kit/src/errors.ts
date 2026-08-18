'use client';

/**
 * Turning whatever `catch` produced into something a screen can render.
 *
 * `@plantops/iam-client` throws two classes — `IamApiError` for a refusal the
 * IAM made, `IamTransportError` for a request that never got an answer — and a
 * screen may also be handed a `TypeError` from its own code. All three arrive
 * at the same `catch`, and every screen would otherwise grow the same
 * `instanceof` ladder.
 *
 * The result pairs the machine-readable facts (code, status, request id) with
 * the human-readable copy from `@plantops/ui`, so the caller renders a
 * `<ScreenError>` without knowing which of the three it caught.
 */

import type { IamErrorCode } from '@plantops/contracts';
import { IamApiError, IamClientError } from '@plantops/iam-client';
import { errorCopyFor, TRANSPORT_ERROR_COPY, type ErrorCopy } from '@plantops/ui';

export interface DescribedError {
  /** The Doc 06 §2 code, or `null` when nothing answered. */
  code: IamErrorCode | null;
  status: number | null;
  /** Words for a person. */
  copy: ErrorCopy;
  /** The server's own message, when it says more than the copy does. */
  detail: string | null;
  /** Correlates with server logs and the audit trail. */
  requestId: string | null;
  /** Field-level complaints; only a `VALIDATION_FAILED` carries them. */
  details: readonly { field: string; message: string }[];
}

/** Normalises any thrown value into {@link DescribedError}. */
export function describeError(error: unknown): DescribedError {
  if (error instanceof IamApiError) {
    return {
      code: error.code,
      status: error.status,
      copy: errorCopyFor(error.code),
      detail: error.message,
      requestId: error.requestId,
      details: error.details,
    };
  }

  if (error instanceof IamClientError) {
    // A transport failure: DNS, TLS, a cut connection, a timeout, or a body
    // that would not parse. Nothing was decided about the request.
    return {
      code: null,
      status: null,
      copy: TRANSPORT_ERROR_COPY,
      detail: error.message,
      requestId: null,
      details: [],
    };
  }

  return {
    code: null,
    status: null,
    copy: TRANSPORT_ERROR_COPY,
    detail: error instanceof Error ? error.message : null,
    requestId: null,
    details: [],
  };
}

/**
 * True when the failure means "you may not", rather than "that went wrong".
 *
 * The distinction a screen acts on: a denial is a final answer that deserves an
 * explanation panel, where a transient failure deserves a retry button. Both
 * 403 codes count — `PERMISSION_DENIED` (no such permission) and `SCOPE_DENIED`
 * (the permission, but not here) — because to the person looking at the screen
 * they are the same wall, differing only in what they should ask for.
 */
export function isAccessDenial(error: unknown): boolean {
  return error instanceof IamApiError && error.status === 403;
}

/** True when the session is gone and the console should return to the login page. */
export function isAuthenticationFailure(error: unknown): boolean {
  return error instanceof IamApiError && error.status === 401;
}
