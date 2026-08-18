/**
 * What a call through this client throws (Doc 06 §2).
 *
 * Two classes, because a caller has two genuinely different decisions to make.
 * {@link IamApiError} means the IAM answered and refused: there is a status, a
 * closed-table `code` to branch on, and a `requestId` that correlates the
 * refusal with the server's logs and its audit trail. {@link IamTransportError}
 * means no answer came back at all — DNS, TLS, a cut connection, a timeout, or
 * a body that was not the JSON it claimed to be. The first is a decision the
 * server made about the request; the second is not, and retrying it is
 * sometimes right where retrying the first never is.
 *
 * Both extend {@link IamClientError} so that `catch (e) { if (e instanceof
 * IamClientError) … }` covers everything this library throws, and nothing else.
 */

import {
  IamErrorCode,
  isIamErrorResponse,
  type IamErrorDetail,
} from '@plantops/contracts';

/** Base of every error this library throws. */
export class IamClientError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'IamClientError';
  }
}

/**
 * Status → code for a response that was *not* the Doc 06 §2 envelope.
 *
 * The IAM always sends the envelope — `INTERNAL_ERROR` was added to the table
 * in Session 6 precisely so that an unhandled exception still parses. But a
 * client does not only talk to the IAM: a reverse proxy's own 502, a load
 * balancer's 504 or a captive portal's HTML all arrive on the same socket, and
 * a consumer branching on `error.code` should not have to special-case the
 * shape it gets when something in between answered first. So a non-envelope
 * failure is still an {@link IamApiError}, with the nearest code the status
 * justifies and {@link IamApiError.inferred} set to say the code was not the
 * server's own word.
 */
const CODE_FOR_STATUS: Readonly<Record<number, IamErrorCode>> = Object.freeze({
  400: IamErrorCode.VALIDATION_FAILED,
  401: IamErrorCode.AUTH_REQUIRED,
  403: IamErrorCode.PERMISSION_DENIED,
  404: IamErrorCode.NOT_FOUND,
  409: IamErrorCode.CONFLICT,
  423: IamErrorCode.ACCOUNT_LOCKED,
  429: IamErrorCode.RATE_LIMITED,
});

/** A response the IAM refused, in the terms Doc 06 §2 defines. */
export class IamApiError extends IamClientError {
  readonly status: number;
  readonly code: IamErrorCode;
  /**
   * The correlation handle from the envelope, or the `X-Request-Id` header when
   * the body was not an envelope. `null` when neither was present — which is
   * itself a sign that the answer did not come from the IAM.
   */
  readonly requestId: string | null;
  /** Field-level complaints; only `VALIDATION_FAILED` carries them. */
  readonly details: readonly IamErrorDetail[];
  /** True when {@link code} was inferred from the status, not read from a body. */
  readonly inferred: boolean;

  constructor(init: {
    status: number;
    code: IamErrorCode;
    message: string;
    requestId?: string | null;
    details?: readonly IamErrorDetail[];
    inferred?: boolean;
  }) {
    super(init.message);
    this.name = 'IamApiError';
    this.status = init.status;
    this.code = init.code;
    this.requestId = init.requestId ?? null;
    this.details = init.details ?? [];
    this.inferred = init.inferred ?? false;
  }

  /**
   * Builds the error from what a failed response actually carried.
   *
   * `body` is the already-parsed JSON, or `undefined` when the body was not
   * JSON at all — an HTML error page from something in front of the API being
   * the ordinary case.
   */
  static from(
    status: number,
    body: unknown,
    fallback: { requestId?: string | null; text?: string } = {},
  ): IamApiError {
    if (isIamErrorResponse(body)) {
      const { code, message, requestId, details } = body.error;
      return new IamApiError({ status, code, message, requestId, details });
    }

    const code = CODE_FOR_STATUS[status] ?? IamErrorCode.INTERNAL_ERROR;
    const excerpt = (fallback.text ?? '').trim().slice(0, 200);
    return new IamApiError({
      status,
      code,
      message:
        excerpt === ''
          ? `HTTP ${status} from the IAM, with no error envelope.`
          : `HTTP ${status} from the IAM, with no error envelope: ${excerpt}`,
      requestId: fallback.requestId ?? null,
      inferred: true,
    });
  }

  /** `if (error.is(IamErrorCode.NOT_FOUND))` — the common branch, spelled once. */
  is(code: IamErrorCode): boolean {
    return this.code === code;
  }
}

/**
 * The request never produced an answer to refuse it: a network fault, an abort,
 * a timeout, or a success body that would not parse as JSON.
 */
export class IamTransportError extends IamClientError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'IamTransportError';
  }
}

export function isIamApiError(value: unknown): value is IamApiError {
  return value instanceof IamApiError;
}

export function isIamClientError(value: unknown): value is IamClientError {
  return value instanceof IamClientError;
}
