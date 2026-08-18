/**
 * Pure functions behind the role permission picker (Doc 09 §3.2, Doc 06 §7).
 *
 * The picker has to show two things that arrive from two endpoints and mean
 * different things:
 *
 * - **the catalog** — `GET /iam/roles/permission-catalog`, everything a role of
 *   this tenant may be given, which is exactly what `PUT …/permissions` accepts;
 * - **the role's own mapping** — `GET /iam/roles/:id/permissions`, which may
 *   contain rows the catalog does not: a permission whose application was
 *   disabled after the mapping was made is *preserved but inert* (Doc 02 §7),
 *   and one whose key a manifest retired is the same.
 *
 * Dropping those would be the worst possible behaviour: the picker would show a
 * role as smaller than it is, and saving would silently unmap the rows the
 * operator never saw. So they are merged, kept selected, and marked — and this
 * file is the merge, tested without rendering anything.
 *
 * ## What a save sends
 *
 * `PUT` replaces the whole set, so what is sent is the checked ids exactly. An
 * inert row that is left checked stays mapped and stays inert; unchecking it is
 * how it goes. Neither is a decision this file makes — it only makes sure both
 * are expressible, which they would not be if inert rows were invisible.
 */

import type { RolePermissionDTO } from '@plantops/contracts';

/** Why a mapped permission is not currently granting anything (Doc 02 §7). */
export type InertReason = 'application-disabled' | 'permission-retired' | null;

/** One row of the picker. */
export interface PickerPermission {
  permission: RolePermissionDTO;
  /** True when the role maps it today. */
  selected: boolean;
  /**
   * `null` when the row is live. Otherwise why it grants nothing right now —
   * which is worth a word beside the row, because the operator is looking at a
   * checked box that does nothing.
   */
  inert: InertReason;
}

/** The picker, grouped the way Doc 09 §3.2 asks for: by application. */
export interface PickerGroup {
  applicationId: string;
  applicationKey: string;
  applicationName: string;
  /** True when nothing in this group is currently granting (Doc 02 §6, §7). */
  inert: boolean;
  permissions: PickerPermission[];
}

/** Why this row grants nothing, or `null`. */
export function inertReason(permission: RolePermissionDTO): InertReason {
  if (!permission.application_enabled) return 'application-disabled';
  if (!permission.is_active) return 'permission-retired';
  return null;
}

export const INERT_EXPLANATION: Readonly<Record<
  Exclude<InertReason, null>,
  string
>> = {
  'application-disabled':
    'This application is not enabled for your organisation, so the mapping is kept but grants nothing. Re-enabling it restores the access exactly.',
  'permission-retired':
    'The application retired this permission. The mapping is kept, and grants again if a later release declares the key.',
};

/**
 * The catalog and the role's mapping, merged and grouped.
 *
 * Order is the catalog's — application name, then permission key — with any
 * inert group the role still carries appended after it. Live applications come
 * first because that is where the operator's decisions are; the inert tail is
 * there to be seen and, occasionally, unchecked.
 */
export function buildPicker(
  catalog: readonly RolePermissionDTO[],
  mapped: readonly RolePermissionDTO[],
): PickerGroup[] {
  const selected = new Set(mapped.map((permission) => permission.id));

  // Catalog first, so its order wins where the two overlap; the role's own rows
  // then fill in anything the catalog cannot offer.
  const byId = new Map<string, RolePermissionDTO>();
  for (const permission of catalog) byId.set(permission.id, permission);
  for (const permission of mapped) {
    if (!byId.has(permission.id)) byId.set(permission.id, permission);
  }

  const groups = new Map<string, PickerGroup>();
  for (const permission of byId.values()) {
    const group = groups.get(permission.application_id) ?? {
      applicationId: permission.application_id,
      applicationKey: permission.application_key,
      applicationName: permission.application_name,
      inert: true,
      permissions: [],
    };

    const inert = inertReason(permission);
    group.permissions.push({
      permission,
      selected: selected.has(permission.id),
      inert,
    });
    // A group is live as soon as one of its rows is.
    if (inert === null) group.inert = false;

    groups.set(permission.application_id, group);
  }

  return [...groups.values()].sort(
    (a, b) =>
      Number(a.inert) - Number(b.inert) ||
      a.applicationName.localeCompare(b.applicationName),
  );
}

/** Every id in the picker that the search term matches. */
export function matchesSearch(
  permission: RolePermissionDTO,
  term: string,
): boolean {
  const needle = term.trim().toLowerCase();
  if (needle === '') return true;
  return (
    permission.key.toLowerCase().includes(needle) ||
    permission.name.toLowerCase().includes(needle) ||
    (permission.description ?? '').toLowerCase().includes(needle) ||
    permission.application_name.toLowerCase().includes(needle)
  );
}

/**
 * The picker, narrowed to a search term.
 *
 * A group whose *name* matches keeps all its rows: typing "gatepass" means
 * "show me Gate Pass", not "show me the rows whose key happens to contain the
 * word". A group with no matching row and no matching name is dropped entirely
 * rather than rendered empty.
 */
export function filterPicker(
  groups: readonly PickerGroup[],
  term: string,
): PickerGroup[] {
  const needle = term.trim().toLowerCase();
  if (needle === '') return [...groups];

  return groups
    .map((group) => {
      if (
        group.applicationName.toLowerCase().includes(needle) ||
        group.applicationKey.toLowerCase().includes(needle)
      ) {
        return group;
      }
      return {
        ...group,
        permissions: group.permissions.filter((row) =>
          matchesSearch(row.permission, term),
        ),
      };
    })
    .filter((group) => group.permissions.length > 0);
}

/** Whether the chosen set differs from what the role holds — enables Save. */
export function selectionChanged(
  mapped: readonly RolePermissionDTO[],
  chosen: ReadonlySet<string>,
): boolean {
  if (mapped.length !== chosen.size) return true;
  return mapped.some((permission) => !chosen.has(permission.id));
}
