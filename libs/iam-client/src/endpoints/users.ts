/**
 * `/iam/users/*` — the WHO dimension, Doc 06 §8.
 *
 * Note what `bulk` returns: a `200` with a per-row report, not a `201` and not a
 * `207`. Valid rows commit even when others do not, so the response is the only
 * place a caller learns which addresses landed — see `BulkUserUploadResponse`.
 */

import type {
  BulkUserUploadRequest,
  BulkUserUploadResponse,
  CreateUserRequest,
  Paginated,
  PaginationQuery,
  UpdateUserRequest,
  UserByRoleDTO,
  UserDetailDTO,
  UserDTO,
  UserStatus,
} from '@plantops/contracts';
import { IAM_ROUTE_PREFIX } from '@plantops/contracts';

import type { Requester } from '../http.js';

/**
 * `GET /iam/users`'s filters (Doc 06 §8, Doc 09 §3.3).
 *
 * Declared here rather than imported: `@plantops/contracts` types the bodies
 * and the responses of this surface, not every query string, and the roadmap
 * freezes `contracts` for this session. `q` is the free-text search over name
 * and email; `status` is the "locked users" filter the console opens with.
 */
export interface UsersQuery extends PaginationQuery {
  status?: UserStatus;
  q?: string;
}

export interface UsersApi {
  create(body: CreateUserRequest): Promise<UserDTO>;
  list(query?: UsersQuery): Promise<Paginated<UserDTO>>;
  /** Profile plus the bindings behind it. */
  detail(id: string): Promise<UserDetailDTO>;
  /** Update, lock, unlock or disable (Doc 03 §8). */
  update(id: string, body: UpdateUserRequest): Promise<UserDetailDTO>;
  /** The roster upload and its per-row report. At most 500 rows. */
  bulk(body: BulkUserUploadRequest): Promise<BulkUserUploadResponse>;
  /**
   * "Users by Role" — a holder appears once, with every scope they hold the
   * role at gathered into `scopes`, expired bindings flagged rather than
   * dropped.
   */
  byRole(roleId: string, query?: PaginationQuery): Promise<Paginated<UserByRoleDTO>>;
}

export function usersEndpoints(request: Requester): UsersApi {
  const base = `${IAM_ROUTE_PREFIX}/users`;
  const at = (id: string) => `${base}/${encodeURIComponent(id)}`;

  return {
    create: (body) => request({ method: 'POST', path: base, body }),
    list: (query) => request({ method: 'GET', path: base, query: { ...query } }),
    detail: (id) => request({ method: 'GET', path: at(id) }),
    update: (id, body) => request({ method: 'PATCH', path: at(id), body }),
    bulk: (body) => request({ method: 'POST', path: `${base}/bulk`, body }),
    byRole: (roleId, query) =>
      request({
        method: 'GET',
        path: `${base}/by-role/${encodeURIComponent(roleId)}`,
        query: { ...query },
      }),
  };
}
