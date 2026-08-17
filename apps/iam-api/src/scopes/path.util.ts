/**
 * ltree path arithmetic for the scope tree (Doc 01 §3.5, Doc 07 §7).
 *
 * ## Why any of this is in TypeScript
 *
 * The paths that *change* are computed by Postgres: a move rewrites a whole
 * subtree in one `subpath`-based statement, and that statement is the only thing
 * that could ever be correct under concurrency (Doc 04 §7.1). What is left for
 * this file is the small, decidable part — the path of a node being inserted,
 * the depth of a tree, and whether one path lies under another — plus the one
 * function that exists purely to be *checked against* the database:
 * {@link rewritePrefix}, the JS mirror of that statement, which lets a test
 * state the expected shape of a moved subtree independently of the SQL that
 * produced it.
 *
 * ## The rule everything here rests on
 *
 * A label is `n_` + the node's UUID with hyphens removed —
 * {@link scopePathLabel}, defined once in `@plantops/db` and independently
 * enforced by migration 0003's check constraint. Never a display name:
 * ltree labels are `[A-Za-z0-9_]` only, so `"Plant B"` would be rejected and
 * `"Gate-3"` silently mangled — and, far worse, a rename would then rewrite the
 * path and invalidate every grant beneath it. No function in this file accepts a
 * name, which is what makes that impossible rather than merely discouraged.
 */

import { pathIsWithin } from '@plantops/auth-kit';
import { MAX_SCOPE_TREE_DEPTH } from '@plantops/contracts';
import { scopePathLabel } from '@plantops/db';

/** The ltree label separator. Spelled once. */
const SEPARATOR = '.';

/**
 * The path of a root node: its own label, alone.
 *
 * Migration 0003 pins both ends of this — `scope_node_root_is_depth_one` makes
 * `parent_id is null` and `nlevel(path) = 1` the same statement — so a root
 * built any other way is refused by the database.
 */
export function rootPath(id: string): string {
  return scopePathLabel(id);
}

/** The path of `id` inserted under `parentPath`. */
export function childPath(parentPath: string, id: string): string {
  return `${parentPath}${SEPARATOR}${scopePathLabel(id)}`;
}

/** `nlevel(path)` — labels in the path. 1 for a root. */
export function pathDepth(path: string): number {
  return path.split(SEPARATOR).length;
}

/**
 * `path <@ prefix` — is `path` the prefix itself or a descendant of it?
 *
 * Label-wise, not character-wise: a plain `startsWith` would report
 * `n_ab.n_cd` as living under `n_a`, which is the class of bug that makes a
 * coverage test grant access to a sibling subtree.
 *
 * Re-exported from `@plantops/auth-kit` rather than written here, because this
 * is the same predicate `PermissionGuard` runs and every future module runs
 * (Doc 08 §4). Two definitions of "beneath" would only be found to disagree by
 * a subject reaching a gate they were never granted — so there is one, in the
 * library both sides share, and this name stays because the tree arithmetic
 * around it reads better with it.
 */
export const isWithin = pathIsWithin;

/**
 * What `path` becomes when the subtree rooted at `oldPrefix` is re-hung under
 * `newParentPath` — the JS statement of the SQL a move runs.
 *
 * The moved node keeps its own label and gains a new ancestry; every descendant
 * keeps the tail below that label. Written from `newParentPath` rather than from
 * a finished new prefix so it composes exactly as the statement does:
 * `newParentPath || subpath(path, nlevel(oldPrefix) - 1)`.
 *
 * @throws when `path` is not within `oldPrefix` — the caller has already made a
 * mistake about which rows the move covers, and returning a plausible-looking
 * path would hide it.
 */
export function rewritePrefix(
  path: string,
  oldPrefix: string,
  newParentPath: string,
): string {
  if (!isWithin(path, oldPrefix)) {
    throw new Error(`"${path}" is not within "${oldPrefix}"`);
  }
  const tail = path.split(SEPARATOR).slice(pathDepth(oldPrefix) - 1);
  return [newParentPath, ...tail].join(SEPARATOR);
}

/**
 * How deep the tree would become if a subtree of height `subtreeHeight` hung
 * under a parent at `parentDepth`.
 *
 * `subtreeHeight` is 1 for a leaf — the count of levels the subtree occupies,
 * so a plant with departments under it is 2.
 */
export function depthAfterMove(parentDepth: number, subtreeHeight: number): number {
  return parentDepth + subtreeHeight;
}

/** Is `depth` within {@link MAX_SCOPE_TREE_DEPTH}? */
export function isDepthAllowed(depth: number): boolean {
  return depth <= MAX_SCOPE_TREE_DEPTH;
}
