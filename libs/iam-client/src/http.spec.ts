import { IamErrorCode } from '@plantops/contracts';

import { IamApiError, IamTransportError } from './errors.js';
import {
  buildQuery,
  HttpTransport,
  stripTrailingSlash,
  type HttpTransportOptions,
} from './http.js';
import { errorReply, MockIamServer } from './testing/mock-server.js';

const BASE = 'https://iam.test';

const transportOver = (
  server: MockIamServer,
  options: Partial<Omit<HttpTransportOptions, 'baseUrl'>> = {},
) => new HttpTransport({ baseUrl: BASE, fetch: server.fetch, ...options });

describe('buildQuery', () => {
  it('omits undefined parameters rather than sending them empty', () => {
    expect(buildQuery({ page: 1, limit: undefined, q: 'gita' })).toBe('?page=1&q=gita');
  });

  it('is empty when nothing survives', () => {
    expect(buildQuery({ applicationId: undefined })).toBe('');
    expect(buildQuery(undefined)).toBe('');
  });

  it('encodes values', () => {
    expect(buildQuery({ q: 'a b&c' })).toBe('?q=a+b%26c');
  });
});

describe('stripTrailingSlash', () => {
  it('keeps the base from doubling the separator', () => {
    expect(stripTrailingSlash('https://iam.test/')).toBe('https://iam.test');
    expect(stripTrailingSlash('https://iam.test///')).toBe('https://iam.test');
  });
});

describe('HttpTransport', () => {
  it('refuses to be built where the runtime has no fetch at all', () => {
    const host = globalThis as { fetch?: unknown };
    const original = host.fetch;
    host.fetch = undefined;

    try {
      expect(() => new HttpTransport({ baseUrl: BASE })).toThrow(TypeError);
    } finally {
      host.fetch = original;
    }
  });

  it('sends JSON, the bearer token and the accept header', async () => {
    const server = new MockIamServer().on('POST', '/iam/roles', { body: { id: 'r1' } });
    const transport = transportOver(server, { authorize: async () => 'access-1' });

    await transport.request({
      method: 'POST',
      path: '/iam/roles',
      body: { name: 'Gate Supervisor' },
    });

    const [call] = server.calls;
    expect(call.headers['authorization']).toBe('Bearer access-1');
    expect(call.headers['content-type']).toBe('application/json');
    expect(call.headers['accept']).toBe('application/json');
    expect(call.body).toEqual({ name: 'Gate Supervisor' });
  });

  it('sends no content-type and no token when there is neither', async () => {
    const server = new MockIamServer().on('GET', '/iam/scopes', { body: {} });
    await transportOver(server).request({ method: 'GET', path: '/iam/scopes' });

    const [call] = server.calls;
    expect(call.headers['content-type']).toBeUndefined();
    expect(call.headers['authorization']).toBeUndefined();
  });

  it('never sends a token on an auth: none route', async () => {
    const server = new MockIamServer().on('POST', '/auth/login', { body: {} });
    const transport = transportOver(server, { authorize: async () => 'access-1' });

    await transport.request({
      method: 'POST',
      path: '/auth/login',
      body: {},
      auth: 'none',
    });

    expect(server.calls[0].headers['authorization']).toBeUndefined();
  });

  it('reads a 204 as undefined rather than failing to parse it', async () => {
    const server = new MockIamServer().on('DELETE', '/iam/roles/r1', { status: 204 });
    const transport = transportOver(server);

    await expect(
      transport.request({ method: 'DELETE', path: '/iam/roles/r1' }),
    ).resolves.toBeUndefined();
  });

  it('maps the Doc 06 §2 envelope onto IamApiError', async () => {
    const server = new MockIamServer().on(
      'GET',
      '/iam/users',
      errorReply(IamErrorCode.SCOPE_DENIED, 'not over that node', {
        requestId: 'req-77',
      }),
    );

    const error = await transportOver(server)
      .request({ method: 'GET', path: '/iam/users' })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(IamApiError);
    const api = error as IamApiError;
    expect(api.status).toBe(403);
    expect(api.code).toBe(IamErrorCode.SCOPE_DENIED);
    expect(api.is(IamErrorCode.SCOPE_DENIED)).toBe(true);
    expect(api.requestId).toBe('req-77');
    expect(api.inferred).toBe(false);
    expect(api.message).toBe('not over that node');
  });

  it('carries the validation details a 400 came with', async () => {
    const server = new MockIamServer().on(
      'POST',
      '/iam/users',
      errorReply(IamErrorCode.VALIDATION_FAILED, 'bad body', {
        details: [{ field: 'email', message: 'a valid email address is required' }],
      }),
    );

    const error = (await transportOver(server)
      .request({ method: 'POST', path: '/iam/users', body: {} })
      .catch((e: unknown) => e)) as IamApiError;

    expect(error.details).toEqual([
      { field: 'email', message: 'a valid email address is required' },
    ]);
  });

  it('infers a code when something in front of the API answered instead', async () => {
    const server = new MockIamServer().on('GET', '/iam/users', {
      status: 502,
      text: '<html>Bad Gateway</html>',
      headers: { 'x-request-id': 'edge-1' },
    });

    const error = (await transportOver(server)
      .request({ method: 'GET', path: '/iam/users' })
      .catch((e: unknown) => e)) as IamApiError;

    expect(error).toBeInstanceOf(IamApiError);
    expect(error.code).toBe(IamErrorCode.INTERNAL_ERROR);
    expect(error.inferred).toBe(true);
    expect(error.requestId).toBe('edge-1');
    expect(error.message).toContain('Bad Gateway');
  });

  it('infers from the status where the table has one', async () => {
    const server = new MockIamServer().on('GET', '/iam/users', {
      status: 429,
      text: 'slow down',
    });

    const error = (await transportOver(server)
      .request({ method: 'GET', path: '/iam/users' })
      .catch((e: unknown) => e)) as IamApiError;

    expect(error.code).toBe(IamErrorCode.RATE_LIMITED);
  });

  it('reports a network fault as a transport error, not an API error', async () => {
    const failing = new MockIamServer();
    const transport = transportOver(failing, {
      fetch: () => Promise.reject(new Error('ECONNREFUSED')),
    });

    const error = await transport
      .request({ method: 'GET', path: '/iam/users' })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(IamTransportError);
    expect(error).not.toBeInstanceOf(IamApiError);
    expect((error as Error).message).toContain('ECONNREFUSED');
  });

  it('reports a success body that is not JSON as a transport error', async () => {
    const server = new MockIamServer().on('GET', '/iam/users', {
      status: 200,
      text: 'not json',
    });

    await expect(
      transportOver(server).request({ method: 'GET', path: '/iam/users' }),
    ).rejects.toBeInstanceOf(IamTransportError);
  });

  it('retries a 401 exactly once, with the token reauthorize produced', async () => {
    const server = new MockIamServer()
      .once('GET', '/iam/users', errorReply(IamErrorCode.AUTH_REQUIRED))
      .on('GET', '/iam/users', { body: { data: [], page: 1, limit: 25, total: 0 } });

    let token = 'stale';
    const transport = transportOver(server, {
      authorize: async () => token,
      reauthorize: async () => {
        token = 'fresh';
        return true;
      },
    });

    await transport.request({ method: 'GET', path: '/iam/users' });

    expect(server.countOf('GET', '/iam/users')).toBe(2);
    expect(server.calls[0].headers['authorization']).toBe('Bearer stale');
    expect(server.calls[1].headers['authorization']).toBe('Bearer fresh');
  });

  it('does not retry when reauthorize declines', async () => {
    const server = new MockIamServer().on(
      'GET',
      '/iam/users',
      errorReply(IamErrorCode.AUTH_REQUIRED),
    );
    const transport = transportOver(server, {
      authorize: async () => 'stale',
      reauthorize: async () => false,
    });

    await expect(
      transport.request({ method: 'GET', path: '/iam/users' }),
    ).rejects.toBeInstanceOf(IamApiError);
    expect(server.countOf('GET', '/iam/users')).toBe(1);
  });

  it('never loops: a second 401 after a successful refresh is the answer', async () => {
    const server = new MockIamServer().on(
      'GET',
      '/iam/users',
      errorReply(IamErrorCode.AUTH_REQUIRED),
    );
    const reauthorize = jest.fn(async () => true);
    const transport = transportOver(server, {
      authorize: async () => 'stale',
      reauthorize,
    });

    await expect(
      transport.request({ method: 'GET', path: '/iam/users' }),
    ).rejects.toBeInstanceOf(IamApiError);
    expect(server.countOf('GET', '/iam/users')).toBe(2);
    expect(reauthorize).toHaveBeenCalledTimes(1);
  });

  it('does not reauthenticate a 401 from an auth: none route', async () => {
    const server = new MockIamServer().on(
      'POST',
      '/auth/login',
      errorReply(IamErrorCode.INVALID_CREDENTIALS),
    );
    const reauthorize = jest.fn(async () => true);
    const transport = transportOver(server, { reauthorize });

    await expect(
      transport.request({ method: 'POST', path: '/auth/login', body: {}, auth: 'none' }),
    ).rejects.toBeInstanceOf(IamApiError);
    expect(reauthorize).not.toHaveBeenCalled();
  });

  it('strips a trailing slash from the base url', async () => {
    const server = new MockIamServer().on('GET', '/iam/scopes', { body: {} });
    const transport = new HttpTransport({
      baseUrl: `${BASE}/`,
      fetch: server.fetch,
    });

    await transport.request({ method: 'GET', path: '/iam/scopes' });
    expect(server.calls[0].path).toBe('/iam/scopes');
  });
});
