/**
 * Pure functions over the `ScopeNodeDTO` tree `GET /iam/scopes` returns — the
 * WHERE dimension of every grant (Doc 01 §3.5, Doc 06 §6).
 *
 * In `@plantops/ui` rather than in a console because two screens need the same
 * tree for opposite purposes and must not disagree about it: Session 31's editor
 * *builds* the structure, and Session 35's access screen *points at* a node in
 * it. A second copy would be two answers to "what may I select", which is the
 * one question a grant screen has to get right.
 *
 * Nothing here knows an endpoint. It takes the tree the server sent and returns
 * shapes antd's `Tree` and `TreeSelect` accept, which is the whole of what the
 * two screens share.
 *
 * ## `path` is read for exactly one thing
 *
 * Coverage is subtree containment: a grant at a node covers every descendant
 * (Doc 04 §4), and `path` is how that is expressed. `descendantIds` uses it to
 * answer "which nodes are beneath this one" without a recursive walk, because a
 * move picker has to grey out the moving node's own subtree — moving a node
 * under its own descendant would orphan the subtree from its tree, which the
 * server refuses with a 409 the operator should never have been able to reach.
 *
 * Nothing here parses the labels. They are `n_` + a node's UUID hex and never a
 * display name (Doc 01 §3.5); a consumer that read meaning out of them would be
 * doing the resolver's job badly.
 */

import type { ScopeNodeDTO, ScopeNodeKind } from '@plantops/contracts';

/** What each kind is called in a console. Doc 01 §3.5's four, in tree order. */
export const SCOPE_KIND_LABEL: Readonly<Record<ScopeNodeKind, string>> = {
  group: 'Group',
  plant: 'Plant',
  department: 'Department',
  gate: 'Gate',
};

/**
 * The order the four kinds normally nest in — Group → Plant → Department → Gate.
 *
 * A default for the add-child form, not a rule. Doc 01 §3.5 does not pin a kind
 * to a depth, and an organisation with a department directly under a group is
 * modelling itself honestly rather than incorrectly; the API accepts it. So this
 * pre-selects the likely answer and lets the operator disagree — the same
 * arrangement `defaultKindUnder` makes for nav nodes.
 */
export const SCOPE_KIND_ORDER: readonly ScopeNodeKind[] = [
  'group',
  'plant',
  'department',
  'gate',
];

/** The kind a new child of `parent` most likely is. */
export function defaultChildKind(parent: ScopeNodeDTO | null): ScopeNodeKind {
  if (parent === null) return 'group';
  const next = SCOPE_KIND_ORDER.indexOf(parent.kind) + 1;
  return SCOPE_KIND_ORDER[next] ?? 'gate';
}

/** One node with its depth in the rendered tree and the trail above it. */
export interface FlatScopeNode {
  node: ScopeNodeDTO;
  /** 0 for a root. Counted in the tree, not read from `depth`. */
  level: number;
  /** Names of the ancestors, outermost first — a "Acme / Plant B" trail. */
  ancestorNames: string[];
}

/** Every node, depth-first in display order. */
export function flattenScopeTree(
  tree: readonly ScopeNodeDTO[],
): FlatScopeNode[] {
  const rows: FlatScopeNode[] = [];

  const walk = (
    nodes: readonly ScopeNodeDTO[],
    level: number,
    ancestorNames: string[],
  ): void => {
    for (const node of nodes) {
      rows.push({ node, level, ancestorNames });
      if (node.children.length > 0) {
        walk(node.children, level + 1, [...ancestorNames, node.name]);
      }
    }
  };

  walk(tree, 0, []);
  return rows;
}

/** The node with this id, anywhere in the tree. */
export function findScopeNode(
  tree: readonly ScopeNodeDTO[],
  id: string,
): ScopeNodeDTO | null {
  return flattenScopeTree(tree).find((row) => row.node.id === id)?.node ?? null;
}

/**
 * The ids of `node` and everything beneath it.
 *
 * Includes the node itself, because every caller so far wants "the subtree I
 * must not touch" rather than "the subtree minus its own root" — a move picker
 * has to exclude the node as well as its descendants, since a node cannot be its
 * own parent either.
 *
 * Matched on `path` rather than walked, so it is correct for a node handed in
 * without its `children` populated.
 */
export function descendantIds(
  tree: readonly ScopeNodeDTO[],
  node: ScopeNodeDTO,
): Set<string> {
  const prefix = `${node.path}.`;
  const ids = new Set<string>([node.id]);
  for (const row of flattenScopeTree(tree)) {
    if (row.node.path.startsWith(prefix)) ids.add(row.node.id);
  }
  return ids;
}

/** One antd tree node — the shape `Tree` and `TreeSelect` both consume. */
export interface ScopeTreeDataNode {
  key: string;
  value: string;
  title: string;
  /** The node this row stands for, so a renderer need not look it up again. */
  node: ScopeNodeDTO;
  disabled: boolean;
  /** True when the row is only there to be expanded through. */
  selectable: boolean;
  children: ScopeTreeDataNode[];
}

export interface ScopeTreeDataOptions {
  /**
   * Rows the operator may not choose — greyed out but still expandable, because
   * the node they *can* choose may be underneath one they cannot.
   */
  isDisabled?: (node: ScopeNodeDTO) => boolean;
}

/**
 * The tree, as antd's `treeData`.
 *
 * `key` and `value` are both the node id: `Tree` reads the first and
 * `TreeSelect` the second, and giving them the same value is what lets one
 * function feed both.
 */
export function scopeTreeData(
  tree: readonly ScopeNodeDTO[],
  options: ScopeTreeDataOptions = {},
): ScopeTreeDataNode[] {
  const { isDisabled } = options;

  const build = (node: ScopeNodeDTO): ScopeTreeDataNode => {
    const disabled = isDisabled?.(node) ?? false;
    return {
      key: node.id,
      value: node.id,
      title: node.name,
      node,
      disabled,
      selectable: !disabled,
      children: node.children.map(build),
    };
  };

  return tree.map(build);
}

/** Every node id in the tree — what an "expand all" needs. */
export function allScopeNodeIds(tree: readonly ScopeNodeDTO[]): string[] {
  return flattenScopeTree(tree).map((row) => row.node.id);
}

/** How many nodes the tree holds, and how deep it goes. */
export function scopeTreeSize(tree: readonly ScopeNodeDTO[]): {
  nodes: number;
  depth: number;
} {
  const rows = flattenScopeTree(tree);
  return {
    nodes: rows.length,
    depth: rows.reduce((deepest, row) => Math.max(deepest, row.level + 1), 0),
  };
}
