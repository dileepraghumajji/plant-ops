/**
 * Error contract — the envelope and the code table from Doc 06 §2.
 *
 * The table there is authoritative and closed: adding a code is a spec change,
 * not an implementation detail, because consumers (`iam-client`, admin-web,
 * every future module) branch on these values.
 */

export const IamErrorCode = {
  /** 400 — request failed validation; see `details` for the offending fields. */
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  /** 401 — no (or unverifiable) bearer token. */
  AUTH_REQUIRED: 'AUTH_REQUIRED',
  /** 401 — login rejected. Generic by design: never hints at user existence. */
  INVALID_CREDENTIALS: 'INVALID_CREDENTIALS',
  /** 403 — subject does not hold the required permission. */
  PERMISSION_DENIED: 'PERMISSION_DENIED',
  /** 403 — permission held, but not at a scope node covering the target. */
  SCOPE_DENIED: 'SCOPE_DENIED',
  /** 404 — target absent (within the caller's tenant). */
  NOT_FOUND: 'NOT_FOUND',
  /** 409 — duplicate key or cross-tenant violation. */
  CONFLICT: 'CONFLICT',
  /** 423 — account is locked (Doc 03 §8). */
  ACCOUNT_LOCKED: 'ACCOUNT_LOCKED',
  /** 429 — throttled. */
  RATE_LIMITED: 'RATE_LIMITED',
  /**
   * 500 — the request failed for a reason the server did not anticipate.
   *
   * The one code a caller can never act on, and the one every caller must be
   * able to parse: without it, an unhandled exception escapes as some other
   * body shape and `isIamErrorResponse` rejects the server's own error. The
   * `message` is always generic — an exception's text can carry a query, a
   * connection string, or a row — and `requestId` is what correlates it with
   * the logged stack (Doc 06 §2, added Session 6).
   */
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const;
export type IamErrorCode = (typeof IamErrorCode)[keyof typeof IamErrorCode];

/** Every code, in Doc 06 §2 table order. */
export const IAM_ERROR_CODES = [
  IamErrorCode.VALIDATION_FAILED,
  IamErrorCode.AUTH_REQUIRED,
  IamErrorCode.INVALID_CREDENTIALS,
  IamErrorCode.PERMISSION_DENIED,
  IamErrorCode.SCOPE_DENIED,
  IamErrorCode.NOT_FOUND,
  IamErrorCode.CONFLICT,
  IamErrorCode.ACCOUNT_LOCKED,
  IamErrorCode.RATE_LIMITED,
  IamErrorCode.INTERNAL_ERROR,
] as const satisfies readonly IamErrorCode[];

/** code → HTTP status, per the Doc 06 §2 table. */
export const IAM_ERROR_HTTP_STATUS: Readonly<Record<IamErrorCode, number>> =
  Object.freeze({
    [IamErrorCode.VALIDATION_FAILED]: 400,
    [IamErrorCode.AUTH_REQUIRED]: 401,
    [IamErrorCode.INVALID_CREDENTIALS]: 401,
    [IamErrorCode.PERMISSION_DENIED]: 403,
    [IamErrorCode.SCOPE_DENIED]: 403,
    [IamErrorCode.NOT_FOUND]: 404,
    [IamErrorCode.CONFLICT]: 409,
    [IamErrorCode.ACCOUNT_LOCKED]: 423,
    [IamErrorCode.RATE_LIMITED]: 429,
    [IamErrorCode.INTERNAL_ERROR]: 500,
  });

/** One field-level complaint accompanying `VALIDATION_FAILED`. */
export interface IamErrorDetail {
  field: string;
  message: string;
}

export interface IamError {
  code: IamErrorCode;
  /**
   * Human-readable message. Denials must stay non-committal: a 403 never
   * reveals whether the target exists in another tenant (Doc 06 §2).
   */
  message: string;
  /** Correlates the response with server logs and audit records. */
  requestId: string;
  details?: IamErrorDetail[];
}

/** The single response shape for every error the IAM returns (Doc 06 §2). */
export interface IamErrorResponse {
  error: IamError;
}

export function isIamErrorCode(value: unknown): value is IamErrorCode {
  return (
    typeof value === 'string' &&
    (IAM_ERROR_CODES as readonly string[]).includes(value)
  );
}

export function isIamErrorResponse(value: unknown): value is IamErrorResponse {
  if (typeof value !== 'object' || value === null || !('error' in value)) {
    return false;
  }
  const { error } = value as { error: unknown };
  return (
    typeof error === 'object' &&
    error !== null &&
    isIamErrorCode((error as { code?: unknown }).code) &&
    typeof (error as { message?: unknown }).message === 'string' &&
    typeof (error as { requestId?: unknown }).requestId === 'string'
  );
}

/** HTTP status for a code — the mapping consumers and the filter share. */
export function httpStatusForIamError(code: IamErrorCode): number {
  return IAM_ERROR_HTTP_STATUS[code];
}
