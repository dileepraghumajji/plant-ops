/**
 * `GET /iam/navigation` — the menu, Doc 06 §11 and Doc 05.
 *
 * A pure function of the bearer's grants and the nav catalog: containers with
 * no visible descendant are pruned, unmapped nodes are hidden unless they opt
 * in with `is_public`, and disabled applications never appear. Called with no
 * `applicationId` it returns the cross-application shell — one top-level node
 * per enabled app.
 *
 * Not cached here. The menu changes when the catalog changes as well as when
 * grants change, and it is fetched once per shell load rather than once per
 * request, so there is no burst for a cache to absorb — only staleness to
 * introduce.
 */

import type { NavigationResponse } from '@plantops/contracts';
import { IAM_ROUTE_PREFIX } from '@plantops/contracts';

import type { Requester } from '../http.js';

/** Doc 05 §5's optional narrowing to one application's menu. */
export interface NavigationQuery {
  applicationId?: string;
}

export interface NavigationApi {
  tree(query?: NavigationQuery): Promise<NavigationResponse>;
}

export function navigationEndpoints(request: Requester): NavigationApi {
  return {
    tree: (query) =>
      request({
        method: 'GET',
        path: `${IAM_ROUTE_PREFIX}/navigation`,
        query: { ...query },
      }),
  };
}
