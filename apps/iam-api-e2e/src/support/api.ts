/**
 * The battery's HTTP client — `fetch`, with a base URL and a bearer token.
 *
 * Deliberately thin, and deliberately **not** `@plantops/iam-client`. That
 * library is a subject of these tests as much as the API is (Session 26), and a
 * suite that drove the API through it could not tell an API regression from a
 * client one — nor could it send the malformed requests half of these cases are
 * about. So this is `fetch` plus three conveniences: the base URL, the token,
 * and a status that never throws.
 *
 * Every call returns the status alongside the body because most assertions here
 * are about the status: a 403 that should have been a 404, a 409 that should
 * have been a 403, a 200 that should have been either.
 */

import type { IamErrorResponse } from '@plantops/contracts';

export interface ApiResponse<T = unknown> {
  status: number;
  headers: Headers;
  data: T;
}

/** The error envelope of Doc 06 §2, for the many negative assertions. */
export type ErrorResponse = ApiResponse<IamErrorResponse>;

function baseUrl(): string {
  const url = process.env['E2E_BASE_URL'];
  if (url === undefined) {
    throw new Error('E2E_BASE_URL is unset — see support/test-setup.ts.');
  }
  return url;
}

export interface RequestOptions {
  token?: string;
  body?: unknown;
  headers?: Record<string, string>;
}

async function request<T>(
  method: string,
  path: string,
  options: RequestOptions = {},
  base: string = baseUrl(),
): Promise<ApiResponse<T>> {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(options.token === undefined
        ? {}
        : { authorization: `Bearer ${options.token}` }),
      ...options.headers,
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });

  // 204s and the CSV export are not JSON; neither is an Express-level failure,
  // which is exactly the kind of regression worth seeing the text of.
  const text = await response.text();
  let data: unknown = text;
  try {
    data = text.length === 0 ? undefined : JSON.parse(text);
  } catch {
    /* keep the raw text — an assertion will show it */
  }

  return { status: response.status, headers: response.headers, data: data as T };
}

/**
 * A caller bound to one subject's token.
 *
 * Written as a factory rather than a mutable client so a test can hold two
 * subjects at once — which most of the cross-tenant and authorization cases
 * need, and which a single client with a `setToken` would quietly get wrong.
 */
export interface Caller {
  readonly token: string | undefined;
  get<T = unknown>(path: string): Promise<ApiResponse<T>>;
  post<T = unknown>(path: string, body?: unknown): Promise<ApiResponse<T>>;
  put<T = unknown>(path: string, body?: unknown): Promise<ApiResponse<T>>;
  patch<T = unknown>(path: string, body?: unknown): Promise<ApiResponse<T>>;
  del<T = unknown>(path: string, body?: unknown): Promise<ApiResponse<T>>;
}

/**
 * A caller, optionally against an instance other than the battery's.
 *
 * `base` exists for one suite: `single-tenant.e2e.ts` starts a *second* API
 * process in the other deployment mode, because the mode is boot-time
 * configuration and there is no way to change it on a running instance. Every
 * other suite omits it and drives the shared instance as before.
 */
export function as(token: string | undefined, base?: string): Caller {
  const at = base === undefined ? undefined : base.replace(/\/+$/, '');
  const send = <T>(
    method: string,
    path: string,
    options: RequestOptions,
  ): Promise<ApiResponse<T>> =>
    at === undefined
      ? request<T>(method, path, options)
      : request<T>(method, path, options, at);

  return {
    token,
    get: (path) => send('GET', path, { token }),
    post: (path, body) => send('POST', path, { token, body }),
    put: (path, body) => send('PUT', path, { token, body }),
    patch: (path, body) => send('PATCH', path, { token, body }),
    del: (path, body) => send('DELETE', path, { token, body }),
  };
}

/** An unauthenticated caller — for the 401 cases and `/auth/*`. */
export const anonymous: Caller = as(undefined);

/**
 * Asserts a 2xx and returns the body.
 *
 * Fixtures are long chains of calls, and a failure in step 14 that surfaces as
 * `Cannot read property 'id' of undefined` in step 15 is the single most
 * expensive thing to debug in a suite like this. This turns it into the status
 * and the body of the call that actually failed.
 */
export function expectOk<T>(response: ApiResponse<T>, what: string): T {
  if (response.status >= 400) {
    throw new Error(
      `${what} failed with ${response.status}: ${JSON.stringify(response.data)}`,
    );
  }
  return response.data;
}
