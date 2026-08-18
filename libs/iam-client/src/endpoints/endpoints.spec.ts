/**
 * One row per route in Doc 06 — the proof that "every Doc 06 endpoint has a
 * typed method" is a fact rather than an intention.
 *
 * Each row states the section it comes from, the verb and path the API
 * publishes, and the call a consumer makes; the test asserts that the call
 * produced exactly that request. A route that is renamed, a path segment that
 * stops being encoded, a PUT that quietly becomes a PATCH — all of them fail
 * here, against the document rather than against the implementation.
 *
 * `/iam/audit` (§12) is the one absent row: the endpoint is roadmap Session 25
 * and does not exist yet. See the header of `client.ts`.
 */

import { IamClient } from '../client.js';
import { MockIamServer } from '../testing/mock-server.js';

interface RouteCase {
  /** The section of Doc 06 the route is specified in. */
  doc: string;
  method: string;
  path: string;
  call: (client: IamClient) => Promise<unknown>;
  /** What the server should answer, when the call needs a usable one. */
  reply?: unknown;
  /** The body the client is expected to have sent. */
  body?: unknown;
  query?: Record<string, string>;
}

const TOKENS = { access_token: 'a', refresh_token: 'r', expires_in: 900 };

const CASES: RouteCase[] = [
  // ── §3 auth ──────────────────────────────────────────────────────────────
  {
    doc: '§3',
    method: 'POST',
    path: '/auth/login',
    reply: TOKENS,
    body: { email: 'g@a.test', password: 'p', client_slug: 'acme' },
    call: (c) => c.auth.login({ email: 'g@a.test', password: 'p', client_slug: 'acme' }),
  },
  {
    doc: '§3',
    method: 'POST',
    path: '/auth/refresh',
    reply: TOKENS,
    body: { refresh_token: 'r0' },
    call: async (c) => {
      await c.session.restore({
        accessToken: 'a0',
        refreshToken: 'r0',
        expiresAt: null,
      });
      return c.auth.refresh();
    },
  },
  {
    doc: '§3',
    method: 'POST',
    path: '/auth/token',
    reply: { access_token: 'svc', expires_in: 300 },
    body: { account_key: 'k', account_secret: 's' },
    call: (c) => c.auth.serviceToken({ account_key: 'k', account_secret: 's' }),
  },
  {
    doc: '§3',
    method: 'POST',
    path: '/auth/logout',
    body: {},
    call: (c) => c.auth.logout(),
  },
  { doc: '§3', method: 'GET', path: '/auth/sessions', reply: [], call: (c) => c.auth.sessions() },
  {
    doc: '§3',
    method: 'POST',
    path: '/auth/sessions/s-1/revoke',
    call: (c) => c.auth.revokeSession('s-1'),
  },
  {
    doc: '§3',
    method: 'POST',
    path: '/auth/password/reset-request',
    body: { email: 'g@a.test', client_slug: 'acme' },
    call: (c) =>
      c.auth.requestPasswordReset({ email: 'g@a.test', client_slug: 'acme' }),
  },
  {
    doc: '§3',
    method: 'POST',
    path: '/auth/password/reset',
    body: { token: 't', new_password: 'n' },
    call: (c) => c.auth.resetPassword({ token: 't', new_password: 'n' }),
  },

  // ── §4 application registry ──────────────────────────────────────────────
  {
    doc: '§4',
    method: 'POST',
    path: '/iam/applications',
    body: { key: 'gatepass', name: 'Gatepass' },
    call: (c) => c.applications.create({ key: 'gatepass', name: 'Gatepass' }),
  },
  {
    doc: '§4',
    method: 'GET',
    path: '/iam/applications',
    query: { page: '2', limit: '50' },
    call: (c) => c.applications.list({ page: 2, limit: 50 }),
  },
  {
    doc: '§4',
    method: 'PATCH',
    path: '/iam/applications/app-1',
    body: { is_active: false },
    call: (c) => c.applications.update('app-1', { is_active: false }),
  },
  {
    doc: '§4',
    method: 'POST',
    path: '/iam/applications/app-1/manifest',
    body: { key: 'gatepass', name: 'Gatepass', permissions: [], nav: [] },
    call: (c) =>
      c.applications.upsertManifest('app-1', {
        key: 'gatepass',
        name: 'Gatepass',
        permissions: [],
        nav: [],
      }),
  },
  {
    // The preview behind Doc 09 §2.1's upload screen — the same route, with
    // `?dryRun=true`. Pinned here because the flag is the whole difference
    // between showing an operator a diff and writing one.
    doc: '§4',
    method: 'POST',
    path: '/iam/applications/app-1/manifest',
    query: { dryRun: 'true' },
    body: { key: 'gatepass', name: 'Gatepass', permissions: [], nav: [] },
    call: (c) =>
      c.applications.previewManifest('app-1', {
        key: 'gatepass',
        name: 'Gatepass',
        permissions: [],
        nav: [],
      }),
  },
  {
    doc: '§4',
    method: 'POST',
    path: '/iam/applications/app-1/permissions',
    body: { permissions: [{ key: 'gatepass.dc.create', name: 'Create DC' }] },
    call: (c) =>
      c.applications.addPermissions('app-1', {
        permissions: [{ key: 'gatepass.dc.create', name: 'Create DC' }],
      }),
  },
  {
    doc: '§4',
    method: 'GET',
    path: '/iam/applications/app-1/permissions',
    call: (c) => c.applications.listPermissions('app-1'),
  },
  {
    doc: '§4',
    method: 'POST',
    path: '/iam/applications/app-1/nav',
    body: { nodes: [] },
    call: (c) => c.applications.addNavNodes('app-1', { nodes: [] }),
  },
  {
    doc: '§4',
    method: 'GET',
    path: '/iam/applications/app-1/nav',
    call: (c) => c.applications.navTree('app-1'),
  },
  {
    doc: '§4',
    method: 'POST',
    path: '/iam/applications/app-1/nav-permissions',
    body: { mappings: [] },
    call: (c) => c.applications.mapNavPermissions('app-1', { mappings: [] }),
  },
  {
    doc: '§4',
    method: 'DELETE',
    path: '/iam/applications/app-1/nav-permissions',
    body: { mappings: [] },
    call: (c) => c.applications.unmapNavPermissions('app-1', { mappings: [] }),
  },

  // ── §5 clients ───────────────────────────────────────────────────────────
  {
    doc: '§5',
    method: 'POST',
    path: '/iam/clients',
    body: { slug: 'acme', name: 'Acme' },
    call: (c) => c.clients.create({ slug: 'acme', name: 'Acme' }),
  },
  { doc: '§5', method: 'GET', path: '/iam/clients', call: (c) => c.clients.list() },
  {
    doc: '§5',
    method: 'PATCH',
    path: '/iam/clients/c-1',
    body: { status: 'suspended' },
    call: (c) => c.clients.update('c-1', { status: 'suspended' }),
  },
  {
    doc: '§5',
    method: 'POST',
    path: '/iam/clients/c-1/applications',
    body: { applications: [{ application_id: 'app-1' }] },
    call: (c) =>
      c.clients.enableApplications('c-1', {
        applications: [{ application_id: 'app-1' }],
      }),
  },
  {
    doc: '§5',
    method: 'GET',
    path: '/iam/clients/c-1/applications',
    reply: [],
    call: (c) => c.clients.listApplications('c-1'),
  },
  {
    doc: '§5',
    method: 'PATCH',
    path: '/iam/clients/c-1/applications/app-1',
    body: { enabled: false },
    call: (c) => c.clients.updateApplication('c-1', 'app-1', { enabled: false }),
  },
  {
    doc: '§5',
    method: 'POST',
    path: '/iam/clients/c-1/admins',
    body: { email: 'admin@acme.test', full_name: 'Acme Admin', password: 'correct horse' },
    call: (c) =>
      c.clients.createAdmin('c-1', {
        email: 'admin@acme.test',
        full_name: 'Acme Admin',
        password: 'correct horse',
      }),
  },

  // ── §6 scope tree ────────────────────────────────────────────────────────
  {
    doc: '§6',
    method: 'POST',
    path: '/iam/scopes',
    body: { kind: 'plant', name: 'Plant 1', parent_id: 's-root' },
    call: (c) =>
      c.scopes.create({ kind: 'plant', name: 'Plant 1', parent_id: 's-root' }),
  },
  { doc: '§6', method: 'GET', path: '/iam/scopes', call: (c) => c.scopes.tree() },
  {
    doc: '§6',
    method: 'PATCH',
    path: '/iam/scopes/s-1',
    body: { name: 'Plant 2' },
    call: (c) => c.scopes.update('s-1', { name: 'Plant 2' }),
  },
  {
    doc: '§6',
    method: 'DELETE',
    path: '/iam/scopes/s-1',
    call: (c) => c.scopes.remove('s-1'),
  },

  // ── §7 roles ─────────────────────────────────────────────────────────────
  {
    doc: '§7',
    method: 'POST',
    path: '/iam/roles',
    body: { name: 'Gate Supervisor' },
    call: (c) => c.roles.create({ name: 'Gate Supervisor' }),
  },
  { doc: '§7', method: 'GET', path: '/iam/roles', call: (c) => c.roles.list() },
  {
    doc: '§7',
    method: 'PATCH',
    path: '/iam/roles/r-1',
    body: { name: 'Gate Lead' },
    call: (c) => c.roles.update('r-1', { name: 'Gate Lead' }),
  },
  {
    doc: '§7',
    method: 'DELETE',
    path: '/iam/roles/r-1',
    call: (c) => c.roles.remove('r-1'),
  },
  {
    // Not in Doc 06 §7's table: added with Session 32's picker, because the
    // client tier had no way to enumerate what a role may be given — the
    // catalog itself lives behind platform authority no tenant admin holds.
    doc: '§7',
    method: 'GET',
    path: '/iam/roles/permission-catalog',
    call: (c) => c.roles.permissionCatalog(),
  },
  {
    doc: '§7',
    method: 'GET',
    path: '/iam/roles/r-1/permissions',
    call: (c) => c.roles.permissions('r-1'),
  },
  {
    doc: '§7',
    method: 'PUT',
    path: '/iam/roles/r-1/permissions',
    body: { permission_ids: ['p-1'] },
    call: (c) => c.roles.setPermissions('r-1', { permission_ids: ['p-1'] }),
  },

  // ── §8 users ─────────────────────────────────────────────────────────────
  {
    doc: '§8',
    method: 'POST',
    path: '/iam/users',
    body: { email: 'gita@acme.test', full_name: 'Gita Rao' },
    call: (c) => c.users.create({ email: 'gita@acme.test', full_name: 'Gita Rao' }),
  },
  {
    doc: '§8',
    method: 'GET',
    path: '/iam/users',
    query: { status: 'locked', q: 'gita', page: '1' },
    call: (c) => c.users.list({ status: 'locked', q: 'gita', page: 1 }),
  },
  {
    doc: '§8',
    method: 'GET',
    path: '/iam/users/u-1',
    call: (c) => c.users.detail('u-1'),
  },
  {
    doc: '§8',
    method: 'PATCH',
    path: '/iam/users/u-1',
    body: { status: 'disabled' },
    call: (c) => c.users.update('u-1', { status: 'disabled' }),
  },
  {
    doc: '§8',
    method: 'POST',
    path: '/iam/users/bulk',
    body: { format: 'json', users: [{ email: 'g@a.test', full_name: 'G' }] },
    call: (c) =>
      c.users.bulk({ format: 'json', users: [{ email: 'g@a.test', full_name: 'G' }] }),
  },
  {
    doc: '§8',
    method: 'GET',
    path: '/iam/users/by-role/r-1',
    query: { limit: '10' },
    call: (c) => c.users.byRole('r-1', { limit: 10 }),
  },

  // ── §9 role bindings ─────────────────────────────────────────────────────
  {
    doc: '§9',
    method: 'POST',
    path: '/iam/role-bindings',
    body: { user_id: 'u-1', role_id: 'r-1', scope_node_id: 's-1' },
    call: (c) =>
      c.roleBindings.create({ user_id: 'u-1', role_id: 'r-1', scope_node_id: 's-1' }),
  },
  {
    doc: '§9',
    method: 'GET',
    path: '/iam/role-bindings',
    query: { user_id: 'u-1' },
    call: (c) => c.roleBindings.list({ user_id: 'u-1' }),
  },
  {
    doc: '§9',
    method: 'DELETE',
    path: '/iam/role-bindings/b-1',
    call: (c) => c.roleBindings.remove('b-1'),
  },

  // ── §10 service accounts ─────────────────────────────────────────────────
  {
    doc: '§10',
    method: 'POST',
    path: '/iam/service-accounts',
    body: { name: 'gatepass-sync' },
    call: (c) => c.serviceAccounts.create({ name: 'gatepass-sync' }),
  },
  {
    doc: '§10',
    method: 'GET',
    path: '/iam/service-accounts',
    call: (c) => c.serviceAccounts.list(),
  },
  {
    doc: '§10',
    method: 'POST',
    path: '/iam/service-accounts/sa-1/rotate',
    call: (c) => c.serviceAccounts.rotate('sa-1'),
  },
  {
    doc: '§10',
    method: 'PATCH',
    path: '/iam/service-accounts/sa-1',
    body: { status: 'revoked' },
    call: (c) => c.serviceAccounts.update('sa-1', { status: 'revoked' }),
  },

  // ── §11 resolution ───────────────────────────────────────────────────────
  {
    doc: '§11',
    method: 'GET',
    path: '/iam/permissions/resolve',
    query: { applicationId: 'app-1' },
    call: (c) => c.permissions.resolve({ applicationId: 'app-1' }),
  },
  {
    doc: '§11',
    method: 'POST',
    path: '/iam/permissions/check',
    body: { permission: 'gatepass.dc.approve', scopeNodeId: 's-1' },
    call: (c) =>
      c.permissions.check({ permission: 'gatepass.dc.approve', scopeNodeId: 's-1' }),
  },
  {
    doc: '§11',
    method: 'GET',
    path: '/iam/navigation',
    query: { applicationId: 'app-1' },
    call: (c) => c.navigation.tree({ applicationId: 'app-1' }),
  },
  {
    doc: '§11',
    method: 'POST',
    path: '/iam/introspect',
    body: { token: 'jwt' },
    call: (c) => c.permissions.introspect('jwt'),
  },
  {
    doc: '§11',
    method: 'GET',
    path: '/iam/.well-known/jwks.json',
    reply: { keys: [] },
    call: (c) => c.permissions.jwks(),
  },
];

describe('Doc 06 route coverage', () => {
  it.each(CASES)('$doc $method $path', async (routeCase) => {
    const server = new MockIamServer().on(routeCase.method, routeCase.path, {
      body: routeCase.reply ?? {},
    });
    const client = new IamClient({ baseUrl: 'https://iam.test', fetch: server.fetch });

    await routeCase.call(client);

    const [call] = server.callsTo(routeCase.method, routeCase.path);
    expect(call).toBeDefined();
    expect(call.body).toEqual(routeCase.body);
    expect(call.query).toEqual(routeCase.query ?? {});
  });

  it('covers every route Doc 06 publishes, and each of them once', () => {
    // The query is part of the signature because one route now has two modes:
    // `POST …/manifest` uploads and `POST …/manifest?dryRun=true` previews, and
    // both are typed methods a consumer can call. Signing on the path alone
    // would make the second look like a duplicate of the first.
    const signatures = CASES.map(
      (route) =>
        `${route.method} ${route.path}${
          route.query === undefined ? '' : `?${new URLSearchParams(route.query).toString()}`
        }`,
    );
    expect(new Set(signatures).size).toBe(signatures.length);
    expect(signatures).toHaveLength(55);
  });

  it('encodes path segments rather than pasting them in', async () => {
    const server = new MockIamServer().on('GET', '/iam/users/a b/c', { body: {} });
    const client = new IamClient({ baseUrl: 'https://iam.test', fetch: server.fetch });

    // The server sees the segment as one segment, not as a new path.
    await expect(client.users.detail('a b/c')).rejects.toThrow('no route');
    expect(server.calls[0].path).toBe('/iam/users/a%20b%2Fc');
  });
});
