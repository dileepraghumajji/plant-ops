import {
  IAM_ERROR_CODES,
  IAM_ERROR_HTTP_STATUS,
  IamErrorCode,
  httpStatusForIamError,
  isIamErrorCode,
  isIamErrorResponse,
} from './errors.js';

describe('IamErrorCode', () => {
  /**
   * Doc 06 §2 verbatim. This literal is the guard: adding or renaming a code
   * without amending the spec breaks this test on purpose.
   */
  const DOC_06_TABLE: Array<[code: string, status: number]> = [
    ['VALIDATION_FAILED', 400],
    ['AUTH_REQUIRED', 401],
    ['INVALID_CREDENTIALS', 401],
    ['PERMISSION_DENIED', 403],
    ['SCOPE_DENIED', 403],
    ['NOT_FOUND', 404],
    ['CONFLICT', 409],
    ['ACCOUNT_LOCKED', 423],
    ['RATE_LIMITED', 429],
  ];

  it('contains exactly the Doc 06 §2 codes', () => {
    expect([...IAM_ERROR_CODES]).toEqual(DOC_06_TABLE.map(([code]) => code));
    expect(Object.values(IamErrorCode).sort()).toEqual(
      DOC_06_TABLE.map(([code]) => code).sort(),
    );
  });

  it('is a self-consistent enum object (key === value)', () => {
    for (const [key, value] of Object.entries(IamErrorCode)) {
      expect(value).toBe(key);
    }
  });

  it('maps every code to its Doc 06 §2 HTTP status', () => {
    for (const [code, status] of DOC_06_TABLE) {
      expect(httpStatusForIamError(code as IamErrorCode)).toBe(status);
    }
    expect(Object.keys(IAM_ERROR_HTTP_STATUS)).toHaveLength(
      DOC_06_TABLE.length,
    );
  });

  it('never maps a denial to a status that leaks existence', () => {
    // 403 for both, so a cross-tenant target cannot be distinguished from a
    // present-but-forbidden one (Doc 06 §2).
    expect(httpStatusForIamError(IamErrorCode.PERMISSION_DENIED)).toBe(403);
    expect(httpStatusForIamError(IamErrorCode.SCOPE_DENIED)).toBe(403);
  });
});

describe('isIamErrorCode', () => {
  it('accepts known codes and rejects everything else', () => {
    expect(isIamErrorCode('SCOPE_DENIED')).toBe(true);
    expect(isIamErrorCode('INTERNAL_ERROR')).toBe(false);
    expect(isIamErrorCode(403)).toBe(false);
    expect(isIamErrorCode(undefined)).toBe(false);
  });
});

describe('isIamErrorResponse', () => {
  it('accepts the standard envelope', () => {
    expect(
      isIamErrorResponse({
        error: {
          code: IamErrorCode.CONFLICT,
          message: 'Duplicate key',
          requestId: 'req-1',
        },
      }),
    ).toBe(true);
  });

  it('rejects malformed or foreign error shapes', () => {
    expect(isIamErrorResponse(null)).toBe(false);
    expect(isIamErrorResponse({ statusCode: 409, message: 'Conflict' })).toBe(
      false,
    );
    expect(
      isIamErrorResponse({ error: { code: 'NOPE', message: 'x', requestId: 'y' } }),
    ).toBe(false);
    expect(
      isIamErrorResponse({ error: { code: IamErrorCode.NOT_FOUND, message: 'x' } }),
    ).toBe(false);
  });
});
