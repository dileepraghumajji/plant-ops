/**
 * The only exception this API should deliberately throw.
 *
 * It pairs a Doc 06 §2 code with its HTTP status through
 * `httpStatusForIamError`, so the two cannot drift: a handler picks the code
 * that describes what happened and the status follows. Throwing a bare
 * `NotFoundException` still produces a correct envelope — the filter maps it —
 * but it lets a status be chosen without choosing a code, which is how a 403
 * ends up meaning `PERMISSION_DENIED` when it should have meant `SCOPE_DENIED`.
 */

import { HttpException } from '@nestjs/common';
import {
  IamErrorCode,
  type IamErrorDetail,
  httpStatusForIamError,
} from '@plantops/contracts';

export class IamException extends HttpException {
  constructor(
    readonly code: IamErrorCode,
    message: string,
    readonly details?: readonly IamErrorDetail[],
  ) {
    super(message, httpStatusForIamError(code));
    this.name = 'IamException';
  }

  static validationFailed(details: readonly IamErrorDetail[]): IamException {
    return new IamException(
      IamErrorCode.VALIDATION_FAILED,
      'Request validation failed',
      details,
    );
  }

  static authRequired(message = 'Authentication is required'): IamException {
    return new IamException(IamErrorCode.AUTH_REQUIRED, message);
  }

  /**
   * Deliberately without a reason parameter. Doc 06 §2: a denial never reveals
   * whether the target exists in another tenant, and the cheapest way to keep
   * that promise is to make the revealing version harder to write than the
   * safe one.
   */
  static permissionDenied(): IamException {
    return new IamException(
      IamErrorCode.PERMISSION_DENIED,
      'You do not have permission to perform this action',
    );
  }

  static scopeDenied(): IamException {
    return new IamException(
      IamErrorCode.SCOPE_DENIED,
      'You do not have permission at the requested scope',
    );
  }

  static notFound(what = 'The requested resource'): IamException {
    return new IamException(IamErrorCode.NOT_FOUND, `${what} was not found`);
  }

  static conflict(message: string): IamException {
    return new IamException(IamErrorCode.CONFLICT, message);
  }

  static rateLimited(message = 'Too many requests'): IamException {
    return new IamException(IamErrorCode.RATE_LIMITED, message);
  }
}
