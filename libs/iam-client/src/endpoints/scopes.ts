/**
 * `/iam/scopes/*` — the WHERE dimension, Doc 06 §6.
 *
 * The tree comes back whole rather than paginated: it is one tenant's org
 * structure, it is drawn as a tree, and a page of nodes is not a tree
 * (`ScopeTreeResponse`).
 */

import type {
  CreateScopeNodeRequest,
  ScopeNodeDTO,
  ScopeTreeResponse,
  UpdateScopeNodeRequest,
} from '@plantops/contracts';
import { IAM_ROUTE_PREFIX } from '@plantops/contracts';

import type { Requester } from '../http.js';

export interface ScopesApi {
  create(body: CreateScopeNodeRequest): Promise<ScopeNodeDTO>;
  tree(): Promise<ScopeTreeResponse>;
  /** Rename, or move — a move rewrites the subtree's paths and invalidates. */
  update(id: string, body: UpdateScopeNodeRequest): Promise<ScopeNodeDTO>;
  /** Refused while bindings still hang off the node (Doc 06 §6). */
  remove(id: string): Promise<void>;
}

export function scopesEndpoints(request: Requester): ScopesApi {
  const base = `${IAM_ROUTE_PREFIX}/scopes`;
  const at = (id: string) => `${base}/${encodeURIComponent(id)}`;

  return {
    create: (body) => request({ method: 'POST', path: base, body }),
    tree: () => request({ method: 'GET', path: base }),
    update: (id, body) => request({ method: 'PATCH', path: at(id), body }),
    remove: (id) => request({ method: 'DELETE', path: at(id) }),
  };
}
