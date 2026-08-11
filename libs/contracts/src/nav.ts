/**
 * Navigation contract — the pruned menu tree `GET /iam/navigation` returns
 * (Doc 05 §4). The frontend renders this directly; it keeps no menu constants
 * of its own (Doc 05 §7).
 */

/** Depth discriminator on the self-referencing `nav_node` table (Doc 01 §3.3). */
export const NavNodeKind = {
  MODULE: 'module',
  MENU: 'menu',
  SUB_MENU: 'sub_menu',
} as const;
export type NavNodeKind = (typeof NavNodeKind)[keyof typeof NavNodeKind];

/**
 * A node in the resolved tree. Only visible nodes are present: leaves the
 * subject holds no mapped permission for are pruned, and containers left
 * without a visible descendant are pruned with them (Doc 05 §3).
 */
export interface NavNodeDTO {
  id: string;
  kind: NavNodeKind;
  key: string;
  label: string;
  /** Frontend path; absent on pure containers. */
  route?: string | null;
  /** Icon *key* — the frontend maps it to its own icon set (Doc 05 §7). */
  icon?: string | null;
  children: NavNodeDTO[];
}

export interface ApplicationSummaryDTO {
  id: string;
  key: string;
  name: string;
}

/**
 * `GET /iam/navigation?applicationId=` → one application's tree.
 * `GET /iam/navigation` (no id) → the cross-application shell, one top-level
 * node per enabled application, with `application: null` (Doc 05 §4).
 */
export interface NavigationResponse {
  application: ApplicationSummaryDTO | null;
  tree: NavNodeDTO[];
}
