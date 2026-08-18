/**
 * `/iam/clients/*` — tenant provisioning, Doc 06 §5.
 *
 * Platform-admin surface: creating a tenant, enabling applications for it, and
 * minting the first client-admin who can then do everything else themselves
 * (Doc 02 §5).
 */

import type {
  ClientAdminDTO,
  ClientApplicationDTO,
  ClientDTO,
  CreateClientAdminRequest,
  CreateClientRequest,
  EnableApplicationsRequest,
  Paginated,
  PaginationQuery,
  UpdateClientApplicationRequest,
  UpdateClientRequest,
} from '@plantops/contracts';
import { IAM_ROUTE_PREFIX } from '@plantops/contracts';

import type { Requester } from '../http.js';

export interface ClientsApi {
  create(body: CreateClientRequest): Promise<ClientDTO>;
  list(query?: PaginationQuery): Promise<Paginated<ClientDTO>>;
  /** Update, or suspend. */
  update(id: string, body: UpdateClientRequest): Promise<ClientDTO>;

  enableApplications(
    id: string,
    body: EnableApplicationsRequest,
  ): Promise<ClientApplicationDTO[]>;
  listApplications(id: string): Promise<ClientApplicationDTO[]>;
  /** The per-tenant on/off switch; disabling drops that app's grants (Doc 02 §7). */
  updateApplication(
    id: string,
    applicationId: string,
    body: UpdateClientApplicationRequest,
  ): Promise<ClientApplicationDTO>;

  /** The initial client-admin user and its binding, in one call. */
  createAdmin(id: string, body: CreateClientAdminRequest): Promise<ClientAdminDTO>;
}

export function clientsEndpoints(request: Requester): ClientsApi {
  const base = `${IAM_ROUTE_PREFIX}/clients`;
  const at = (id: string, suffix = '') =>
    `${base}/${encodeURIComponent(id)}${suffix}`;

  return {
    create: (body) => request({ method: 'POST', path: base, body }),
    list: (query) => request({ method: 'GET', path: base, query: { ...query } }),
    update: (id, body) => request({ method: 'PATCH', path: at(id), body }),

    enableApplications: (id, body) =>
      request({ method: 'POST', path: at(id, '/applications'), body }),
    listApplications: (id) =>
      request({ method: 'GET', path: at(id, '/applications') }),
    updateApplication: (id, applicationId, body) =>
      request({
        method: 'PATCH',
        path: at(id, `/applications/${encodeURIComponent(applicationId)}`),
        body,
      }),

    createAdmin: (id, body) =>
      request({ method: 'POST', path: at(id, '/admins'), body }),
  };
}
