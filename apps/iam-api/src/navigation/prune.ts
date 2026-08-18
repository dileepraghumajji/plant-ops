/**
 * The pruning algorithm — Doc 05 §5, as a pure function.
 *
 * ## Why it is not a method on the service
 *
 * Doc 05 §1 calls the dynamic menu "the visible proof that the registry is
 * working", and the thing being proved is *this function*: a menu is a pure
 * function of a catalog and a grant set, and nothing else. Everything the
 * service does around it — enablement, the cache, the resolve — is plumbing that
 * a test can only reach through a database. The rule itself is decided here,
 * over plain values, and `prune.spec.ts` is the matrix.
 *
 * That is the same split `grants.util.ts` makes against `resolver.service.ts`
 * and `manifest-diff.ts` makes against `manifest.service.ts`, for the same
 * reason.
 *
 * ## Visibility is permission-based, never scope-based
 *
 * The parameter is a `Set` of held permission **keys**, and there is nowhere to
 * pass a scope path. Doc 05 §3's closing note is emphatic about it: "a guard who
 * has `visitor.checkin` at any gate sees the Visitor menu; the screen then shows
 * only their gate's data". Scope filters rows inside a screen (Doc 04 §5's
 * `allowedPaths`), not whether the screen is reachable — and threading a path in
 * here is how that separation would quietly be lost.
 *
 * ## Three decisions the pseudocode makes that are worth spelling out
 *
 * 1. **"Has children" decides container-vs-leaf, before any gate is read.** So a
 *    node with both a route and children is a container: its own mapping is
 *    never consulted, and it survives exactly as long as one descendant does.
 *    Doc 05 §3 assumes the two are disjoint ("a menu/sub-menu with a route"
 *    versus "a module/menu with children, no route"); §5's `if node has
 *    children` is what settles the shape the schema permits but the prose does
 *    not describe.
 * 2. **A container with no visible descendant is pruned even if it has a route
 *    and a satisfied gate.** Same clause, read the other way. An empty container
 *    is a dead end, and Doc 05 §3 rule 2 removes it without exception.
 * 3. **An unmapped leaf is hidden unless it says `is_public`.** Invariant I3,
 *    deny-by-default, and Doc 05 §3 rule 1 records that this *inverts* an earlier
 *    "unmapped = public" rule it calls "a silent-access footgun". `is_public`
 *    only ever rescues a leaf with **no** mapping at all — a leaf that is mapped
 *    and unheld stays hidden, because the mapping is the operator's statement
 *    that the item is gated.
 *
 * ## An orphan is dropped, not promoted
 *
 * {@link NavCatalog.nodes} contains only `is_active` rows (Doc 05 §3 rule 4), so
 * a node whose parent was deactivated has a `parent_id` that matches nothing.
 * Only nodes reachable from a real root — `parent_id === null` — are walked, so
 * such a subtree disappears with its parent.
 *
 * This is the deliberate opposite of `registry/nav.service.ts`'s `assemble()`,
 * which promotes an unparented node to a root rather than lose it. That function
 * builds the platform admin's *whole* catalog, where every row is present and an
 * orphan could only mean corruption; here an orphan is the ordinary consequence
 * of retiring a module, and promoting its menus to the top of the sidebar would
 * reveal precisely what the operator switched off.
 *
 * It also makes the walk total: a `parent_id` cycle is unreachable from any root,
 * so it is skipped rather than recursed into forever.
 */

import type { NavNodeDTO, NavNodeKind, PermissionKey } from '@plantops/contracts';

/**
 * One `nav_node` row, as pruning needs it.
 *
 * No `sort_order` and no `is_active`: both have been applied by the time a
 * catalog exists. Inactive rows are absent, and the ordering *is* the order of
 * {@link NavCatalog.nodes} — carrying the column as well would invite a second,
 * disagreeing sort.
 */
export interface NavCatalogNode {
  id: string;
  parent_id: string | null;
  kind: NavNodeKind;
  key: string;
  label: string;
  route: string | null;
  icon: string | null;
  /** The explicit opt-in of Doc 05 §3 rule 1. Only read for an unmapped leaf. */
  is_public: boolean;
}

/**
 * One application's active nav catalog — the subject-independent half of the
 * answer.
 *
 * Everything here belongs to the platform rather than to a tenant
 * (`nav_node` and `menu_permission` are catalog tables, migrations 0008–0009), so
 * a catalog is the same for every caller and is what
 * `nav-catalog-cache.service.ts` is able to cache globally.
 */
export interface NavCatalog {
  /**
   * Every active node of the application, ordered by `(sort_order, key)`.
   *
   * The array order is Doc 05 §3 rule 4's ordering: children are appended in the
   * order they appear here, so every sibling list comes out sorted without this
   * function sorting anything.
   */
  nodes: readonly NavCatalogNode[];
  /**
   * nav node id → the permission keys `menu_permission` maps to it (Doc 01 §4.4).
   *
   * A node with no mapping is simply absent, which is the "req empty" of Doc 05
   * §5 rather than a distinct state.
   */
  gates: Readonly<Record<string, readonly string[]>>;
}

/** Children by parent id; the root list is under `null`. */
type ChildIndex = ReadonlyMap<string | null, readonly NavCatalogNode[]>;

/**
 * The subject's visible tree — Doc 05 §5's `navigation(...)`, minus the lookups.
 *
 * @param held the permission keys the subject holds, from their resolved grants
 * (Doc 04 §4.1). A `Set` because a leaf's gate list is tested against it once
 * per node and a catalog has more nodes than a subject has permissions.
 */
export function pruneNavTree(
  catalog: NavCatalog,
  held: ReadonlySet<PermissionKey>,
): NavNodeDTO[] {
  const children = new Map<string | null, NavCatalogNode[]>();
  for (const node of catalog.nodes) {
    const siblings = children.get(node.parent_id);
    if (siblings === undefined) children.set(node.parent_id, [node]);
    else siblings.push(node);
  }

  return visibleAmong(null, children, catalog.gates, held);
}

/** The visible members of one sibling list, in catalog order. */
function visibleAmong(
  parentId: string | null,
  children: ChildIndex,
  gates: NavCatalog['gates'],
  held: ReadonlySet<PermissionKey>,
): NavNodeDTO[] {
  const visible: NavNodeDTO[] = [];
  for (const node of children.get(parentId) ?? []) {
    const kept = visibleNode(node, children, gates, held);
    if (kept !== null) visible.push(kept);
  }
  return visible;
}

/**
 * One node, or `null` for Doc 05 §5's `PRUNE`.
 *
 * The order of the two branches is the specification's, and the container branch
 * comes first — see this file's header, decision 1.
 */
function visibleNode(
  node: NavCatalogNode,
  children: ChildIndex,
  gates: NavCatalog['gates'],
  held: ReadonlySet<PermissionKey>,
): NavNodeDTO | null {
  // An entry exists only because something was pushed into it, so a present
  // entry is a non-empty one: "has children" is exactly "has an entry".
  if (children.has(node.id)) {
    const visibleChildren = visibleAmong(node.id, children, gates, held);
    return visibleChildren.length === 0 ? null : toDto(node, visibleChildren);
  }

  const required = gates[node.id] ?? [];

  // OR semantics (Doc 05 §3 rule 1): one held key of many is enough.
  if (required.some((permission) => held.has(permission))) return toDto(node, []);

  // The explicit public opt-in, and only for a leaf nobody gated.
  if (required.length === 0 && node.is_public) return toDto(node, []);

  return null;
}

/**
 * A visible node, in the shape the frontend renders (Doc 05 §4, §7).
 *
 * `requires`, `is_public`, `is_active`, `sort_order` and `application_id` are all
 * absent, unlike `NavNodeCatalogDTO`: this is the answer to "what may I see",
 * and a client that received the gates would be able to enumerate the
 * permissions it does *not* hold from the items it cannot see.
 */
function toDto(node: NavCatalogNode, children: NavNodeDTO[]): NavNodeDTO {
  return {
    id: node.id,
    kind: node.kind,
    key: node.key,
    label: node.label,
    route: node.route,
    icon: node.icon,
    children,
  };
}
