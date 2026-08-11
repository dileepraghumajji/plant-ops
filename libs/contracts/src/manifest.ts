/**
 * Application manifest — the declarative document an application ships to
 * register (and later evolve) its permission and navigation catalog
 * (Doc 02 §2).
 *
 * Uploading a manifest is an **upsert keyed by natural key** (`application.key`
 * + node/permission `key`): re-uploading is idempotent, changed labels update in
 * place, and keys absent from a re-upload soft-deactivate rather than delete
 * (Doc 02 §7).
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
