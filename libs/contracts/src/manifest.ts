/**
 * Application manifest — the declarative document an application ships to
 * register (and later evolve) its permission and navigation catalog
 * (Doc 02 §2).
 *
 * Uploading a manifest is an **upsert keyed by natural key** (`application.key`
 * + node/permission `key`): re-uploading is idempotent, changed labels update in
 * place, and keys absent from a re-upload soft-deactivate rather than delete
 * (Doc 02 §7).
 *
 * ## Two naming conventions in one file, on purpose
 *
 * The manifest *document* is camelCase (`sortOrder`, `isPublic`). It is a
 * hand-authored JSON file that ships with an application, not an API body, and
 * this shape is the one the contract has published since Session 1.
 *
 * The *response* types below are snake_case, matching {@link ApplicationDTO} and
 * every other shape Doc 06 §3 writes out. A convention that changes between two
 * endpoints of the same API is worse than either convention — and the diff is an
 * API response, whatever the document that produced it looks like.
 */

import type { NavNodeKind } from './nav.js';

export interface ManifestPermission {
  /** Namespaced `app.resource.action`, unique within the application. */
  key: string;
  name: string;
  description?: string;
}

export interface ManifestNavNode {
  kind: NavNodeKind;
  /** Unique within the application; the upsert's natural key. */
  key: string;
  label: string;
  /** Frontend path. Omit for pure containers. */
  route?: string;
  /** Icon key resolved by the frontend's icon set (Doc 05 §7). */
  icon?: string;
  sortOrder?: number;
  /**
   * Leaf-only opt-in making an *unmapped* leaf visible to anyone who can see
   * the app. Defaults to `false` — unmapped means hidden (Doc 05 §3).
   */
  isPublic?: boolean;
  /**
   * Permission keys gating this node, OR semantics — becomes `menu_permission`
   * rows (Doc 01 §4.4).
   */
  requires?: string[];
  children?: ManifestNavNode[];
}

export interface ApplicationManifest {
  /** Machine key of the application, e.g. `gatepass` (Doc 01 §3.1). */
  key: string;
  name: string;
  description?: string;
  permissions: ManifestPermission[];
  nav: ManifestNavNode[];
}

/**
 * What an upsert did to one kind of catalog row, by natural key.
 *
 * Keys rather than counts, because both consumers need the names: Doc 09 §2.1's
 * preview screen shows the operator *what* is about to change, and the audit
 * payload has to answer "when did this key appear, and when did it go" long
 * after the manifest that caused it was overwritten.
 *
 * There is no `deleted`. Removal from a manifest soft-deactivates (Doc 02 §7) —
 * `role_permission` rows and audit payloads still name these keys, and a hard
 * delete would revoke grants with no record of what was revoked.
 *
 * Reactivation of a key that came back is an `updated`, with `is_active` among
 * the fields that moved.
 */
export interface ManifestEntityDiff {
  created: string[];
  updated: string[];
  deactivated: string[];
}

/** One nav node and the permission keys mapped to (or unmapped from) it. */
export interface ManifestMappingChange {
  nav_key: string;
  permission_keys: string[];
}

/**
 * `menu_permission` movement, grouped by nav node.
 *
 * Grouped rather than listed pair by pair for the reason the mapping audit
 * records are: a node's gate is one fact about that node, and a flat pair list
 * says the same thing in `nodes × permissions` lines.
 */
export interface ManifestMappingDiff {
  mapped: ManifestMappingChange[];
  unmapped: ManifestMappingChange[];
}

/** Fields of the `application` row itself the manifest moved (`name`, `description`). */
export interface ManifestApplicationDiff {
  key: string;
  changed: string[];
}

/**
 * The complete difference between a manifest and the catalog it is applied to.
 *
 * Computed before anything is written, which is what lets Session 29 preview it
 * and this session audit it — the same value, from the same function.
 */
export interface ManifestDiff {
  application: ManifestApplicationDiff;
  permissions: ManifestEntityDiff;
  nav: ManifestEntityDiff;
  menu_permissions: ManifestMappingDiff;
}

/** `POST /iam/applications/:id/manifest` (Doc 06 §4). */
export interface ManifestUpsertResponse {
  application_id: string;
  /**
   * `false` when the manifest described exactly what was already there.
   *
   * A no-op upsert writes nothing at all — no rows, no audit record — so this
   * flag is the only way a caller can tell an idempotent re-upload from a
   * first one without diffing the diff itself.
   */
  changed: boolean;
  diff: ManifestDiff;
}
