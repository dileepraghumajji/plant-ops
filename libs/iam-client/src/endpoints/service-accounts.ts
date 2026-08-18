/**
 * `/iam/service-accounts/*` — non-human subjects, Doc 06 §10.
 *
 * `create` and `rotate` are the only two calls in this library that return a
 * secret, and they return it exactly once (`ServiceAccountSecretDTO`). A caller
 * that discards it cannot ask for it again — only rotate, which invalidates the
 * one it lost.
 */

import type {
  CreateServiceAccountRequest,
  Paginated,
  PaginationQuery,
  ServiceAccountDTO,
  ServiceAccountSecretDTO,
  UpdateServiceAccountRequest,
} from '@plantops/contracts';
import { IAM_ROUTE_PREFIX } from '@plantops/contracts';

import type { Requester } from '../http.js';

export interface ServiceAccountsApi {
  create(body: CreateServiceAccountRequest): Promise<ServiceAccountSecretDTO>;
  list(query?: PaginationQuery): Promise<Paginated<ServiceAccountDTO>>;
  rotate(id: string): Promise<ServiceAccountSecretDTO>;
  /** Revoke or reactivate. */
  update(id: string, body: UpdateServiceAccountRequest): Promise<ServiceAccountDTO>;
}

export function serviceAccountsEndpoints(request: Requester): ServiceAccountsApi {
  const base = `${IAM_ROUTE_PREFIX}/service-accounts`;
  const at = (id: string, suffix = '') =>
    `${base}/${encodeURIComponent(id)}${suffix}`;

  return {
    create: (body) => request({ method: 'POST', path: base, body }),
    list: (query) => request({ method: 'GET', path: base, query: { ...query } }),
    rotate: (id) => request({ method: 'POST', path: at(id, '/rotate') }),
    update: (id, body) => request({ method: 'PATCH', path: at(id), body }),
  };
}
