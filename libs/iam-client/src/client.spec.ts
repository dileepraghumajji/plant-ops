/**
 * The client as a consumer meets it: a mocked server, and no knowledge of the
 * parts inside. What is asserted here is the behaviour the parts only have once
 * they are wired together — the token that rides along, the single refresh a
 * burst of 401s provokes, the cache that empties when the subject changes.
 */

import { IamErrorCode } from '@plantops/contracts';

import { MemoryTokenStore, type StoredTokens } from './auth.js';
import { IamClient, createIamClient, type IamClientOptions } from './client.js';
import { IamApiError } from './errors.js';
import { errorReply, MockIamServer } from './testing/mock-server.js';

const BASE = 'https://iam.test';

const TOKENS = {
  access_token: 'access-1',
  refresh_token: 'refresh-1',
  expires_in: 900,
};

const ROTATED = {
  access_token: 'access-2',
  refresh_token: 'refresh-2',
  expires_in: 900,
};

const GRANTS = {
  permissions: ['iam.client.user.read'],
  scopes: { 'iam.client.user.read': ['n_root'] },
};

const clientOver = (
  server: MockIamServer,
  options: Partial<Omit<IamClientOptions, 'baseUrl' | 'fetch'>> = {},
) => new IamClient({ baseUrl: BASE, fetch: server.fetch, ...options });

/** A server that answers the login and the refresh; routes are added per test. */
const authServer = () =>
  new MockIamServer()
    .on('POST', '/auth/login', { body: TOKENS })
    .on('POST', '/auth/refresh', { body: ROTATED })
    .on('POST', '/auth/logout', { status: 204 });

describe('IamClient', () => {
  it('is unauthenticated until something logs in', async () => {
    const server = new MockIamServer().on('GET', '/iam/scopes', { body: { nodes: [] } });
    const client = clientOver(server);

    await client.scopes.tree();

    expect(await client.session.isAuthenticated()).toBe(false);
    expect(server.calls[0].headers['authorization']).toBeUndefined();
  });

  it('logs in, keeps the pair, and carries it on every later call', async () => {
    const server = authServer().on('GET', '/iam/scopes', { body: { nodes: [] } });
    const client = clientOver(server);

    const pair = await client.auth.login({
      email: 'gita@acme.test',
      password: 'correct horse',
      client_slug: 'acme',
      device_label: 'Gate-3 Terminal',
    });

    expect(pair).toEqual(TOKENS);
    expect(server.calls[0].body).toEqual({
      email: 'gita@acme.test',
      password: 'correct horse',
      client_slug: 'acme',
      device_label: 'Gate-3 Terminal',
    });
    expect(server.calls[0].headers['authorization']).toBeUndefined();

    await client.scopes.tree();
    expect(server.calls[1].headers['authorization']).toBe('Bearer access-1');
  });

  it('keeps a service-account token, which cannot be refreshed', async () => {
    const server = new MockIamServer()
      .on('POST', '/auth/token', { body: { access_token: 'svc-1', expires_in: 300 } })
      .on('GET', '/iam/permissions/resolve', { body: GRANTS });
    const client = clientOver(server);

    await client.auth.serviceToken({
      account_key: 'platform-bootstrap',
      account_secret: 'shh',
    });
    await client.permissions.resolve();

    expect((await client.session.tokens())?.refreshToken).toBeNull();
    expect(server.calls[1].headers['authorization']).toBe('Bearer svc-1');
  });

  it('refreshes once when a call comes back 401, and retries it', async () => {
    const server = authServer()
      .once('GET', '/iam/users', errorReply(IamErrorCode.AUTH_REQUIRED))
      .on('GET', '/iam/users', { body: { data: [], page: 1, limit: 25, total: 0 } });
    const client = clientOver(server);
    await client.auth.login({ email: 'g@a.test', password: 'p', client_slug: 'acme' });

    const page = await client.users.list();

    expect(page.total).toBe(0);
    expect(server.countOf('POST', '/auth/refresh')).toBe(1);
    expect(server.countOf('GET', '/iam/users')).toBe(2);
    expect(server.callsTo('GET', '/iam/users')[1].headers['authorization']).toBe(
      'Bearer access-2',
    );
  });

  it('shares one refresh between concurrent calls that all get 401', async () => {
    const server = authServer()
      .once('GET', '/iam/users', errorReply(IamErrorCode.AUTH_REQUIRED))
      .once('GET', '/iam/roles', errorReply(IamErrorCode.AUTH_REQUIRED))
      .once('GET', '/iam/scopes', errorReply(IamErrorCode.AUTH_REQUIRED))
      .on('GET', '/iam/users', { body: { data: [], page: 1, limit: 25, total: 0 } })
      .on('GET', '/iam/roles', { body: { data: [], page: 1, limit: 25, total: 0 } })
      .on('GET', '/iam/scopes', { body: { nodes: [] } });
    const client = clientOver(server);
    await client.auth.login({ email: 'g@a.test', password: 'p', client_slug: 'acme' });

    await Promise.all([client.users.list(), client.roles.list(), client.scopes.tree()]);

    // One rotation for three concurrent 401s: five refreshes would present a
    // token the first has already consumed, which is replay (Doc 03 §4.1).
    expect(server.countOf('POST', '/auth/refresh')).toBe(1);
    expect(server.countOf('GET', '/iam/users')).toBe(2);
    expect(server.countOf('GET', '/iam/roles')).toBe(2);
    expect(server.countOf('GET', '/iam/scopes')).toBe(2);
  });

  it('surfaces the original 401 when the refresh is refused, and ends the session', async () => {
    const ended = jest.fn();
    const server = new MockIamServer()
      .on('POST', '/auth/login', { body: TOKENS })
      .on('POST', '/auth/refresh', errorReply(IamErrorCode.AUTH_REQUIRED, 'reused'))
      .on('GET', '/iam/users', errorReply(IamErrorCode.AUTH_REQUIRED, 'expired'));
    const client = clientOver(server, { onSessionEnded: ended });
    await client.auth.login({ email: 'g@a.test', password: 'p', client_slug: 'acme' });

    const error = (await client.users.list().catch((e: unknown) => e)) as IamApiError;

    expect(error).toBeInstanceOf(IamApiError);
    expect(error.message).toBe('expired');
    expect(server.countOf('GET', '/iam/users')).toBe(1);
    expect(await client.session.tokens()).toBeNull();
    expect(ended).toHaveBeenCalledWith('refresh_failed');
  });

  it('renews proactively when the access token is about to lapse', async () => {
    let now = 1_700_000_000_000;
    const server = authServer().on('GET', '/iam/scopes', { body: { nodes: [] } });
    const client = clientOver(server, { now: () => now, refreshLeewaySeconds: 30 });
    await client.auth.login({ email: 'g@a.test', password: 'p', client_slug: 'acme' });

    now += 880_000; // 20 seconds of life left
    await client.scopes.tree();

    expect(server.countOf('POST', '/auth/refresh')).toBe(1);
    expect(server.callsTo('GET', '/iam/scopes')[0].headers['authorization']).toBe(
      'Bearer access-2',
    );
  });

  it('logs out on both sides, even when the revocation call fails', async () => {
    const server = new MockIamServer()
      .on('POST', '/auth/login', { body: TOKENS })
      .on('POST', '/auth/logout', errorReply(IamErrorCode.INTERNAL_ERROR));
    const client = clientOver(server);
    await client.auth.login({ email: 'g@a.test', password: 'p', client_slug: 'acme' });

    await expect(client.auth.logout()).rejects.toBeInstanceOf(IamApiError);

    expect(await client.session.tokens()).toBeNull();
  });

  it('takes the token store it is given, so a browser can persist the session', async () => {
    const store = new MemoryTokenStore();
    const server = authServer();
    await clientOver(server, { tokenStore: store }).auth.login({
      email: 'g@a.test',
      password: 'p',
      client_slug: 'acme',
    });

    // A second client — a reload, in a browser — is authenticated straight away.
    const restored = clientOver(
      server.on('GET', '/iam/scopes', { body: { nodes: [] } }),
      { tokenStore: store },
    );
    await restored.scopes.tree();

    expect(server.callsTo('GET', '/iam/scopes')[0].headers['authorization']).toBe(
      'Bearer access-1',
    );
  });

  describe('grants()', () => {
    it('caches the resolve, and reload() bypasses the cache', async () => {
      const server = authServer().on('GET', '/iam/permissions/resolve', {
        body: GRANTS,
      });
      const client = clientOver(server);

      await client.grants();
      await client.grants();
      expect(server.countOf('GET', '/iam/permissions/resolve')).toBe(1);

      await client.refreshGrants();
      expect(server.countOf('GET', '/iam/permissions/resolve')).toBe(2);
    });

    it('narrows to one application, and keys the cache on it', async () => {
      const server = new MockIamServer().on(
        'GET',
        '/iam/permissions/resolve',
        (request) => ({ body: { ...GRANTS, permissions: [request.query['applicationId']] } }),
      );
      const client = clientOver(server);

      const slice = await client.grants({ applicationId: 'app-1' });

      expect(slice.permissions).toEqual(['app-1']);
      expect(server.calls[0].query).toEqual({ applicationId: 'app-1' });

      await client.grants({ applicationId: 'app-2' });
      expect(server.countOf('GET', '/iam/permissions/resolve')).toBe(2);
    });

    it('empties on login, so one subject never sees another’s grants', async () => {
      const server = authServer().on('GET', '/iam/permissions/resolve', {
        body: GRANTS,
      });
      const client = clientOver(server);

      await client.grants();
      await client.auth.login({ email: 'g@a.test', password: 'p', client_slug: 'acme' });
      await client.grants();

      expect(server.countOf('GET', '/iam/permissions/resolve')).toBe(2);
    });

    it('empties on logout', async () => {
      const server = authServer().on('GET', '/iam/permissions/resolve', {
        body: GRANTS,
      });
      const client = clientOver(server);
      await client.auth.login({ email: 'g@a.test', password: 'p', client_slug: 'acme' });

      await client.grants();
      await client.auth.logout();
      await client.grants();

      expect(server.countOf('GET', '/iam/permissions/resolve')).toBe(2);
    });

    it('invalidateGrants() is the hook for a perms.invalidated subscriber', async () => {
      const server = new MockIamServer().on('GET', '/iam/permissions/resolve', {
        body: GRANTS,
      });
      const client = clientOver(server);

      await client.grants();
      client.invalidateGrants();
      await client.grants();

      expect(server.countOf('GET', '/iam/permissions/resolve')).toBe(2);
    });
  });

  it('exposes the raw requester as an escape hatch for untyped routes', async () => {
    const server = authServer().on('GET', '/iam/audit', { body: { data: [] } });
    const client = clientOver(server);
    await client.auth.login({ email: 'g@a.test', password: 'p', client_slug: 'acme' });

    const answer = await client.request<{ data: unknown[] }>({
      method: 'GET',
      path: '/iam/audit',
      query: { action: 'user.created' },
    });

    expect(answer.data).toEqual([]);
    expect(server.calls[1].headers['authorization']).toBe('Bearer access-1');
    expect(server.calls[1].query).toEqual({ action: 'user.created' });
  });

  it('createIamClient is the same thing', () => {
    expect(createIamClient({ baseUrl: BASE })).toBeInstanceOf(IamClient);
  });

  it('restores tokens taken from anywhere else', async () => {
    const server = new MockIamServer().on('GET', '/iam/scopes', { body: { nodes: [] } });
    const client = clientOver(server);
    const tokens: StoredTokens = {
      accessToken: 'from-a-cookie',
      refreshToken: null,
      expiresAt: null,
    };

    await client.session.restore(tokens);
    await client.scopes.tree();

    expect(server.calls[0].headers['authorization']).toBe('Bearer from-a-cookie');
  });
});
