/**
 * Pure functions over the **catalog** nav tree (`NavNodeCatalogDTO`, Doc 01
 * §3.3) — the platform admin's view of what exists, visible or not.
 *
 * Not to be confused with `@plantops/ui`'s `nav-tree.ts`, which reasons about
 * the *pruned* tree a subject sees (`NavNodeDTO`, Doc 05 §4). The two look
 * alike and answer opposite questions: that one asks "which menu row is
 * current for this URL", this one asks "what is in the catalog, and what is
 * mapped to it". A shared module would have to carry both shapes and would end
 * up meaning neither.
 *
 * Separated from the components so the interesting parts — flattening a tree
 * for a table, deciding what a new child's kind should be, working out which
 * mappings a save has to add and which to remove — are testable without
 * rendering antd.
 */

import type { NavNodeCatalogDTO } from '@plantops/contracts';
import { NavNodeKind } from '@plantops/contracts';

/** One catalog node with its depth, for a table that indents rather than nests. */
export interface FlatNavNode {
  node: NavNodeCatalogDTO;
  /** 0 for a top-level node. */
  depth: number;
  /** Labels of the ancestors, outermost first — for a "Modules / Access" trail. */
  ancestorLabels: string[];
}

/** Every node, depth-first in `sort_order` display order. */
export function flattenCatalog(
  tree: readonly NavNodeCatalogDTO[],
): FlatNavNode[] {
  const rows: FlatNavNode[] = [];

  const walk = (
    nodes: readonly NavNodeCatalogDTO[],
    depth: number,
    ancestorLabels: string[],
  ): void => {
    for (const node of nodes) {
      rows.push({ node, depth, ancestorLabels });
      if (node.children.length > 0) {
        walk(node.children, depth + 1, [...ancestorLabels, node.label]);
      }
    }
  };

  walk(tree, 0, []);
  return rows;
}

/** The node with this id, anywhere in the tree. */
export function findCatalogNode(
  tree: readonly NavNodeCatalogDTO[],
  id: string,
): NavNodeCatalogDTO | null {
  return flattenCatalog(tree).find((row) => row.node.id === id)?.node ?? null;
}

/**
 * What a new child of `parent` most likely is (Doc 01 §3.3's three kinds).
 *
 * A default for the add-node form, not a rule: the kinds are a depth
 * discriminator the catalog does not enforce, and an application whose module
 * hangs a `sub_menu` straight off itself is unusual rather than invalid. So the
 * form pre-selects this and lets the operator disagree.
 */
export function defaultKindUnder(
  parent: NavNodeCatalogDTO | null,
): NavNodeCatalogDTO['kind'] {
  if (parent === null) return NavNodeKind.MODULE;
  return parent.kind === NavNodeKind.MODULE
    ? NavNodeKind.MENU
    : NavNodeKind.SUB_MENU;
}

/**
 * The `sort_order` to pre-fill for a new child, so nodes added in sequence keep
 * the order they were added in rather than all landing on 0 and sorting by
 * whatever the database felt like.
 */
export function nextSortOrder(siblings: readonly NavNodeCatalogDTO[]): number {
  if (siblings.length === 0) return 0;
  return Math.max(...siblings.map((node) => node.sort_order)) + 10;
}

/** The children of `parentId`, or the top level when it is `null`. */
export function siblingsOf(
  tree: readonly NavNodeCatalogDTO[],
  parentId: string | null,
): NavNodeCatalogDTO[] {
  if (parentId === null) return [...tree];
  return findCatalogNode(tree, parentId)?.children ?? [];
}

/** What a mapping save has to send in each direction (Doc 02 §2 step 4). */
export interface MappingChange {
  /** Permission keys to add — the `POST /…/nav-permissions` body. */
  map: string[];
  /** Permission keys to remove — the `DELETE` body. */
  unmap: string[];
}

/**
 * The difference between what a node requires now and what the operator chose.
 *
 * Both endpoints are idempotent, so sending the whole selection every time
 * would also work. It is diffed anyway for two reasons: an unmap is not
 * expressible as a map, so the removals genuinely have to be computed; and both
 * calls audit only what actually changed (`nav.service.ts`), so sending
 * no-op pairs would be asking the server to decide something the screen already
 * knows.
 */
export function mappingChange(
  current: readonly string[],
  selected: readonly string[],
): MappingChange {
  const before = new Set(current);
  const after = new Set(selected);
  return {
    map: [...after].filter((key) => !before.has(key)).sort(),
    unmap: [...before].filter((key) => !after.has(key)).sort(),
  };
}

/** True when a save would change nothing — the button stays disabled. */
export function isNoOpChange(change: MappingChange): boolean {
  return change.map.length === 0 && change.unmap.length === 0;
}

/**
 * Whether a node is reachable at all, in the terms Doc 05 §3 uses.
 *
 * A container's visibility is derived from its descendants, so the only nodes
 * this answers for are leaves: one with no mapped permission is hidden from
 * everyone unless it opted in with `is_public`. That is the single most
 * confusing thing about the catalog — a menu built correctly and mapped to
 * nothing is invisible to its own author — so the mapping screen says it per
 * row instead of leaving it to be discovered.
 */
export type NavReachability = 'gated' | 'public' | 'unreachable' | 'container';

export function reachabilityOf(node: NavNodeCatalogDTO): NavReachability {
  if (node.children.length > 0) return 'container';
  if (node.requires.length > 0) return 'gated';
  return node.is_public ? 'public' : 'unreachable';
}
