/**
 * The resolution algorithm itself, as pure functions (Doc 04 §4).
 *
 * Everything in this file is a statement about *sets of paths*, with no
 * database, no cache and no request in it. That separation is the reason it
 * exists: Doc 04 §4's minimization rule and §4.2's point check are the part of
 * the system with the largest correctness surface and the smallest amount of
 * I/O, and testing them through a query would mean seeding a tree for every
 * case that is really about three strings.
 *
 * ## Coverage is `isWithin`, and it is imported rather than restated
 *
 * `covers(N_b, N_t) ⇔ N_t.path <@ N_b.path` (Doc 04 §3) is `scopes/path.util.ts`'s
 * {@link isWithin} — the same label-wise prefix test the scope tree already
 * uses, and the same one migration 0006's ltree operators run in SQL. A local
 * copy here would be a second definition of what "beneath" means, and the two
 * would only be found to disagree by a subject reaching a gate they were never
 * granted. The import direction is safe: `path.util.ts` is plain functions with
 * no Nest wiring, so nothing about module graphs is implied by it.
 *
 * ## Why minimization is required rather than an optimisation
 *
 * Doc 04 §4.1 marks it **required**, and the reason is not payload size. Binding
 * the same subject and role at an ancestor *and* a descendant is legal by
 * design (Doc 01 §4.5, and `bindings.service.ts` refuses to treat it as a
 * duplicate), so the raw grant set routinely contains redundant paths. Left in,
 * they make `scopes[key]` grow with the tree rather than with the grant, make
 * the point check scan paths that cannot change its answer, and — the part that
 * actually bites — make two subjects with identical *effective* access produce
 * different cache entries, so nothing downstream can compare them.
 *
 * Minimization never changes what is covered: dropping a path that an ancestor
 * in the same set already covers is, by the definition above, a no-op on the
 * coverage relation. {@link minimizePaths} is the proof obligation and
 * `grants.util.spec.ts` is where it is discharged.
 */

import type { PermissionKey, ResolvedGrants, ScopePath } from '@plantops/contracts';
import { isWithin } from '../scopes/path.util';

/**
 * One `(permission, covering path)` pair, as the resolve query returns them.
 *
 * The query joins bindings to their role's permissions and to the bound node,
 * so a subject with two bindings that share a permission produces two rows for
 * it — which is exactly the input minimization is defined over.
 */
export interface GrantRow {
  permission_key: PermissionKey;
  scope_path: ScopePath;
}

/**
 * The minimal covering set of `paths`: every path that no *other* path in the
 * set properly contains (Doc 04 §4.1).
 *
 * Deduplicated first, so an exact repeat cannot eliminate itself — `isWithin`
 * is reflexive, and a rule phrased as "drop anything another path covers" would
 * otherwise remove both copies of an identical pair and leave the permission
 * with no path at all. That is the one bug this function is most likely to
 * have, and the duplicate case is the first thing its spec asserts.
 *
 * Sorted, so the result is a value rather than an ordering accident: it is
 * serialized into a cache entry that is compared against the authoritative
 * version on every read, and two resolutions of the same grants must produce
 * identical bytes.
 */
export function minimizePaths(paths: Iterable<ScopePath>): ScopePath[] {
  const distinct = [...new Set(paths)];

  return distinct
    .filter((candidate) =>
      distinct.every((other) => other === candidate || !isWithin(candidate, other)),
    )
    .sort();
}

/**
 * Grant rows → the subject's complete grant set (Doc 04 §4.1).
 *
 * `permissions` is derived from the same map rather than collected separately,
 * so the flat list and the keys of `scopes` cannot disagree — a permission that
 * appears in one and not the other would make the two halves of the point check
 * contradict each other.
 *
 * An empty input is the deny-by-default answer (Doc 04 §9): no bindings, no
 * grants, and no special case for it anywhere downstream.
 */
export function assembleGrants(rows: readonly GrantRow[]): ResolvedGrants {
  const byPermission = new Map<PermissionKey, ScopePath[]>();

  for (const row of rows) {
    const paths = byPermission.get(row.permission_key);
    if (paths === undefined) byPermission.set(row.permission_key, [row.scope_path]);
    else paths.push(row.scope_path);
  }

  const scopes: Record<PermissionKey, ScopePath[]> = {};
  for (const key of [...byPermission.keys()].sort()) {
    scopes[key] = minimizePaths(byPermission.get(key) as ScopePath[]);
  }

  return { permissions: Object.keys(scopes), scopes };
}

/**
 * `can(subject, permissionKey, targetPath)` — Doc 04 §4.2's point check.
 *
 * Two questions in the order the spec asks them, and the order carries the
 * deny-by-default asymmetry of §9: the permission dimension is tested by exact
 * membership (holding `dc.approve` says nothing about `dc.create`), and only the
 * scope dimension inherits (an ancestor covers its subtree). Reversing them, or
 * merging them into one pass over `scopes`, would still return the right
 * booleans — but the asymmetry would stop being visible in the code that
 * implements it, which is how it gets "simplified" away later.
 *
 * O(covering paths for that permission), which minimization keeps small.
 */
export function grantsCover(
  grants: ResolvedGrants,
  permission: PermissionKey,
  targetPath: ScopePath,
): boolean {
  if (!grants.permissions.includes(permission)) return false;

  const covering = grants.scopes[permission];
  return covering !== undefined && covering.some((path) => isWithin(targetPath, path));
}

/**
 * The subset of `grants` whose permission keys are in `keys` — the
 * `?applicationId=` slice of Doc 06 §11, applied to an already-resolved set.
 *
 * Not used by the endpoint, which narrows in SQL instead (see
 * `resolver.service.ts`), and kept out of it deliberately. It is here because
 * the *test* of the SQL narrowing needs an independent statement of what the
 * slice ought to be — deriving the expectation from the same query that
 * produced the answer would assert only that the query is consistent with
 * itself.
 */
export function sliceGrants(
  grants: ResolvedGrants,
  keys: Iterable<PermissionKey>,
): ResolvedGrants {
  const wanted = new Set(keys);
  const scopes: Record<PermissionKey, ScopePath[]> = {};

  for (const key of grants.permissions) {
    if (wanted.has(key)) scopes[key] = grants.scopes[key] as ScopePath[];
  }

  return { permissions: Object.keys(scopes), scopes };
}
