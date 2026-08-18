/**
 * The one place this library touches the network.
 *
 * Everything above it — the `endpoints/` modules, the token lifecycle in
 * `auth.ts`, the cache in `resolve-cache.ts` — is transport-free and therefore
 * testable without a socket. What lives here is the small, unavoidable set of
 * decisions about HTTP itself: how a query string is built, when a body is
 * JSON, what an empty `204` deserialises to, how a failure becomes an
 * {@link IamApiError}, and the single re-authentication retry that hides an
 * expired access token from every caller.
 *
 * ## Why the fetch types are declared here rather than imported
 *
 * The library must run in Node and in a browser (Doc 08 §2 — `admin-web` and
 * every future module), and those two disagree about where the types for
 * `fetch` come from: `lib.dom` in one, the undici typings of `@types/node` in
 * the other. Naming either would make this package unbuildable in the other
 * context. The structural minimum both satisfy is four properties and one
 * method, so that is what {@link FetchLike} asks for — and it is also exactly
 * what a test double has to implement, which is why the mocked-server suite
 * needs no HTTP library at all.
 */

import { IamApiError, IamTransportError } from './errors.js';

export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

/** A query-string value; `undefined` means "omit this parameter". */
export type QueryValue = string | number | boolean | undefined;
export type QueryParams = Readonly<Record<string, QueryValue>>;

/** The structural subset of `RequestInit` this client ever sends. */
export interface HttpRequestInit {
  method: string;
  headers: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}

/** The structural subset of `Response` this client ever reads. */
export interface HttpResponseLike {
  readonly ok: boolean;
  readonly status: number;
  readonly headers: { get(name: string): string | null };
  text(): Promise<string>;
}

export type FetchLike = (
  url: string,
  init: HttpRequestInit,
) => Promise<HttpResponseLike>;

/** One call, described in the terms the endpoint modules think in. */
export interface RequestSpec {
  method: HttpMethod;
  /** Absolute path from the API root, e.g. `/iam/users`. */
  path: string;
  query?: QueryParams;
  /** Serialised as JSON when present. `undefined` sends no body at all. */
  body?: unknown;
  /**
   * `'none'` for the routes that cannot carry a token — login, refresh, the
   * service-account exchange, the JWKS document. Everything else defaults to
   * `'bearer'` and takes part in the refresh-on-401 retry.
   */
  auth?: 'bearer' | 'none';
  signal?: AbortSignal;
}

/** What every endpoint module is handed, and the only thing it may use. */
export type Requester = <T>(spec: RequestSpec) => Promise<T>;

export interface HttpTransportOptions {
  /** API root — the origin, not the `/iam` prefix. */
  baseUrl: string;
  fetch?: FetchLike;
  /** Sent on every request. */
  headers?: Readonly<Record<string, string>>;
  /** Abort a request that has taken this long. Omit for no client-side limit. */
  timeoutMs?: number;
  /** The current access token, or `null` when there is none. */
  authorize?: () => Promise<string | null>;
  /**
   * Called once per request that came back `401`, with the token that failed.
   * Resolving `true` means a usable token now exists and the request should be
   * retried exactly once; `false` means the `401` stands.
   */
  reauthorize?: (usedToken: string | null) => Promise<boolean>;
}

/** Trailing slashes on the base would double up against a leading-slash path. */
export const stripTrailingSlash = (url: string): string => url.replace(/\/+$/, '');

export function buildQuery(query: QueryParams | undefined): string {
  if (query === undefined) return '';

  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) search.append(key, String(value));
  }

  const encoded = search.toString();
  return encoded === '' ? '' : `?${encoded}`;
}

export class HttpTransport {
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly headers: Readonly<Record<string, string>>;
  private readonly timeoutMs: number | undefined;
  private readonly authorize: (() => Promise<string | null>) | undefined;
  private readonly reauthorize:
    | ((usedToken: string | null) => Promise<boolean>)
    | undefined;

  constructor(options: HttpTransportOptions) {
    const fetchImpl = options.fetch ?? globalThis.fetch;
    if (typeof fetchImpl !== 'function') {
      throw new TypeError(
        'No fetch implementation. This runtime has no global fetch — pass one ' +
          'as `fetch` in the client options.',
      );
    }

    this.baseUrl = stripTrailingSlash(options.baseUrl);
    // Wrapped rather than stored bare: an unbound global `fetch` throws
    // "Illegal invocation" in a browser once it is detached from `window`.
    this.fetchImpl = (url, init) => fetchImpl(url, init);
    this.headers = options.headers ?? {};
    this.timeoutMs = options.timeoutMs;
    this.authorize = options.authorize;
    this.reauthorize = options.reauthorize;
  }

  /** The {@link Requester} handed to every endpoint module. */
  readonly request: Requester = async <T>(spec: RequestSpec): Promise<T> => {
    const bearer = spec.auth !== 'none';
    const token = bearer && this.authorize ? await this.authorize() : null;

    const first = await this.attempt(spec, token);
    if (
      first.status !== 401 ||
      !bearer ||
      this.reauthorize === undefined ||
      !(await this.reauthorize(token))
    ) {
      return this.interpret<T>(first);
    }

    // The refused response is being thrown away, so drain it: an unread body
    // holds its connection open until the socket is collected.
    await first.text().catch(() => undefined);

    // Exactly one retry. A second 401 after a successful refresh is the server
    // saying this subject may not do this at all, and looping on it would turn
    // a revoked session into an unbounded refresh storm.
    const retryToken = this.authorize ? await this.authorize() : null;
    return this.interpret<T>(await this.attempt(spec, retryToken));
  };

  private async attempt(
    spec: RequestSpec,
    token: string | null,
  ): Promise<HttpResponseLike> {
    const headers: Record<string, string> = {
      accept: 'application/json',
      ...this.headers,
    };
    if (spec.body !== undefined) headers['content-type'] = 'application/json';
    if (token !== null) headers['authorization'] = `Bearer ${token}`;

    const url = `${this.baseUrl}${spec.path}${buildQuery(spec.query)}`;
    const { signal, done } = this.deadline(spec.signal);

    try {
      return await this.fetchImpl(url, {
        method: spec.method,
        headers,
        ...(spec.body === undefined ? {} : { body: JSON.stringify(spec.body) }),
        ...(signal === undefined ? {} : { signal }),
      });
    } catch (cause) {
      throw new IamTransportError(
        `${spec.method} ${spec.path} did not complete: ${describe(cause)}`,
        { cause },
      );
    } finally {
      done();
    }
  }

  /**
   * A timeout and a caller's own `AbortSignal`, combined without
   * `AbortSignal.any` — which is newer than some runtimes this library has to
   * work in, and which would be the only reason to require one.
   */
  private deadline(caller: AbortSignal | undefined): {
    signal: AbortSignal | undefined;
    done: () => void;
  } {
    if (this.timeoutMs === undefined) {
      return { signal: caller, done: () => undefined };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const forward = () => controller.abort();
    caller?.addEventListener('abort', forward);
    if (caller?.aborted === true) forward();

    return {
      signal: controller.signal,
      done: () => {
        clearTimeout(timer);
        caller?.removeEventListener('abort', forward);
      },
    };
  }

  /** Body to value, or to the error of Doc 06 §2. */
  private async interpret<T>(response: HttpResponseLike): Promise<T> {
    const text = await response.text();
    const parsed = parseJson(text);

    if (!response.ok) {
      throw IamApiError.from(response.status, parsed, {
        requestId: response.headers.get('x-request-id'),
        text,
      });
    }

    // The routes that answer 204 with nothing at all (Doc 06 §3, §6, §7, §9).
    if (text.trim() === '') return undefined as T;
    if (parsed === undefined) {
      throw new IamTransportError(
        `HTTP ${response.status} carried a body that is not JSON.`,
      );
    }
    return parsed as T;
  }
}

function parseJson(text: string): unknown {
  if (text.trim() === '') return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
