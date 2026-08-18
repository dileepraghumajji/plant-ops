/**
 * `/iam/applications/*` — the platform application registry, Doc 06 §4.
 *
 * The four catalog routes and the manifest that replaces them are all here
 * because they are one screen's worth of API (Doc 09 §2): an application, its
 * permissions, its nav nodes, and the mapping between the last two.
 */

import type {
  ApplicationDTO,
  ApplicationManifest,
  CreateApplicationRequest,
  CreateNavNodesRequest,
  CreatePermissionsRequest,
  ManifestUpsertResponse,
  NavCatalogResponse,
  NavNodeCatalogDTO,
  NavPermissionsRequest,
  NavPermissionsResult,
  Paginated,
  PaginationQuery,
  PermissionDTO,
  UpdateApplicationRequest,
} from '@plantops/contracts';
import { IAM_ROUTE_PREFIX } from '@plantops/contracts';

import type { Requester } from '../http.js';

export interface ApplicationsApi {
  create(body: CreateApplicationRequest): Promise<ApplicationDTO>;
  list(query?: PaginationQuery): Promise<Paginated<ApplicationDTO>>;
  /** Update, or the global on/off switch of Doc 02 §7. */
  update(id: string, body: UpdateApplicationRequest): Promise<ApplicationDTO>;

  addPermissions(id: string, body: CreatePermissionsRequest): Promise<PermissionDTO[]>;
  listPermissions(
    id: string,
    query?: PaginationQuery,
  ): Promise<Paginated<PermissionDTO>>;

  addNavNodes(id: string, body: CreateNavNodesRequest): Promise<NavNodeCatalogDTO[]>;
  navTree(id: string): Promise<NavCatalogResponse>;
  mapNavPermissions(
    id: string,
    body: NavPermissionsRequest,
  ): Promise<NavPermissionsResult>;
  /**
   * Removes mappings. Doc 06 §4's table stops at the POST; the DELETE exists
   * because a mapping added by mistake has to be removable without a manifest
   * upload (see `registry/nav.service.ts`).
   */
  unmapNavPermissions(
    id: string,
    body: NavPermissionsRequest,
  ): Promise<NavPermissionsResult>;

  /**
   * Idempotent upsert of the whole catalog from an application's manifest
   * (Doc 02 §2). The body is the manifest document itself, unwrapped, so the
   * file on disk and the body on the wire are the same thing.
   */
  upsertManifest(
    id: string,
    manifest: ApplicationManifest,
  ): Promise<ManifestUpsertResponse>;

  /**
   * What {@link ApplicationsApi.upsertManifest} *would* do — `?dryRun=true`.
   *
   * The preview behind Doc 09 §2.1's upload screen: the same validation, the
   * same refusals and the same `ManifestDiff`, computed against the catalog as
   * it stands and applied to nothing. `dry_run` comes back `true`, and `changed`
   * answers whether confirming would do anything at all.
   *
   * A separate method rather than an options argument, because the difference
   * between the two calls is whether they write. A boolean parameter that
   * decides that reads the same at both call sites and is the wrong thing to get
   * backwards.
   */
  previewManifest(
    id: string,
    manifest: ApplicationManifest,
  ): Promise<ManifestUpsertResponse>;
}

export function applicationsEndpoints(request: Requester): ApplicationsApi {
  const base = `${IAM_ROUTE_PREFIX}/applications`;
  const at = (id: string, suffix = '') =>
    `${base}/${encodeURIComponent(id)}${suffix}`;

  return {
    create: (body) => request({ method: 'POST', path: base, body }),
    list: (query) => request({ method: 'GET', path: base, query: { ...query } }),
    update: (id, body) => request({ method: 'PATCH', path: at(id), body }),

    addPermissions: (id, body) =>
      request({ method: 'POST', path: at(id, '/permissions'), body }),
    listPermissions: (id, query) =>
      request({ method: 'GET', path: at(id, '/permissions'), query: { ...query } }),

    addNavNodes: (id, body) =>
      request({ method: 'POST', path: at(id, '/nav'), body }),
    navTree: (id) => request({ method: 'GET', path: at(id, '/nav') }),
    mapNavPermissions: (id, body) =>
      request({ method: 'POST', path: at(id, '/nav-permissions'), body }),
    unmapNavPermissions: (id, body) =>
      request({ method: 'DELETE', path: at(id, '/nav-permissions'), body }),

    upsertManifest: (id, manifest) =>
      request({ method: 'POST', path: at(id, '/manifest'), body: manifest }),
    previewManifest: (id, manifest) =>
      request({
        method: 'POST',
        path: at(id, '/manifest'),
        query: { dryRun: true },
        body: manifest,
      }),
  };
}
