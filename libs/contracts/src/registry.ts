/**
 * Registry contract — the platform-admin catalog surface (Doc 06 §4).
 *
 * Three tables, one vocabulary: `application` is what a module *is*,
 * `permission` is what it can be granted, `nav_node` is what it shows. All three
 * are **catalog**, not tenant data (Doc 07 §6): they carry no `client_id`, every
 * authenticated subject can read them, and only a platform admin writes them.
 *
 * ## Natural keys, and why the DTOs carry both halves
 *
 * Every row here has two identifiers: a uuid, and a `key` that is unique within
 * its parent (`application.key` globally, `permission.key` and `nav_node.key`
 * per application). Both are returned, deliberately. The uuid is what a
 * `role_permission` or `menu_permission` row references; the key is what a
 * manifest is written against (Doc 02 §2) and what an operator recognises. A
 * contract that returned only one of them would force every consumer to keep its
 * own lookup table to get back the other.
 *
 * Field naming is snake_case, matching {@link ServiceAccountDTO} and the bodies
 * Doc 06 §3 writes out — these are published shapes, and a convention that
 * changes between two endpoints of the same API is worse than either
 * convention.
 */

import type { NavNodeKind } from './nav.js';

/**
 * One registered application (Doc 01 §3.1).
 *
 * `is_active = false` is the global off switch of Doc 02 §7: the app is hidden
 * everywhere and **all of its data is preserved**. There is no delete, because a
 * deleted application would cascade away the permissions that existing role
 * mappings and audit rows still refer to.
 */
export interface ApplicationDTO {
  id: string;
  /** Machine key, e.g. `gatepass`. Globally unique and never editable. */
  key: string;
  name: string;
  description: string | null;
  is_active: boolean;
  /** Free-form per-application settings (Doc 01 §3.1). */
  config: Record<string, unknown>;
  /** ISO-8601. */
  created_at: string;
  updated_at: string;
}

/**
 * One atomic permission (Doc 01 §3.2).
 *
 * The key is the dotted `app.resource.action` form Doc 02 §2 writes; the pair
 * `(application_id, key)` is unique, which is the 409 in Doc 06 §4.
 */
export interface PermissionDTO {
  id: string;
  application_id: string;
  key: string;
  name: string;
  description: string | null;
  is_active: boolean;
  /** ISO-8601. */
  created_at: string;
  updated_at: string;
}

/**
 * One nav node as the **catalog** holds it (Doc 01 §3.3).
 *
 * Distinct from {@link NavNodeDTO}, which is the *resolved* tree a subject sees
 * (Doc 05 §4): that one is pruned to what the subject may see and therefore
 * omits `is_active`, `is_public` and `requires`, because a pruned tree has
 * already answered the question those fields exist to decide. This one is the
 * platform admin's view of what exists, visible or not.
 */
export interface NavNodeCatalogDTO {
  id: string;
  application_id: string;
  /** `null` = top level. A parent always belongs to the same application. */
  parent_id: string | null;
  kind: NavNodeKind;
  /** Unique within the application; the manifest upsert's natural key. */
  key: string;
  label: string;
  route: string | null;
  /** Icon *key* — the frontend maps it to its own icon set (Doc 05 §7). */
  icon: string | null;
  sort_order: number;
  is_active: boolean;
  /** Leaf-only opt-in: an unmapped leaf is visible anyway (Doc 05 §3). */
  is_public: boolean;
  /**
   * Keys of the permissions mapped to this node, OR semantics (Doc 01 §4.4).
   *
   * Included so the tree is inspectable in one call: the mapping is the whole
   * point of a nav node, and a catalog view that omits it sends every caller
   * back for a second request to find out whether a node is reachable at all.
   */
  requires: string[];
  /** ISO-8601. */
  created_at: string;
  updated_at: string;
  children: NavNodeCatalogDTO[];
}

/** `GET /iam/applications/:id/nav` — the application's full catalog tree. */
export interface NavCatalogResponse {
  application_id: string;
  /** Top-level nodes, each with its descendants, ordered by `sort_order`. */
  tree: NavNodeCatalogDTO[];
}

/** `POST /iam/applications` body (Doc 06 §4). */
export interface CreateApplicationRequest {
  key: string;
  name: string;
  description?: string;
  config?: Record<string, unknown>;
}

/**
 * `PATCH /iam/applications/:id` body (Doc 06 §4) — update, or activate /
 * deactivate.
 *
 * `key` is absent on purpose: it is the natural key every manifest upload and
 * every permission address is written against (Doc 02 §2), so renaming it would
 * silently re-point an entire catalog.
 */
export interface UpdateApplicationRequest {
  name?: string;
  description?: string | null;
  is_active?: boolean;
  config?: Record<string, unknown>;
}

/** One entry of the `POST /iam/applications/:id/permissions` body. */
export interface CreatePermissionInput {
  key: string;
  name: string;
  description?: string;
}

/** `POST /iam/applications/:id/permissions` body — bulk (Doc 02 §2 step 2). */
export interface CreatePermissionsRequest {
  permissions: CreatePermissionInput[];
}

/**
 * One entry of the `POST /iam/applications/:id/nav` body.
 *
 * The parent is named by **either** `parent_id` or `parent_key`, never both.
 * `parent_key` may name a node created earlier in the same request, which is
 * what lets one call build a module and its menus in the order Doc 02 §2 step 3
 * describes.
 */
export interface CreateNavNodeInput {
  kind: NavNodeKind;
  key: string;
  label: string;
  route?: string;
  icon?: string;
  sort_order?: number;
  is_public?: boolean;
  parent_id?: string;
  parent_key?: string;
}

/** `POST /iam/applications/:id/nav` body — bulk (Doc 02 §2 step 3). */
export interface CreateNavNodesRequest {
  nodes: CreateNavNodeInput[];
}

/** One nav node and the permission keys being mapped to (or unmapped from) it. */
export interface NavPermissionMapping {
  nav_key: string;
  permission_keys: string[];
}

/**
 * `POST` / `DELETE /iam/applications/:id/nav-permissions` body (Doc 02 §2 step 4).
 *
 * Both directions take the same shape because they are the same statement in
 * opposite directions, and both are idempotent: mapping what is already mapped
 * and unmapping what is not are no-ops that audit nothing.
 */
export interface NavPermissionsRequest {
  mappings: NavPermissionMapping[];
}

/** What a mapping call changed — the counts, plus the pairs it touched. */
export interface NavPermissionsResult {
  /** Rows actually inserted (`POST`) or deleted (`DELETE`). */
  changed: number;
  /** Pairs already in the requested state, which changed nothing. */
  unchanged: number;
}
