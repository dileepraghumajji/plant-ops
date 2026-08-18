'use client';

/**
 * Does a grant at *this* node reach *that* node? (Doc 04 §4.2)
 *
 * A binding at Plant B covers Plant B and everything under it — its
 * departments, its gates — because scope paths are `ltree` materialized paths
 * and coverage is the ancestor test `<@`. In Postgres that is one operator; in
 * a browser it is a string prefix on `.`-separated labels, which is what these
 * functions are.
 *
 * ## This is a copy, and that is deliberate
 *
 * `libs/auth-kit`'s `ScopeResolver` performs the same test server-side, and the
 * boundary rules keep it out of a browser bundle on purpose: `auth-kit` is
 * NestJS code, `scope:auth` is importable only by `iam-api` and future module
 * APIs (Doc 08 §2). Rather than widen that boundary to share thirty lines, the
 * predicate is restated here — with the understanding that **this copy decides
 * nothing**. It hides a button (Doc 09 §4: "client-side hiding is UX; server
 * enforces"). If the two ever disagree, the server wins and the user sees a
 * 403, which is a cosmetic bug rather than a security one. Widening the
 * boundary to avoid it would trade a cosmetic risk for a structural one.
 *
 * The label alphabet is what keeps the prefix test honest: labels are
 * `n_<uuid-hex>` (Doc 01 §3.5), all the same length, containing no `.`. There
 * is no `n_abc` / `n_abcdef` sibling pair for a naive `startsWith` to confuse —
 * but the separator check below does not rely on that.
 */

import type { PermissionKey, ResolvedGrants, ScopePath } from '@plantops/contracts';

/**
 * True when `grantedPath` is `targetPath` or an ancestor of it.
 *
 * The `.` in the prefix test is load-bearing: without it `n_aa` would appear to
 * cover `n_aab`, which is a different subtree.
 */
export function pathCovers(grantedPath: ScopePath, targetPath: ScopePath): boolean {
  if (grantedPath === '' || targetPath === '') return false;
  return targetPath === grantedPath || targetPath.startsWith(`${grantedPath}.`);
}

/** True when any granted path covers the target. */
export function anyPathCovers(
  grantedPaths: readonly ScopePath[],
  targetPath: ScopePath,
): boolean {
  return grantedPaths.some((granted) => pathCovers(granted, targetPath));
}

/** True when the subject holds the permission anywhere at all. */
export function holdsPermission(
  grants: ResolvedGrants | undefined,
  permission: PermissionKey,
): boolean {
  return grants?.permissions.includes(permission) ?? false;
}

/**
 * True when the subject holds the permission at a node covering `scopePath`.
 *
 * The narrower question, and the one a scope-specific control asks — "may I
 * approve *this* gate's pass", not "may I approve passes".
 */
export function holdsPermissionAt(
  grants: ResolvedGrants | undefined,
  permission: PermissionKey,
  scopePath: ScopePath,
): boolean {
  if (grants === undefined) return false;
  return anyPathCovers(grants.scopes[permission] ?? [], scopePath);
}

/**
 * The minimal set of paths the subject holds this permission at (Doc 04 §4.1).
 *
 * Already minimized by the server — a descendant is dropped when an ancestor is
 * present — so a consumer narrowing a query by these paths needs no further
 * reduction.
 */
export function permissionScopes(
  grants: ResolvedGrants | undefined,
  permission: PermissionKey,
): readonly ScopePath[] {
  return grants?.scopes[permission] ?? [];
}
