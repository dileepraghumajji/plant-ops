/**
 * Pure functions over the `NavNodeDTO` tree `GET /iam/navigation` returns.
 *
 * Separated from `nav-menu.tsx` so the interesting logic — which menu row is
 * "current" for a given URL — is testable without rendering antd, and reusable
 * by anything else that needs to reason about the menu: a breadcrumb, a
 * command palette, a redirect that has to land somewhere the user can actually
 * see.
 *
 * Nothing here knows a route literal. Every answer is derived from the tree the
 * server sent (Doc 05 §7: the console "renders the returned tree directly — it
 * does not maintain its own menu constants"), which is what lets a platform
 * admin add a menu tonight and have it highlight correctly tomorrow with no
 * deploy.
 */

import type { NavNodeDTO } from '@plantops/contracts';

/** One routable node, with the path of container ids that leads to it. */
export interface NavRouteEntry {
  node: NavNodeDTO;
  route: string;
  /** Ids of the ancestors, outermost first — the sub-menus to open. */
  ancestorIds: string[];
}

/**
 * Every routable node in the tree, depth-first in display order.
 *
 * Containers are skipped: Doc 05 §3 calls a node with children a container and
 * gives it no route, and a menu whose parent is clickable would make "open the
 * sub-menu" and "go somewhere" the same gesture.
 */
export function flattenNavRoutes(tree: readonly NavNodeDTO[]): NavRouteEntry[] {
  const entries: NavRouteEntry[] = [];

  const walk = (nodes: readonly NavNodeDTO[], ancestorIds: string[]): void => {
    for (const node of nodes) {
      const route = typeof node.route === 'string' ? node.route.trim() : '';
      if (route !== '') {
        entries.push({ node, route, ancestorIds });
      }
      if (node.children.length > 0) {
        walk(node.children, [...ancestorIds, node.id]);
      }
    }
  };

  walk(tree, []);
  return entries;
}

/**
 * Where to send a user who has arrived at the application root.
 *
 * The first routable node in menu order, which for a pruned tree is the first
 * screen this particular subject may see — so a platform admin and a gate
 * supervisor land in different places from the same `/` without either being
 * hardcoded. `null` when the subject's menu is empty, which the caller must
 * handle: a subject with no grants exists (Doc 05 §3) and needs an explanation,
 * not a redirect loop.
 */
export function firstNavRoute(tree: readonly NavNodeDTO[]): string | null {
  return flattenNavRoutes(tree)[0]?.route ?? null;
}

/**
 * The node a URL belongs to: the longest route that prefixes it.
 *
 * Prefix rather than equality because a detail screen is not in the menu.
 * `/admin/users/8f2c…` has to light up *Users*, and it does so by matching
 * `/admin/users`. The "longest" part is what keeps `/admin/users/by-role` — a
 * menu row in its own right — from being swallowed by its shorter sibling.
 *
 * The `/` boundary is required: without it `/admin/users-archive` would match
 * `/admin/users`, and the wrong row would highlight on a screen the menu does
 * not contain.
 */
export function findNavRouteForPath(
  tree: readonly NavNodeDTO[],
  pathname: string,
): NavRouteEntry | null {
  const path = normalizePath(pathname);
  let best: NavRouteEntry | null = null;

  for (const entry of flattenNavRoutes(tree)) {
    const route = normalizePath(entry.route);
    const matches = path === route || path.startsWith(`${route}/`);
    if (matches && (best === null || route.length > normalizePath(best.route).length)) {
      best = entry;
    }
  }

  return best;
}

/** What antd's `Menu` needs to render the current location. */
export interface NavSelection {
  /** Ids of selected rows — at most one, but antd takes an array. */
  selectedKeys: string[];
  /** Ids of the sub-menus that must be open for the selection to be visible. */
  openKeys: string[];
}

/** {@link findNavRouteForPath}, in the shape antd's `Menu` consumes. */
export function navSelectionForPath(
  tree: readonly NavNodeDTO[],
  pathname: string,
): NavSelection {
  const match = findNavRouteForPath(tree, pathname);
  if (match === null) return { selectedKeys: [], openKeys: [] };
  return { selectedKeys: [match.node.id], openKeys: match.ancestorIds };
}

/** Ids of every container node — the full set of expandable sub-menus. */
export function navContainerIds(tree: readonly NavNodeDTO[]): string[] {
  const ids: string[] = [];
  const walk = (nodes: readonly NavNodeDTO[]): void => {
    for (const node of nodes) {
      if (node.children.length > 0) {
        ids.push(node.id);
        walk(node.children);
      }
    }
  };
  walk(tree);
  return ids;
}

/** Trailing slashes off, empty becomes `/`. Comparisons need one spelling. */
function normalizePath(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, '');
  return trimmed === '' ? '/' : trimmed;
}
