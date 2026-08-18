import type { FetchLike, HttpResponseLike } from '@plantops/iam-client';
import { act, render, screen, waitFor } from '@testing-library/react';
import { App as AntApp } from 'antd';
import * as React from 'react';

import { GrantsProvider } from './grants-provider';
import { IamProvider, useAuth } from './iam-provider';
import { TOKEN_STORAGE_KEY } from './token-store';
import { usePermission } from './use-permission';

/**
 * The whole sign-in lifecycle, end to end through the real `IamClient`.
 *
 * Nothing is stubbed below the transport: the provider, the client, the token
 * store and the grants provider are the shipping ones, and only the socket is
 * replaced. That is what makes the assertions meaningful — a change that breaks
 * the wiring between them fails here rather than in a browser.
 */

function jwt(claims: Record<string, unknown>): string {
  const encode = (value: unknown): string =>
    Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'RS256' })}.${encode(claims)}.sig`;
}

const ACCESS_TOKEN = jwt({
  iss: 'plantops-iam',
  sub: 'user-1',
  sty: 'user',
  cid: 'client-1',
  sid: 'session-1',
  iat: 1_700_000_000,
  exp: 4_100_000_000,
});

interface Route {
  path: string;
  status?: number;
  body: unknown;
}

/** A `FetchLike` that answers a fixed route table and records every call. */
function fakeServer(routes: Route[]): { fetch: FetchLike; paths: string[] } {
  const paths: string[] = [];
  const fetch: FetchLike = async (url, init) => {
    const { pathname } = new URL(url);
    paths.push(`${init.method} ${pathname}`);
    const route = routes.find((candidate) => candidate.path === pathname);
    const status = route?.status ?? (route === undefined ? 404 : 200);
    const body =
      route?.body ??
      ({ error: { code: 'NOT_FOUND', message: 'no route', requestId: 'r' } } as const);

    const response: HttpResponseLike = {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: () => null },
      text: async () => JSON.stringify(body),
    };
    return response;
  };
  return { fetch, paths };
}

const LOGIN_ROUTES: Route[] = [
  {
    path: '/auth/login',
    body: { access_token: ACCESS_TOKEN, refresh_token: 'refresh-1', expires_in: 900 },
  },
  {
    path: '/iam/permissions/resolve',
    body: {
      permissions: ['iam.client.user.read'],
      scopes: { 'iam.client.user.read': ['n_root'] },
    },
  },
  { path: '/auth/logout', status: 204, body: null },
];

function Harness(): React.ReactElement {
  const { status, subject, login, logout, endedReason } = useAuth();
  const canReadUsers = usePermission('iam.client.user.read');
  const canCreateUsers = usePermission('iam.client.user.create');

  return (
    <div>
      <span data-testid="status">{status}</span>
      <span data-testid="subject">{subject?.id ?? '-'}</span>
      <span data-testid="email">{subject?.email ?? '-'}</span>
      <span data-testid="ended">{endedReason ?? '-'}</span>
      <span data-testid="read">{String(canReadUsers)}</span>
      <span data-testid="create">{String(canCreateUsers)}</span>
      <button
        type="button"
        onClick={() => {
          void login({
            email: 'ops@acme.test',
            password: 'correct horse',
            client_slug: 'acme',
          });
        }}
      >
        sign in
      </button>
      <button type="button" onClick={() => void logout()}>
        sign out
      </button>
    </div>
  );
}

function mount(fetch: FetchLike): void {
  render(
    <AntApp>
      <IamProvider baseUrl="https://iam.test" fetch={fetch}>
        <GrantsProvider>
          <Harness />
        </GrantsProvider>
      </IamProvider>
    </AntApp>,
  );
}

describe('<IamProvider>', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('settles to unauthenticated when nothing is stored', async () => {
    mount(fakeServer([]).fetch);
    await waitFor(() =>
      expect(screen.getByTestId('status').textContent).toBe('unauthenticated'),
    );
  });

  it('signs in, exposes the subject, and resolves grants', async () => {
    const server = fakeServer(LOGIN_ROUTES);
    mount(server.fetch);

    await waitFor(() =>
      expect(screen.getByTestId('status').textContent).toBe('unauthenticated'),
    );
    await act(async () => {
      screen.getByText('sign in').click();
    });

    await waitFor(() =>
      expect(screen.getByTestId('status').textContent).toBe('authenticated'),
    );
    // From the token's claims — unverified, display only (see claims.ts).
    expect(screen.getByTestId('subject').textContent).toBe('user-1');
    // From what the user typed; the token carries nothing human-readable.
    expect(screen.getByTestId('email').textContent).toBe('ops@acme.test');

    await waitFor(() => expect(screen.getByTestId('read').textContent).toBe('true'));
    // Deny-by-default: a permission the resolve did not return is not held.
    expect(screen.getByTestId('create').textContent).toBe('false');
    expect(server.paths).toContain('GET /iam/permissions/resolve');
  });

  it('survives a reload — the session is read back from storage', async () => {
    localStorage.setItem(
      TOKEN_STORAGE_KEY,
      JSON.stringify({
        tokens: { accessToken: ACCESS_TOKEN, refreshToken: 'r', expiresAt: null },
        identity: { email: 'ops@acme.test', clientSlug: 'acme' },
      }),
    );

    mount(fakeServer(LOGIN_ROUTES).fetch);

    await waitFor(() =>
      expect(screen.getByTestId('status').textContent).toBe('authenticated'),
    );
    expect(screen.getByTestId('email').textContent).toBe('ops@acme.test');
  });

  it('signs out and forgets the tokens', async () => {
    const server = fakeServer(LOGIN_ROUTES);
    mount(server.fetch);

    await waitFor(() =>
      expect(screen.getByTestId('status').textContent).toBe('unauthenticated'),
    );
    await act(async () => {
      screen.getByText('sign in').click();
    });
    await waitFor(() =>
      expect(screen.getByTestId('status').textContent).toBe('authenticated'),
    );

    await act(async () => {
      screen.getByText('sign out').click();
    });

    await waitFor(() =>
      expect(screen.getByTestId('status').textContent).toBe('unauthenticated'),
    );
    expect(localStorage.getItem(TOKEN_STORAGE_KEY)).toBeNull();
    expect(server.paths).toContain('POST /auth/logout');
    expect(screen.getByTestId('read').textContent).toBe('false');
  });

  /**
   * The other-tab case. One origin, one store: a sign-out anywhere has to end
   * the session everywhere, or the remaining tab keeps rendering a console
   * whose every request now fails.
   */
  it('ends the session when another tab clears the store', async () => {
    localStorage.setItem(
      TOKEN_STORAGE_KEY,
      JSON.stringify({
        tokens: { accessToken: ACCESS_TOKEN, refreshToken: 'r', expiresAt: null },
        identity: null,
      }),
    );
    mount(fakeServer(LOGIN_ROUTES).fetch);
    await waitFor(() =>
      expect(screen.getByTestId('status').textContent).toBe('authenticated'),
    );

    await act(async () => {
      localStorage.removeItem(TOKEN_STORAGE_KEY);
      window.dispatchEvent(
        new StorageEvent('storage', {
          key: TOKEN_STORAGE_KEY,
          storageArea: localStorage,
        }),
      );
    });

    await waitFor(() =>
      expect(screen.getByTestId('status').textContent).toBe('unauthenticated'),
    );
  });

  /**
   * Doc 03 §4.1: a refused refresh means the session is over — expired, revoked
   * or replayed. The console must return to the login screen rather than retry
   * forever, and should be able to say why.
   */
  it('reports a refused refresh as the reason the session ended', async () => {
    localStorage.setItem(
      TOKEN_STORAGE_KEY,
      JSON.stringify({
        // Already expired, so the very next request triggers a proactive renew.
        tokens: {
          accessToken: ACCESS_TOKEN,
          refreshToken: 'stale',
          expiresAt: Date.now() - 1_000,
        },
        identity: null,
      }),
    );

    const server = fakeServer([
      {
        path: '/auth/refresh',
        status: 401,
        body: {
          error: { code: 'AUTH_REQUIRED', message: 'replayed', requestId: 'r-1' },
        },
      },
      ...LOGIN_ROUTES.filter((route) => route.path !== '/auth/login'),
    ]);
    mount(server.fetch);

    await waitFor(() =>
      expect(screen.getByTestId('status').textContent).toBe('unauthenticated'),
    );
    expect(screen.getByTestId('ended').textContent).toBe('refresh_failed');
    expect(server.paths).toContain('POST /auth/refresh');
  });
});
