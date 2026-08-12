/**
 * The correlation handle every error response carries (Doc 06 §2).
 *
 * One id per request, attached to the request object, echoed in the
 * `X-Request-Id` response header, and copied into the error envelope. It is
 * what lets an operator holding a user's failed response find the stack trace
 * and the audit row behind it.
 *
 * ## Why an inbound header is not simply trusted
 *
 * Accepting the caller's `X-Request-Id` is worth having — it stitches a trace
 * across a gateway or a calling module — but the value ends up in log lines
 * and in a response body, so an unvalidated one is a log-injection primitive:
 * a newline in the header forges log entries, and a few kilobytes of it turns
 * every log line into a payload. The header is therefore accepted only in the
 * shape a real correlation id has, and replaced otherwise. There is no
 * failure mode in replacing it: a fresh id still correlates everything on
 * *this* side of the call.
 */

import { Injectable, type NestMiddleware } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

export const REQUEST_ID_HEADER = 'x-request-id';

/** Ids are opaque, but they are not arbitrary bytes. */
const ACCEPTABLE_ID = /^[A-Za-z0-9._-]{8,128}$/;

/**
 * Symbol-keyed so it cannot collide with a body field, a query parameter, or
 * another middleware's property on the same request object.
 */
const REQUEST_ID = Symbol('requestId');

interface RequestWithId {
  [REQUEST_ID]?: string;
}

/**
 * The id for this request.
 *
 * Falls back to a fresh id rather than empty string: an envelope whose
 * `requestId` is `''` looks like a correlation that exists and does not, which
 * costs an operator more time than an id that matches nothing in the logs.
 */
export function requestIdOf(request: unknown): string {
  const held = (request as RequestWithId | null)?.[REQUEST_ID];
  return held ?? randomUUID();
}

export function setRequestId(request: unknown, id: string): void {
  (request as RequestWithId)[REQUEST_ID] = id;
}

@Injectable()
export class RequestIdMiddleware implements NestMiddleware {
  use(request: Request, response: Response, next: NextFunction): void {
    const inbound = request.headers[REQUEST_ID_HEADER];
    const candidate = Array.isArray(inbound) ? inbound[0] : inbound;
    const id =
      candidate !== undefined && ACCEPTABLE_ID.test(candidate)
        ? candidate
        : randomUUID();

    setRequestId(request, id);
    response.setHeader(REQUEST_ID_HEADER, id);
    next();
  }
}
