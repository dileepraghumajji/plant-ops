/**
 * Authorization contract — the resolved WHO × WHAT × WHERE answer every module
 * consumes (Doc 04 §4–6).
 */

import { SubjectType } from './jwt.js';

/**
 * A namespaced permission key, `app.resource.action` (Doc 01 §3.2).
 *
 * Deliberately a plain `string`: permission keys are **data**, created at
 * runtime through the registry. The IAM must never enumerate them in code
 * (Doc 02 §8) — a union type here would be exactly that.
 */
export type PermissionKey = string;

/**
 * A materialized `ltree` path identifying a scope-tree node,
 * `n_<hex>.n_<hex>.…` (Doc 01 §3.5). Coverage is the prefix test `<@`.
 */
export type ScopePath = string;

/**
 * A subject's complete grant set (Doc 04 §4.1).
 *
 * `scopes[permKey]` is the **minimal covering set** of paths for that
 * permission: if an ancestor path is present, its descendants are dropped
 * because `<@` already covers them. Consumers may rely on that minimization.
 */
export interface ResolvedGrants {
  /** Flat list of held permission keys, for quick "has permission" checks. */
  permissions: PermissionKey[];
  /** permission key → minimal set of covering scope paths. */
  scopes: Record<PermissionKey, ScopePath[]>;
}

/**
 * The cached form of {@link ResolvedGrants} (Doc 04 §6). `v` is the
 * `(client, subject)` version counter; a mismatch against the authoritative
 * counter is treated as a cache miss, which is how role-level changes
 * invalidate without enumerating subjects (Doc 04 §7).
 */
export interface CachedGrants extends ResolvedGrants {
  v: number;
}

/** `POST /iam/permissions/check` body (Doc 06 §11). */
export interface PermissionCheckRequest {
  permission: PermissionKey;
  scopeNodeId: string;
}

export interface PermissionCheckResponse {
  allowed: boolean;
}

/** Optional narrowing of `/iam/permissions/resolve` to one application's slice. */
export interface ResolveQuery {
  applicationId?: string;
}

/**
 * Payload of the `perms.invalidated` event (Doc 04 §7). Either a specific
 * subject or a role whose bound subjects are affected.
 */
export interface PermsInvalidatedEvent {
  clientId: string;
  subjectId?: string;
  subjectType?: SubjectType;
  roleId?: string;
}

/** Redis key prefix for cached grants (Doc 04 §6). */
export const GRANTS_CACHE_KEY_PREFIX = 'perms';

/**
 * `perms:{clientId}:{subjectType}:{subjectId}` — the cache key shape from
 * Doc 04 §6. A function so IAM and every cache holder derive it identically.
 */
export function grantsCacheKey(
  clientId: string,
  subjectType: SubjectType,
  subjectId: string,
): string {
  return `${GRANTS_CACHE_KEY_PREFIX}:${clientId}:${subjectType}:${subjectId}`;
}
