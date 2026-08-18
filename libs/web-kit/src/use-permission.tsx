'use client';

/**
 * Permission-aware controls (Doc 09 §4).
 *
 * "Buttons/actions the subject lacks permission for are hidden/disabled (UX
 * only; server enforces)." Every screen session from Session 28 onward uses
 * this hook, which is why it is here rather than in `admin-web`: gatepass and
 * visitor hide their buttons with the same code.
 *
 * ## Hide or disable?
 *
 * Hide by default. A disabled button is a promise that something exists and
 * could be reached, which invites a support ticket asking how; an absent one
 * says nothing. Disable when the control's absence would make a layout
 * incoherent — a toolbar with one button left, a table column of actions where
 * some rows are actionable and some are not — and give it a `title` saying
 * which permission is missing, because "greyed out and unexplained" is the
 * worst of both.
 *
 * ## What this is not
 *
 * It is not authorisation. `usePermission` reads the resolved grants the server
 * sent this browser; anything the browser can read, the browser can lie about.
 * The server checks again on every call (`PermissionGuard`, Session 23) and a
 * deep link into a hidden screen still 403s (Doc 09 §4). This exists so a user
 * is not shown doors they cannot open — not so the doors are locked.
 *
 * ## While grants are loading
 *
 * `usePermission` answers `false` until they arrive. Showing a control and then
 * removing it is worse than showing it a moment late, and a screen that wants
 * to hold the whole thing back reads `loading` and renders a skeleton.
 */

import type { PermissionKey, ScopePath } from '@plantops/contracts';
import * as React from 'react';

import { useGrants } from './grants-provider';
import {
  holdsPermission,
  holdsPermissionAt,
  permissionScopes,
} from './scope-coverage';

export interface PermissionQuery {
  /**
   * Restrict the question to a place in the org tree — "may I do this *here*".
   *
   * Omit for the broad question ("may I do this anywhere"), which is what a nav
   * item or a list screen asks: Doc 05 §3 is explicit that visibility is
   * permission-based, not scope-based, and that scope filters data *within* a
   * screen.
   */
  scopePath?: ScopePath;
}

export interface PermissionApi {
  /** Does the subject hold this permission (optionally, at this node)? */
  can: (permission: PermissionKey, query?: PermissionQuery) => boolean;
  /** Any of them — the OR a nav node's `menu_permission` rows express. */
  canAny: (permissions: readonly PermissionKey[], query?: PermissionQuery) => boolean;
  /** All of them — for a screen that genuinely needs two. */
  canAll: (permissions: readonly PermissionKey[], query?: PermissionQuery) => boolean;
  /**
   * The minimal covering paths for a permission (Doc 04 §4.1).
   *
   * What a screen narrows its query by: "show me the gates I may check in at"
   * rather than "show me every gate and let the server refuse most of them".
   */
  scopesFor: (permission: PermissionKey) => readonly ScopePath[];
  /** True until the first resolve lands; every answer above is `false` meanwhile. */
  loading: boolean;
}

/** The whole permission surface, for a screen asking several questions. */
export function usePermissions(): PermissionApi {
  const { grants, loading } = useGrants();

  return React.useMemo<PermissionApi>(() => {
    const can = (permission: PermissionKey, query?: PermissionQuery): boolean =>
      query?.scopePath === undefined
        ? holdsPermission(grants, permission)
        : holdsPermissionAt(grants, permission, query.scopePath);

    return {
      can,
      canAny: (permissions, query) => permissions.some((key) => can(key, query)),
      canAll: (permissions, query) =>
        permissions.length > 0 && permissions.every((key) => can(key, query)),
      scopesFor: (permission) => permissionScopes(grants, permission),
      loading,
    };
  }, [grants, loading]);
}

/**
 * One permission, as a boolean — the common case.
 *
 * ```tsx
 * const canCreate = usePermission('iam.client.user.create');
 * {canCreate && <Button type="primary">Add user</Button>}
 * ```
 */
export function usePermission(
  permission: PermissionKey,
  query?: PermissionQuery,
): boolean {
  const { can } = usePermissions();
  return can(permission, query);
}

export interface PermittedProps {
  /** Held (at `scopePath`, if given) to render `children`. */
  permission: PermissionKey | readonly PermissionKey[];
  scopePath?: ScopePath;
  children: React.ReactNode;
  /** Rendered instead when the subject lacks it. Usually nothing. */
  fallback?: React.ReactNode;
}

/**
 * Renders `children` only if the subject holds the permission.
 *
 * The JSX form of {@link usePermission}, for a block of markup that would
 * otherwise need a variable and a conditional. An array means "any of these",
 * matching the OR semantics `menu_permission` uses for nav visibility
 * (Doc 05 §3).
 */
export function Permitted({
  permission,
  scopePath,
  children,
  fallback = null,
}: PermittedProps): React.ReactNode {
  const { can, canAny } = usePermissions();
  const query = scopePath === undefined ? undefined : { scopePath };
  const allowed = Array.isArray(permission)
    ? canAny(permission, query)
    : can(permission as PermissionKey, query);

  return allowed ? children : fallback;
}
