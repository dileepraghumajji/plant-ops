/**
 * `/iam/permissions/*`, `/iam/introspect`, `/iam/.well-known/jwks.json` — the
 * resolution endpoints of Doc 06 §11.
 *
 * These are the contract every future PlantOps module depends on, and the only
 * part of this library that is on a hot path. `resolve` here is the *uncached*
 * call; the cached one a module should actually use is `IamClient.grants()`,
 * which puts {@link ResolveCache} in front of it.
 *
 * `jwks` is deliberately unauthenticated: it is the public half of the signing
 * key, fetched by anyone verifying a token locally — which Doc 06 §11 says
 * modules should prefer over `introspect`, so that the IAM stays off the
 * per-request critical path.
 */

import type {
  IntrospectResponse,
  JwksResponse,
  PermissionCheckRequest,
  PermissionCheckResponse,
  ResolvedGrants,
  ResolveQuery,
} from '@plantops/contracts';
import { IAM_ROUTE_PREFIX } from '@plantops/contracts';

import type { Requester } from '../http.js';

export interface PermissionsApi {
  /**
   * The bearer's complete grant set, minimized per Doc 04 §4.1. Not paginated —
   * it is one cacheable unit. `applicationId` narrows it to one app's slice.
   */
  resolve(query?: ResolveQuery): Promise<ResolvedGrants>;
  /** The point check: does this subject hold this permission over this node? */
  check(body: PermissionCheckRequest): Promise<PermissionCheckResponse>;
  /** For modules verifying an opaque or edge-case token. */
  introspect(token: string): Promise<IntrospectResponse>;
  /** The public keys, for local JWT verification. Needs no bearer token. */
  jwks(): Promise<JwksResponse>;
}

export function permissionsEndpoints(request: Requester): PermissionsApi {
  return {
    resolve: (query) =>
      request({
        method: 'GET',
        path: `${IAM_ROUTE_PREFIX}/permissions/resolve`,
        query: { ...query },
      }),
    check: (body) =>
      request({
        method: 'POST',
        path: `${IAM_ROUTE_PREFIX}/permissions/check`,
        body,
      }),
    introspect: (token) =>
      request({
        method: 'POST',
        path: `${IAM_ROUTE_PREFIX}/introspect`,
        body: { token },
      }),
    jwks: () =>
      request({
        method: 'GET',
        path: `${IAM_ROUTE_PREFIX}/.well-known/jwks.json`,
        auth: 'none',
      }),
  };
}
