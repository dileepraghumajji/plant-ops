/**
 * The single place an error becomes a response (Doc 06 §2).
 *
 * Every failure leaves the API as `{ error: { code, message, requestId } }`,
 * with `code` drawn from the closed Doc 06 §2 table. That matters beyond
 * tidiness: `isIamErrorResponse` in `@plantops/contracts` is what `iam-client`
 * and admin-web branch on, so a route that escapes with Nest's default
 * `{ statusCode, message }` is a route whose failures no consumer can read.
 *
 * ## The 500 rule
 *
 * An unrecognised exception becomes `INTERNAL_ERROR` with a **fixed** message.
 * The exception's own text is logged, never returned: a `QueryFailedError`
 * quotes the failing SQL along with its parameters, which at this layer means
 * password hashes, tokens, and other tenants' identifiers. The `requestId`
 * carries the correlation instead.
 */

import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { AuthorizationDeniedException } from '@plantops/auth-kit';
import {
  IamErrorCode,
  type IamErrorDetail,
  type IamErrorResponse,
  httpStatusForIamError,
} from '@plantops/contracts';
import type { Request, Response } from 'express';
import { QueryFailedError } from 'typeorm';
import { IamException } from './iam.exception';
import { isSerializationFailure } from './pg-errors';
import { requestIdOf } from './request-id.middleware';

/** SQLSTATE 23505 — unique violation. Doc 06 §2 calls this a 409 CONFLICT. */
const PG_UNIQUE_VIOLATION = '23505';

/** What a 500 says. Never the exception's own message. */
const INTERNAL_MESSAGE = 'An unexpected error occurred';

/**
 * Status → code, for exceptions thrown as plain Nest `HttpException`s rather
 * than as {@link IamException}. Where a status maps to two codes, this picks
 * the less specific one on purpose: `PERMISSION_DENIED` over `SCOPE_DENIED`,
 * `AUTH_REQUIRED` over `INVALID_CREDENTIALS`. A handler that means the
 * specific one is expected to say so by throwing `IamException`.
 */
const CODE_BY_STATUS: Readonly<Record<number, IamErrorCode>> = Object.freeze({
  [HttpStatus.BAD_REQUEST]: IamErrorCode.VALIDATION_FAILED,
  [HttpStatus.UNAUTHORIZED]: IamErrorCode.AUTH_REQUIRED,
  [HttpStatus.FORBIDDEN]: IamErrorCode.PERMISSION_DENIED,
  [HttpStatus.NOT_FOUND]: IamErrorCode.NOT_FOUND,
  [HttpStatus.CONFLICT]: IamErrorCode.CONFLICT,
  [423 /* HttpStatus has no LOCKED */]: IamErrorCode.ACCOUNT_LOCKED,
  [HttpStatus.TOO_MANY_REQUESTS]: IamErrorCode.RATE_LIMITED,
});

interface Resolved {
  code: IamErrorCode;
  message: string;
  details?: readonly IamErrorDetail[];
}

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    // Non-HTTP transports (none today) have no envelope to write into, and
    // swallowing the exception there would lose it entirely.
    if (host.getType() !== 'http') throw exception;

    const http = host.switchToHttp();
    const request = http.getRequest<Request>();
    const response = http.getResponse<Response>();

    const { code, message, details } = this.resolve(exception);
    const status = httpStatusForIamError(code);

    if (status >= HttpStatus.INTERNAL_SERVER_ERROR) {
      // The only copy of what actually happened. Logged with the id that the
      // caller was handed, so the two can be joined.
      this.logger.error(
        `${request.method} ${request.url} failed [${requestIdOf(request)}]`,
        exception instanceof Error ? exception.stack : String(exception),
      );
    }

    const body: IamErrorResponse = {
      error: {
        code,
        message,
        requestId: requestIdOf(request),
        ...(details && details.length > 0 ? { details: [...details] } : {}),
      },
    };

    // `headersSent` guards the case where the handler already began streaming
    // and then threw: writing a second set of headers throws again, inside the
    // filter, and Express answers with its own HTML error page.
    if (response.headersSent) {
      response.end();
      return;
    }
    response.status(status).json(body);
  }

  private resolve(exception: unknown): Resolved {
    if (exception instanceof IamException) {
      return {
        code: exception.code,
        message: exception.message,
        details: exception.details,
      };
    }

    // `PermissionGuard`'s two refusals. A bare `ForbiddenException` would fall
    // through to the table below and become `PERMISSION_DENIED` — correct for
    // one of them and wrong for the other, and `SCOPE_DENIED` is the one that
    // tells a client *where* the subject lacks access (Doc 06 §2).
    if (exception instanceof AuthorizationDeniedException) {
      return { code: exception.code, message: exception.message };
    }

    if (exception instanceof HttpException) {
      return {
        code: CODE_BY_STATUS[exception.getStatus()] ?? IamErrorCode.INTERNAL_ERROR,
        message: messageOf(exception),
      };
    }

    // A unique violation is a *caller* error — a duplicate slug, an email
    // already taken in this tenant — so it earns the 409 the table gives it
    // rather than being reported as a server fault. The constraint name is
    // withheld: it names columns and, in this schema, tenants.
    if (
      exception instanceof QueryFailedError &&
      (exception as QueryFailedError & { code?: string }).code ===
        PG_UNIQUE_VIOLATION
    ) {
      return {
        code: IamErrorCode.CONFLICT,
        message: 'The request conflicts with existing data',
      };
    }

    // A lost race, not a fault: the request was refused so that a concurrent one
    // could be serialized (Doc 04 §7.1). `TenantContextInterceptor` retries this
    // where the handler asked it to, so reaching the filter means either the
    // retries ran out or the route never opted in — in both cases the honest
    // answer is a 409 that says the request is repeatable, rather than a 500
    // that says the server broke.
    if (isSerializationFailure(exception)) {
      return {
        code: IamErrorCode.CONFLICT,
        message:
          'The request conflicted with a concurrent change and was not applied; retry it',
      };
    }

    return { code: IamErrorCode.INTERNAL_ERROR, message: INTERNAL_MESSAGE };
  }
}

/**
 * The message a Nest `HttpException` carries.
 *
 * `getResponse()` is a string for `new NotFoundException('...')` and an object
 * for the built-in shapes. A 5xx one is discarded in favour of the fixed text:
 * an `InternalServerErrorException` is usually constructed from a caught
 * error's own message, which is exactly what must not be returned.
 *
 * Field-level complaints come from {@link IamException} alone. Nothing here
 * tries to reconstruct them from a Nest payload — a `details` entry with an
 * empty `field` is worse than none, since a client rendering it next to a form
 * has nothing to attach it to.
 */
function messageOf(exception: HttpException): string {
  if (exception.getStatus() >= HttpStatus.INTERNAL_SERVER_ERROR) {
    return INTERNAL_MESSAGE;
  }
  const payload = exception.getResponse();
  if (typeof payload === 'string') return payload;
  const message = (payload as { message?: unknown }).message;
  if (typeof message === 'string') return message;
  if (Array.isArray(message)) {
    return message.filter((entry) => typeof entry === 'string').join('; ');
  }
  return exception.message;
}
