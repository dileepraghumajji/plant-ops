/**
 * `/iam/role-bindings/*` — where WHO, WHAT and WHERE meet, Doc 06 §9.
 *
 * A binding is the only object in the system that grants anything: subject ×
 * role × scope node, optionally until a date. Everything the resolution engine
 * answers is a fold over these rows (Doc 04 §4).
 */

import type {
  CreateRoleBindingRequest,
  Paginated,
  RoleBindingDTO,
  RoleBindingsQuery,
} from '@plantops/contracts';
import { IAM_ROUTE_PREFIX } from '@plantops/contracts';

import type { Requester } from '../http.js';

export interface RoleBindingsApi {
  /** Subject is user XOR service account; the scope node must be the tenant's. */
  create(body: CreateRoleBindingRequest): Promise<RoleBindingDTO>;
  list(query?: RoleBindingsQuery): Promise<Paginated<RoleBindingDTO>>;
  remove(id: string): Promise<void>;
}

export function roleBindingsEndpoints(request: Requester): RoleBindingsApi {
  const base = `${IAM_ROUTE_PREFIX}/role-bindings`;

  return {
    create: (body) => request({ method: 'POST', path: base, body }),
    list: (query) => request({ method: 'GET', path: base, query: { ...query } }),
    remove: (id) =>
      request({ method: 'DELETE', path: `${base}/${encodeURIComponent(id)}` }),
  };
}
