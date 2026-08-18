/**
 * `IamClient` — one import gives a consumer authenticated, typed IAM access
 * (Doc 08 §2).
 *
 * The composition root, and deliberately the only file that knows all the parts
 * exist: the transport, the token lifecycle, the grants cache and the ten
 * endpoint modules. Everything it wires together is separately constructible, so
 * a consumer with an unusual need — a script that only talks to the registry, a
 * test that wants the cache without a socket — is never forced through this
 * class.
 *
 * ## What it is responsible for that nothing else is
 *
 * Three couplings live here because they exist only when the parts are
 * assembled:
 *
 * 1. The transport asks {@link TokenSession} for a token, and hands it back on a
 *    `401` — which is what makes the automatic, single-flight refresh work
 *    without any endpoint module knowing about tokens.
 * 2. The refresh call itself goes back out through the transport, so it gets the
 *    same base URL, headers, timeout and error mapping as everything else.
 * 3. Any change of identity — login, service-token exchange, logout, refresh —
 *    empties the grants cache. Serving one subject's grants to the next is the
 *    one caching mistake that would hand a user somebody else's menu.
 *
 * ## `/iam/audit` is not here
 *
 * Doc 06 §12's audit read endpoint is the deliverable of roadmap Session 25,
 * which has not been built: there is no `audit.controller.ts`, and
 * `@plantops/contracts` types no audit record or query. A method here would have
 * to invent both, and Session 25 would then be implementing against a client
 * rather than against Doc 06. It is the one gap in "every Doc 06 endpoint has a
 * typed method", and it closes by adding `endpoints/audit.ts` when the endpoint
 * and its contract types land.
 */

import type { ResolvedGrants, ResolveQuery, TokenPairResponse } from '@plantops/contracts';
import { AUTH_ROUTE_PREFIX } from '@plantops/contracts';

import {
  TokenSession,
  type SessionEndReason,
  type TokenStore,
  type TokenSessionOptions,
} from './auth.js';
import {
  applicationsEndpoints,
  authEndpoints,
  clientsEndpoints,
  navigationEndpoints,
  permissionsEndpoints,
  roleBindingsEndpoints,
  rolesEndpoints,
  scopesEndpoints,
  serviceAccountsEndpoints,
  usersEndpoints,
  type ApplicationsApi,
  type AuthApi,
  type ClientsApi,
  type NavigationApi,
  type PermissionsApi,
  type RoleBindingsApi,
  type RolesApi,
  type ScopesApi,
  type ServiceAccountsApi,
  type UsersApi,
} from './endpoints/index.js';
import { HttpTransport, type FetchLike, type Requester } from './http.js';
import { ResolveCache } from './resolve-cache.js';

export interface IamClientOptions {
  /** The API root — the origin, without the `/iam` or `/auth` prefix. */
  baseUrl: string;
  /** Defaults to the runtime's global. Supply one to test, or to instrument. */
  fetch?: FetchLike;
  /** Sent on every request — a correlation header, a user agent. */
  headers?: Readonly<Record<string, string>>;
  /** Abort a request that has taken this long. Omit for no client-side limit. */
  timeoutMs?: number;
  /** Where tokens live. Defaults to memory; a browser supplies its own. */
  tokenStore?: TokenStore;
  /** Renew this many seconds before the access token lapses. Default 30. */
  refreshLeewaySeconds?: TokenSessionOptions['refreshLeewaySeconds'];
  /** How long {@link IamClient.grants} may serve a cached answer. Default 60. */
  resolveCacheTtlSeconds?: number;
  /** Injectable clock, shared by the token expiry and the cache. */
  now?: () => number;
  /** The session ended: the caller logged out, or a refresh was refused. */
  onSessionEnded?: (reason: SessionEndReason) => void;
}

export class IamClient {
  /** The token lifecycle: read, restore or clear credentials directly. */
  readonly session: TokenSession;

  readonly auth: AuthApi;
  readonly applications: ApplicationsApi;
  readonly clients: ClientsApi;
  readonly scopes: ScopesApi;
  readonly roles: RolesApi;
  readonly users: UsersApi;
  readonly roleBindings: RoleBindingsApi;
  readonly serviceAccounts: ServiceAccountsApi;
  readonly permissions: PermissionsApi;
  readonly navigation: NavigationApi;

  /**
   * The raw, authenticated request function.
   *
   * The escape hatch for an endpoint this library does not yet type — `/iam/audit`
   * today — so that needing one route never means abandoning the token handling
   * and error mapping for all of them.
   */
  readonly request: Requester;

  private readonly grantsCache: ResolveCache;

  constructor(options: IamClientOptions) {
    const transport = new HttpTransport({
      baseUrl: options.baseUrl,
      fetch: options.fetch,
      headers: options.headers,
      timeoutMs: options.timeoutMs,
      authorize: () => this.session.accessToken(),
      reauthorize: (usedToken) => this.session.reauthorize(usedToken),
    });
    this.request = transport.request;

    this.session = new TokenSession(
      (refreshToken) =>
        this.request<TokenPairResponse>({
          method: 'POST',
          path: `${AUTH_ROUTE_PREFIX}/refresh`,
          body: { refresh_token: refreshToken },
          auth: 'none',
        }),
      {
        store: options.tokenStore,
        now: options.now,
        refreshLeewaySeconds: options.refreshLeewaySeconds,
        onSessionEnded: options.onSessionEnded,
      },
    );

    this.permissions = permissionsEndpoints(this.request);
    this.grantsCache = new ResolveCache((query) => this.permissions.resolve(query), {
      ttlSeconds: options.resolveCacheTtlSeconds,
      now: options.now,
    });

    this.auth = authEndpoints(this.request, this.session, () =>
      this.grantsCache.clear(),
    );
    this.applications = applicationsEndpoints(this.request);
    this.clients = clientsEndpoints(this.request);
    this.scopes = scopesEndpoints(this.request);
    this.roles = rolesEndpoints(this.request);
    this.users = usersEndpoints(this.request);
    this.roleBindings = roleBindingsEndpoints(this.request);
    this.serviceAccounts = serviceAccountsEndpoints(this.request);
    this.navigation = navigationEndpoints(this.request);
  }

  /**
   * The bearer's grants, cached (Doc 06 §11).
   *
   * What a module's `PermissionGuard` should call on every gated request: the
   * burst of authorizations one request fan-out produces collapses into a single
   * resolve, and the answer is reused for the cache's lifetime.
   */
  grants(query: ResolveQuery = {}): Promise<ResolvedGrants> {
    return this.grantsCache.get(query);
  }

  /** Re-resolves now, ignoring the cache — after a change the caller just made. */
  refreshGrants(query: ResolveQuery = {}): Promise<ResolvedGrants> {
    return this.grantsCache.reload(query);
  }

  /**
   * Drops cached grants — for one application, or all of them.
   *
   * The hook a consumer subscribed to `perms.invalidated` (Doc 04 §7) calls, and
   * the reason such a consumer may safely raise `resolveCacheTtlSeconds`.
   */
  invalidateGrants(applicationId?: string): void {
    this.grantsCache.invalidate(applicationId);
  }
}

/** `createIamClient({ baseUrl })` — the same thing, for consumers that prefer it. */
export function createIamClient(options: IamClientOptions): IamClient {
  return new IamClient(options);
}
