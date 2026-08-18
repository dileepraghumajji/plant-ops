import { IAM_ERROR_CODES, IamErrorCode } from '@plantops/contracts';

import { errorCopyFor, TRANSPORT_ERROR_COPY } from './error-copy';

describe('errorCopyFor', () => {
  /**
   * The table is closed (Doc 06 §2) and adding a code is a spec change — so a
   * new code must arrive with its words, not fall silently through to the
   * "could not reach the server" wording, which would be actively wrong for a
   * refusal the server made.
   */
  it('has copy for every code in the Doc 06 §2 table', () => {
    for (const code of IAM_ERROR_CODES) {
      expect(errorCopyFor(code)).not.toBe(TRANSPORT_ERROR_COPY);
    }
  });

  it('gives every code a title and a description', () => {
    for (const code of IAM_ERROR_CODES) {
      const copy = errorCopyFor(code);
      expect(copy.title.length).toBeGreaterThan(0);
      expect(copy.description.length).toBeGreaterThan(0);
    }
  });

  /**
   * Doc 03 §8 makes a locked account a distinct state with a distinct remedy,
   * and Doc 09 §1 requires the login screen to show a distinct message. Sharing
   * wording with the 401 would send a locked-out user to reset a password that
   * cannot unlock them.
   */
  it('says something different for a locked account than for bad credentials', () => {
    const locked = errorCopyFor(IamErrorCode.ACCOUNT_LOCKED);
    const invalid = errorCopyFor(IamErrorCode.INVALID_CREDENTIALS);

    expect(locked.title).not.toBe(invalid.title);
    expect(locked.description).not.toBe(invalid.description);
    expect(locked.description.toLowerCase()).toContain('unlock');
  });

  /** Doc 06 §2: a denial must not reveal whether the target exists elsewhere. */
  it('does not speculate about other tenants in a denial', () => {
    for (const code of [IamErrorCode.PERMISSION_DENIED, IamErrorCode.SCOPE_DENIED]) {
      const text = `${errorCopyFor(code).title} ${errorCopyFor(code).description}`;
      expect(text.toLowerCase()).not.toContain('another client');
      expect(text.toLowerCase()).not.toContain('another tenant');
    }
  });

  it('marks a denial as not retryable and a rate limit as retryable', () => {
    expect(errorCopyFor(IamErrorCode.PERMISSION_DENIED).retryable).toBe(false);
    expect(errorCopyFor(IamErrorCode.RATE_LIMITED).retryable).toBe(true);
  });

  it('falls back to the transport wording when there is no code at all', () => {
    expect(errorCopyFor(null)).toBe(TRANSPORT_ERROR_COPY);
    expect(errorCopyFor(undefined)).toBe(TRANSPORT_ERROR_COPY);
  });
});
