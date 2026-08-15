/**
 * Scope-tree contract — the WHERE of the access equation (Doc 01 §3.5,
 * Doc 06 §6).
 *
 * A client's `scope_node` tree is the org structure a grant is anchored to:
 * Group → Plant → Department → Gate. A role bound at a plant covers every
 * department and gate beneath it, and that coverage is a prefix test on
 * {@link ScopeNodeDTO.path} rather than a recursive walk (Doc 07 §7).
 *
 * ## Why `path` is published at all
 *
 * It is an implementation detail of coverage, and a consumer that tried to
 * *parse* it would be doing the resolver's job badly. It is on the wire because
 * the properties the labels guarantee are worth being able to check: the labels
 * are `n_` + the node's UUID hex and never the display `name` (Doc 01 §3.5), so
 * a rename cannot rewrite a path — and therefore cannot invalidate every grant
 * beneath it. A UI that shows an operator *why* a move is more disruptive than a
 * rename needs the value; nothing else should read it.
 *
 * Field naming is snake_case, matching every other published shape here.
 */

/**
 * Node kinds, in the order migration 0001 declares the Postgres enum's labels.
 *
 * "Extensible" per Doc 01 §3.5 — a new kind is a migration, not a schema
 * change, because the tree's *shape* is not constrained by kind: nothing stops a
 * gate under a group, and nothing should, since tenants organise themselves
 * differently. The kind is what a UI renders an icon from and what an operator
 * reasons about; coverage is decided by the path alone.
 */
export const ScopeNodeKind = {
  GROUP: 'group',
  PLANT: 'plant',
  DEPARTMENT: 'department',
  GATE: 'gate',
} as const;
export type ScopeNodeKind = (typeof ScopeNodeKind)[keyof typeof ScopeNodeKind];

/**
 * The four kinds as a list — the array form a request schema builds a closed
 * enum from, for the reason {@link NAV_NODE_KIND_VALUES} exists.
 */
export const SCOPE_NODE_KIND_VALUES = [
  ScopeNodeKind.GROUP,
  ScopeNodeKind.PLANT,
  ScopeNodeKind.DEPARTMENT,
  ScopeNodeKind.GATE,
] as const satisfies readonly ScopeNodeKind[];

/**
 * How deep a scope tree may go, root included.
 *
 * Not a database constraint and not a spec requirement — Doc 01 §3.5 bounds
 * nothing. It is here because `path` is a materialized column on every
 * descendant and every label costs 34 characters: an unbounded tree is an
 * unbounded write amplification on a move and an unbounded GiST index entry. A
 * limit of 32 is eight times the deepest structure the spec describes
 * (Group → Plant → Department → Gate), so it bounds the pathological case
 * without being reachable by an organisation that is modelling itself honestly.
 */
export const MAX_SCOPE_TREE_DEPTH = 32;

/**
 * One node of a client's org tree, with its subtree inline.
 *
 * `children` is always present — empty on a leaf — so a consumer walking the
 * tree needs no null check at the bottom of it. Same shape as
 * {@link NavNodeCatalogDTO}, for the same reason.
 */
export interface ScopeNodeDTO {
  id: string;
  client_id: string;
  /** `null` on a root. A client normally has exactly one (Doc 02 §3 step 3). */
  parent_id: string | null;
  kind: ScopeNodeKind;
  /** Display only. Never appears in {@link ScopeNodeDTO.path}. */
  name: string;
  /**
   * The materialized ltree path, e.g. `n_9f2c….n_4a1b…`. Every label is
   * `n_` + a node id's UUID hex (Doc 01 §3.5) — a display name never reaches it.
   */
  path: string;
  /** Labels in {@link ScopeNodeDTO.path}: 1 for a root. `nlevel(path)`. */
  depth: number;
  /** Free-form per-node data (Doc 01 §3.5). Opaque to the IAM. */
  metadata: Record<string, unknown>;
  /** ISO-8601. */
  created_at: string;
  updated_at: string;
  children: ScopeNodeDTO[];
}

/** `GET /iam/scopes` → the caller's whole tree (Doc 06 §6). */
export interface ScopeTreeResponse {
  /** The caller's tenant, from the token — never from a query parameter. */
  client_id: string;
  /** Roots, ordered by name. Normally one. */
  tree: ScopeNodeDTO[];
}

/**
 * `POST /iam/scopes` body (Doc 06 §6).
 *
 * `parent_id` is optional only in the case where the tenant has no tree at all:
 * a client's root is normally created with its first administrator (Doc 02 §3
 * step 3), and omitting the parent when a root already exists is a 409 rather
 * than a second root. A tree with two roots would make "everything this admin
 * covers" a question with two answers.
 */
export interface CreateScopeNodeRequest {
  parent_id?: string;
  kind: ScopeNodeKind;
  name: string;
  metadata?: Record<string, unknown>;
}

/**
 * `PATCH /iam/scopes/:id` body — rename and/or move (Doc 06 §6).
 *
 * The two are one endpoint because they are one row's edit, but they are not
 * remotely the same operation:
 *
 * - **`name`** touches one column. `path` is untouched, so no grant, no cached
 *   resolution and no coverage test is affected (Doc 01 §3.5).
 * - **`parent_id`** rewrites the `path` of the node *and its entire subtree*,
 *   which changes what every binding beneath it covers. Doc 04 §7.1 calls this
 *   the highest-risk concurrency case in the system and prescribes its ordering
 *   exactly: capture affected subjects → rewrite in one statement at
 *   `REPEATABLE READ` → commit → only then publish the invalidation.
 *
 * `parent_id` cannot be set to `null`: a node is never detached into a second
 * root, for the reason {@link CreateScopeNodeRequest} gives. Nor may it name the
 * node itself or anything beneath it — that is a cycle, and it would orphan the
 * whole subtree from its own tree.
 *
 * `kind` and `metadata` are both absent, for the same reason from two
 * directions. Doc 06 §6 defines this endpoint as "rename / move", and Doc 10 §4's
 * catalog gives the scope tree exactly four actions —
 * `created`/`moved`/`renamed`/`deleted`. An edit to either field would be a
 * mutation with no honest action to record it under, and recording it as a
 * rename would make the action filter that finds real renames useless. Both are
 * set at creation; changing what a node *is* means creating the right node and
 * moving what belongs under it.
 */
export interface UpdateScopeNodeRequest {
  name?: string;
  parent_id?: string;
}
