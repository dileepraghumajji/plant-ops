/**
 * `/iam/roles/*` — the WHAT dimension, Doc 06 §7.
 *
 * A role is a bag of permissions drawn from the tenant's *enabled* applications;
 * `setPermissions` is a PUT because the screen behind it is a checklist, and a
 * checklist submits a set, not a diff.
 */

import type {
  CreateRoleRequest,
  Paginated,
  PaginationQuery,
  RoleDTO,
  RolePermissionsResponse,
  SetRolePermissionsRequest,
  UpdateRoleRequest,
} from '@plantops/contracts';
import { IAM_ROUTE_PREFIX } from '@plantops/contracts';

import type { Requester } from '../http.js';

export interface RolesApi {
  create(body: CreateRoleRequest): Promise<RoleDTO>;
  list(query?: PaginationQuery): Promise<Paginated<RoleDTO>>;
  update(id: string, body: UpdateRoleRequest): Promise<RoleDTO>;
  /** Cascades the role's bindings, with an audit record for each (Doc 06 §7). */
  remove(id: string): Promise<void>;
  permissions(id: string): Promise<RolePermissionsResponse>;
  setPermissions(
    id: string,
    body: SetRolePermissionsRequest,
  ): Promise<RolePermissionsResponse>;
}

export function rolesEndpoints(request: Requester): RolesApi {
  const base = `${IAM_ROUTE_PREFIX}/roles`;
  const at = (id: string, suffix = '') =>
    `${base}/${encodeURIComponent(id)}${suffix}`;

  return {
    create: (body) => request({ method: 'POST', path: base, body }),
    list: (query) => request({ method: 'GET', path: base, query: { ...query } }),
    update: (id, body) => request({ method: 'PATCH', path: at(id), body }),
    remove: (id) => request({ method: 'DELETE', path: at(id) }),
    permissions: (id) => request({ method: 'GET', path: at(id, '/permissions') }),
    setPermissions: (id, body) =>
      request({ method: 'PUT', path: at(id, '/permissions'), body }),
  };
}
