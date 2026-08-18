/**
 * The mocked server the unit tests run against.
 *
 * Not exported from the package barrel: it is test scaffolding, and a consumer
 * that wants a fake IAM should be given the real one in a container rather than
 * this. It lives in `src/` all the same so the type checker holds it to the same
 * standard as the code it exercises — a fixture that has drifted from
 * {@link FetchLike} is a fixture that proves nothing.
 *
 * It implements {@link FetchLike} directly instead of pulling in an HTTP mocking
 * library, which is possible only because `http.ts` asks for four properties and
 * one method rather than for the whole of `Response`. Routes are matched on
 * method and pathname; every call is recorded with its query, headers and parsed
 * body, so a test can assert *what was sent* and not merely what came back.
 */

import { IAM_ERROR_HTTP_STATUS, type IamErrorCode } from '@plantops/contracts';

import type { FetchLike, HttpRequestInit, HttpResponseLike } from '../http.js';

export interface MockRequest {
  method: string;
  /** Pathname only — the query is parsed out into {@link MockRequest.query}. */
  path: string;
  query: Record<string, string>;
  /** Lower-cased header names, as the transport sends them. */
  headers: Record<string, string>;
  /** The parsed JSON body, or `undefined` when none was sent. */
  body: unknown;
}

export interface MockReply {
  /** Defaults to 200 with a body, 204 without one. */
  status?: number;
  body?: unknown;
  /** Sent instead of `body`, verbatim — for the not-JSON cases. */
  text?: string;
  headers?: Record<string, string>;
}

export type MockHandler = (request: MockRequest) => MockReply | Promise<MockReply>;

interface Route {
  method: string;
  path: string;
  handler: MockHandler;
  once: boolean;
  spent: boolean;
}

/** The Doc 06 §2 envelope, for the tests that assert on error mapping. */
export function errorReply(
  code: IamErrorCode,
  message = 'refused',
  extra: { requestId?: string; details?: { field: string; message: string }[] } = {},
): MockReply {
  return {
    status: IAM_ERROR_HTTP_STATUS[code],
    body: {
      error: {
        code,
        message,
        requestId: extra.requestId ?? 'req-test',
        ...(extra.details === undefined ? {} : { details: extra.details }),
      },
    },
  };
}

export class MockIamServer {
  /** Every request that reached the server, in order. */
  readonly calls: MockRequest[] = [];

  private readonly routes: Route[] = [];

  /** Answers this route for as long as the test runs. */
  on(method: string, path: string, reply: MockHandler | MockReply): this {
    return this.add(method, path, reply, false);
  }

  /**
   * Answers this route once, then falls through to any standing route.
   *
   * What the refresh tests are built on: the first `GET /iam/users` is a `401`,
   * the second — after the client has renewed — is the real answer.
   */
  once(method: string, path: string, reply: MockHandler | MockReply): this {
    return this.add(method, path, reply, true);
  }

  /** Requests to `path`, in order. */
  callsTo(method: string, path: string): MockRequest[] {
    return this.calls.filter(
      (call) => call.method === method.toUpperCase() && call.path === path,
    );
  }

  countOf(method: string, path: string): number {
    return this.callsTo(method, path).length;
  }

  readonly fetch: FetchLike = async (
    url: string,
    init: HttpRequestInit,
  ): Promise<HttpResponseLike> => {
    const parsed = new URL(url);
    const request: MockRequest = {
      method: init.method.toUpperCase(),
      path: parsed.pathname,
      query: Object.fromEntries(parsed.searchParams.entries()),
      headers: lowerCased(init.headers),
      body: init.body === undefined ? undefined : JSON.parse(init.body),
    };
    this.calls.push(request);

    if (init.signal?.aborted === true) {
      throw new DOMExceptionLike('This operation was aborted');
    }

    const route = this.match(request);
    if (route === undefined) {
      throw new Error(
        `MockIamServer has no route for ${request.method} ${request.path}`,
      );
    }
    route.spent = true;

    return respond(await route.handler(request));
  };

  private add(
    method: string,
    path: string,
    reply: MockHandler | MockReply,
    once: boolean,
  ): this {
    const handler: MockHandler =
      typeof reply === 'function' ? reply : () => reply;
    this.routes.push({ method: method.toUpperCase(), path, handler, once, spent: false });
    return this;
  }

  private match(request: MockRequest): Route | undefined {
    // One-shots first, so `once()` genuinely precedes a standing `on()`.
    const matches = (route: Route) =>
      route.method === request.method && route.path === request.path;
    return (
      this.routes.find((route) => route.once && !route.spent && matches(route)) ??
      this.routes.find((route) => !route.once && matches(route))
    );
  }
}

function respond(reply: MockReply): HttpResponseLike {
  const status = reply.status ?? (reply.body === undefined && reply.text === undefined ? 204 : 200);
  const text = reply.text ?? (reply.body === undefined ? '' : JSON.stringify(reply.body));
  const headers = lowerCased(reply.headers ?? {});

  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
    text: () => Promise.resolve(text),
  };
}

function lowerCased(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]),
  );
}

/** `DOMException` is not in every runtime's Node typings; the name is what matters. */
class DOMExceptionLike extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AbortError';
  }
}
