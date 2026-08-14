/**
 * The manifest diff — what an upload would change, computed before anything is
 * written (Doc 02 §7, Doc 09 §2.1).
 *
 * ## Why this is a pure function in its own file
 *
 * Three callers want the same answer and only one of them may touch a database:
 *
 * - `manifest.service.ts` applies it, and needs the *plan* — the rows to insert,
 *   the columns to update, the mappings to add and drop.
 * - The audit record needs the *summary*: which keys were created, changed and
 *   deactivated (this session's acceptance criterion).
 * - Session 29's preview screen needs that same summary, from a dry run, with
 *   nothing written at all.
 *
 * A diff computed inside the write path could serve the first two and would have
 * to be re-derived for the third, at which point the screen showing the operator
 * what is about to happen and the code doing it are two implementations of one
 * rule. So the rule lives here, takes a snapshot and a manifest, and returns a
 * plan. Everything in this file is total, synchronous and testable without
 * Postgres.
 *
 * ## What "changed" means, key by key
 *
 * The natural key is `(application, key)` — Doc 02 §7. A key in the manifest and
 * not in the catalog is **created**; in both, with any field differing, is
 * **updated**; in the catalog, active, and not in the manifest, is
 * **deactivated**. A key that returns after a deactivation is an update with
 * `is_active` among the fields that moved, not a creation: the row, its uuid,
 * and every `role_permission` and `menu_permission` that references it are still
 * there.
 *
 * Nothing here decides to delete. Doc 02 §7 has exactly one removal mechanism
 * and it is `is_active = false`.
 */

import type {
  ApplicationManifest,
  ManifestDiff,
  ManifestMappingChange,
  ManifestMappingDiff,
  ManifestNavNode,
  ManifestPermission,
  NavNodeKind,
} from '@plantops/contracts';

// ── the catalog as it is ─────────────────────────────────────────────────────

export interface CatalogApplication {
  key: string;
  name: string;
  description: string | null;
}

export interface CatalogPermission {
  key: string;
  name: string;
  description: string | null;
  is_active: boolean;
}

/**
 * One nav row, with its parent named by **key** rather than by id.
 *
 * The manifest addresses nodes by key and so does everything in this file; the
 * service resolves keys to ids on the way in and out. Diffing on ids would make
 * every field comparison depend on a lookup table the diff has no reason to
 * hold.
 */
export interface CatalogNavNode {
  key: string;
  kind: NavNodeKind;
  label: string;
  route: string | null;
  icon: string | null;
  sort_order: number;
  is_public: boolean;
  is_active: boolean;
  parent_key: string | null;
}

export interface CurrentCatalog {
  application: CatalogApplication;
  permissions: readonly CatalogPermission[];
  navNodes: readonly CatalogNavNode[];
  /** Nav key → the permission keys currently mapped to it (`menu_permission`). */
  mappings: ReadonlyMap<string, readonly string[]>;
}

// ── the catalog as the manifest declares it ──────────────────────────────────

/** One manifest node, flattened out of the tree with its parent and order fixed. */
export interface DesiredNavNode {
  key: string;
  kind: NavNodeKind;
  label: string;
  route: string | null;
  icon: string | null;
  sort_order: number;
  is_public: boolean;
  parent_key: string | null;
  /** Permission keys gating the node, deduplicated, in declaration order. */
  requires: string[];
}

// ── the plan ─────────────────────────────────────────────────────────────────

export interface PermissionUpdate {
  desired: ManifestPermission;
  current: CatalogPermission;
  /** Column names, in the order this file compares them. */
  changed: string[];
}

export interface NavNodeUpdate {
  desired: DesiredNavNode;
  current: CatalogNavNode;
  changed: string[];
}

export interface ManifestPlan {
  application: {
    key: string;
    name: string;
    description: string | null;
    changed: string[];
  };
  permissions: {
    created: ManifestPermission[];
    updated: PermissionUpdate[];
    deactivated: string[];
  };
  nav: {
    /** Depth-first, so a parent is always created before its children. */
    created: DesiredNavNode[];
    updated: NavNodeUpdate[];
    deactivated: string[];
  };
  mappings: ManifestMappingDiff;
}

/**
 * Flattens a manifest's nav tree, depth-first.
 *
 * ## `sortOrder` defaults to declaration order
 *
 * A node without an explicit `sortOrder` takes its index among its siblings, not
 * `0`. The alternative — the column default, with ties broken by key — renders
 * Doc 02 §2's own example manifest backwards: `dc.approvals` sorts before
 * `dc.create`, so "Approvals" would appear above "New DC" although the document
 * lists them the other way round. A JSON array is ordered, an author who wrote
 * one meant that order, and a declarative document that quietly ignores it is
 * one whose result has to be discovered rather than read.
 *
 * The cost is that inserting a node at the top of a list re-numbers its siblings
 * and the diff says so. That is honest — the menu did change — and an author who
 * wants stable numbering across edits can write `sortOrder` explicitly, which is
 * what the field is for.
 */
export function flattenManifestNav(nav: readonly ManifestNavNode[]): DesiredNavNode[] {
  const flat: DesiredNavNode[] = [];

  const visit = (nodes: readonly ManifestNavNode[], parentKey: string | null): void => {
    nodes.forEach((node, index) => {
      flat.push({
        key: node.key,
        kind: node.kind,
        label: node.label,
        route: node.route ?? null,
        icon: node.icon ?? null,
        sort_order: node.sortOrder ?? index,
        is_public: node.isPublic ?? false,
        parent_key: parentKey,
        requires: [...new Set(node.requires ?? [])],
      });
      if (node.children !== undefined) visit(node.children, node.key);
    });
  };

  visit(nav, null);
  return flat;
}

/**
 * What applying `manifest` to `current` would do.
 *
 * Assumes the manifest has already passed `applicationManifestSchema` — keys
 * unique, `requires` declared, nesting bounded. Those are properties of the
 * document alone and checking them twice would put the rule in two places.
 */
export function computeManifestPlan(
  current: CurrentCatalog,
  manifest: ApplicationManifest,
): ManifestPlan {
  const desired = flattenManifestNav(manifest.nav);

  return {
    application: planApplication(current.application, manifest),
    permissions: planPermissions(current.permissions, manifest.permissions),
    nav: planNav(current.navNodes, desired),
    mappings: planMappings(current, desired),
  };
}

/**
 * The application's own row.
 *
 * `description` is compared against `manifest.description ?? null`: a manifest
 * that stops mentioning a description has removed it, the same way it removes a
 * permission by no longer listing one. `key` is never changed — the service
 * refuses a manifest whose key is not the target's, because the key is what the
 * whole document is addressed by.
 */
function planApplication(
  current: CatalogApplication,
  manifest: ApplicationManifest,
): ManifestPlan['application'] {
  const description = manifest.description ?? null;
  const changed: string[] = [];

  if (manifest.name !== current.name) changed.push('name');
  if (description !== current.description) changed.push('description');

  return { key: current.key, name: manifest.name, description, changed };
}

function planPermissions(
  current: readonly CatalogPermission[],
  declared: readonly ManifestPermission[],
): ManifestPlan['permissions'] {
  const byKey = new Map(current.map((permission) => [permission.key, permission]));
  const wanted = new Set(declared.map((permission) => permission.key));

  const created: ManifestPermission[] = [];
  const updated: PermissionUpdate[] = [];

  for (const permission of declared) {
    const existing = byKey.get(permission.key);
    if (existing === undefined) {
      created.push(permission);
      continue;
    }

    const description = permission.description ?? null;
    const changed: string[] = [];
    if (permission.name !== existing.name) changed.push('name');
    if (description !== existing.description) changed.push('description');
    if (!existing.is_active) changed.push('is_active');

    if (changed.length > 0) {
      updated.push({ desired: permission, current: existing, changed });
    }
  }

  const deactivated = current
    .filter((permission) => permission.is_active && !wanted.has(permission.key))
    .map((permission) => permission.key);

  return { created, updated, deactivated };
}

/** The columns a nav node is diffed on, in the order they are compared. */
const NAV_FIELDS = [
  'kind',
  'label',
  'route',
  'icon',
  'sort_order',
  'is_public',
  // `parent_key`, not `parent_id`: the manifest addresses nodes by key, and a
  // diff that reported a re-parenting as a pair of uuids would be unreadable in
  // the audit payload it ends up in.
  'parent_key',
] as const satisfies readonly (keyof DesiredNavNode & keyof CatalogNavNode)[];

function planNav(
  current: readonly CatalogNavNode[],
  desired: readonly DesiredNavNode[],
): ManifestPlan['nav'] {
  const byKey = new Map(current.map((node) => [node.key, node]));
  const wanted = new Set(desired.map((node) => node.key));

  const created: DesiredNavNode[] = [];
  const updated: NavNodeUpdate[] = [];

  for (const node of desired) {
    const existing = byKey.get(node.key);
    if (existing === undefined) {
      created.push(node);
      continue;
    }

    const changed = NAV_FIELDS.filter((field) => node[field] !== existing[field]) as string[];
    if (!existing.is_active) changed.push('is_active');

    if (changed.length > 0) updated.push({ desired: node, current: existing, changed });
  }

  const deactivated = current
    .filter((node) => node.is_active && !wanted.has(node.key))
    .map((node) => node.key);

  return { created, updated, deactivated };
}

/**
 * `menu_permission` movement.
 *
 * Only nodes the manifest declares are considered. A node being deactivated
 * keeps its mappings: they are inert while `is_active = false` (Doc 05 §3 skips
 * the node entirely), and keeping them is what makes a node that comes back in a
 * later upload come back gated exactly as it was.
 */
function planMappings(
  current: CurrentCatalog,
  desired: readonly DesiredNavNode[],
): ManifestMappingDiff {
  const mapped: ManifestMappingChange[] = [];
  const unmapped: ManifestMappingChange[] = [];

  for (const node of desired) {
    const existing = new Set(current.mappings.get(node.key) ?? []);
    const wanted = new Set(node.requires);

    const toMap = node.requires.filter((key) => !existing.has(key));
    const toUnmap = [...existing].filter((key) => !wanted.has(key)).sort();

    if (toMap.length > 0) mapped.push({ nav_key: node.key, permission_keys: toMap });
    if (toUnmap.length > 0) unmapped.push({ nav_key: node.key, permission_keys: toUnmap });
  }

  return { mapped, unmapped };
}

/** The plan as the compact, key-only summary the API and the audit record carry. */
export function toManifestDiff(plan: ManifestPlan): ManifestDiff {
  return {
    application: { key: plan.application.key, changed: plan.application.changed },
    permissions: {
      created: plan.permissions.created.map((permission) => permission.key),
      updated: plan.permissions.updated.map((update) => update.desired.key),
      deactivated: plan.permissions.deactivated,
    },
    nav: {
      created: plan.nav.created.map((node) => node.key),
      updated: plan.nav.updated.map((update) => update.desired.key),
      deactivated: plan.nav.deactivated,
    },
    menu_permissions: plan.mappings,
  };
}

/**
 * Whether the manifest described exactly what was already there.
 *
 * The idempotence criterion of this session, and the reason a re-upload writes
 * no rows *and no audit record*: a trail with one `application.manifest.upserted`
 * per deploy is a trail in which the deploy that actually changed the catalog is
 * invisible. Same rule the PATCH and the mapping endpoints already follow.
 */
export function isNoOpDiff(diff: ManifestDiff): boolean {
  return (
    diff.application.changed.length === 0 &&
    diff.permissions.created.length === 0 &&
    diff.permissions.updated.length === 0 &&
    diff.permissions.deactivated.length === 0 &&
    diff.nav.created.length === 0 &&
    diff.nav.updated.length === 0 &&
    diff.nav.deactivated.length === 0 &&
    diff.menu_permissions.mapped.length === 0 &&
    diff.menu_permissions.unmapped.length === 0
  );
}
