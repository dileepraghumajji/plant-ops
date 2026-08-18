/**
 * Role contract — the WHAT of the access equation (Doc 01 §4.2, Doc 06 §7).
 *
 * A role is a tenant-defined **bundle of catalog permissions**. It is the only
 * one of the three dimensions a client composes for itself: the permissions come
 * from the platform's catalog (Doc 02 §2), the scope nodes come from the client's
 * own org tree ({@link ScopeNodeDTO}), and a `role_binding` ties a subject to one
 * of each (Doc 01 §4.5).
 *
 * ## Why a role carries no permissions inline
 *
 * {@link RoleDTO} reports how many permissions it maps, not which — the mapping
 * is its own endpoint, `GET /iam/roles/:id/permissions`, returning
 * {@link RolePermissionsResponse}. Two reasons, and the second is the real one:
 *
 * - a role list is a list of names and counts (Doc 09 §3.2), and inlining a
 *   two-hundred-key permission set into every row of it is a payload nobody
 *   reads; and
 * - the mapping needs *more* than the permission — the owning application, and
 *   whether that application is still enabled for the tenant — which the role
 *   list has no business carrying.
 *
 * ## What "enabled" has to do with any of this
 *
 * Doc 02 §6: a role may only map permissions belonging to applications **enabled
 * for that role's client**. That is a rule about the moment a mapping is
 * *created*. It is deliberately not a rule about the moment one is *read*,
 * because Doc 02 §7 preserves mappings when an application is disabled — they go
 * inert, not away, so that re-enabling is a toggle rather than a re-setup. So
 * {@link RolePermissionDTO} publishes `application_enabled`: a mapped permission
 * that grants nothing today is a thing an operator has to be able to see, and a
 * response that silently omitted it would make a disabled application look like
 * a role someone had quietly edited.
 *
 * Field naming is snake_case, matching every other published shape here.
 */

/**
 * How many permissions one `PUT /iam/roles/:id/permissions` may set.
 *
 * The same bound the catalog's own bulk seed uses, and for the same reason: the
 * whole array is validated and written inside one request transaction, so an
 * unbounded body is an unbounded transaction. A role that needs more than two
 * hundred atomic permissions is a role that wants splitting.
 */
export const MAX_PERMISSIONS_PER_ROLE = 200;

/**
 * One tenant-defined role (Doc 01 §4.2).
 *
 * `is_system` marks a role the tenant did not create and may not rename or
 * delete — today that is the `Client Admin` role seeded with the tenant's first
 * administrator (Doc 02 §3 step 3). Its *permissions* are still set through the
 * ordinary endpoint, because a system role with no way to be given permissions
 * would be a role that can never do anything.
 *
 * The two counts are Doc 09 §3.2's list columns, which is the whole reason they
 * are on the DTO rather than left to the caller to assemble.
 */
export interface RoleDTO {
  id: string;
  client_id: string;
  /** Unique within the client — `unique (client_id, name)` (migration 0003). */
  name: string;
  description: string | null;
  /** Seeded by the platform; not renamable and not deletable by the tenant. */
  is_system: boolean;
  /** Rows in `role_permission`, enabled or not. Doc 09 §3.2's "# permissions". */
  permission_count: number;
  /**
   * Distinct subjects bound to this role anywhere in the tree — Doc 09 §3.2's
   * "# users bound".
   *
   * Distinct *subjects*, not bindings: one user bound at three plants is one
   * person with access, which is what the column is read as. It counts service
   * accounts too, since a machine identity holding a role is exactly as much a
   * consequence of deleting it (Doc 01 §4.5).
   */
  bound_subject_count: number;
  /** ISO-8601. */
  created_at: string;
  updated_at: string;
}

/**
 * One permission as a role maps it (Doc 01 §4.3).
 *
 * A {@link PermissionDTO} widened with the two facts that decide whether the
 * mapping currently grants anything: which application it belongs to, and
 * whether that application is still enabled for this tenant. Both are joined in
 * rather than left for the caller to fetch, because the permission picker of
 * Doc 09 §3.2 groups by application and cannot render a row without them.
 */
export interface RolePermissionDTO {
  id: string;
  key: string;
  name: string;
  description: string | null;
  /** The catalog's own switch — `false` once a manifest retires the key (Doc 02 §7). */
  is_active: boolean;
  application_id: string;
  application_key: string;
  application_name: string;
  /**
   * Whether the owning application is enabled for this role's client.
   *
   * `false` means the mapping is **inert but preserved** (Doc 02 §7): it grants
   * nothing today and grants again the moment the application is re-enabled.
   * A new mapping cannot be created in this state — that is the Doc 02 §6 rule —
   * but an existing one is never silently dropped.
   */
  application_enabled: boolean;
}

/**
 * `GET` / `PUT /iam/roles/:id/permissions` → the role's whole mapping
 * (Doc 06 §7).
 *
 * Not paginated, for the reason `/iam/permissions/resolve` is not: this is one
 * editable unit — a picker either shows the whole selection or shows a lie —
 * and it is bounded by {@link MAX_PERMISSIONS_PER_ROLE} rather than by a page
 * size. Ordered by application key, then permission key, so the grouping the UI
 * renders is the order it arrives in.
 */
export interface RolePermissionsResponse {
  role_id: string;
  permissions: RolePermissionDTO[];
}

/**
 * `GET /iam/roles/permission-catalog` → everything a role of this tenant may be
 * given (Doc 06 §7, Doc 09 §3.2).
 *
 * ## Why this exists at all
 *
 * Doc 09 §3.2's permission picker offers "only apps enabled for the client", and
 * until this endpoint there was no way for a tenant administrator to find out
 * what those were: the catalog lives behind `iam.platform.permission.read`, which
 * is platform authority no client admin holds, and
 * `GET /iam/roles/:id/permissions` answers a narrower question — what one role
 * already carries. A picker built from that could only ever offer what was
 * already chosen.
 *
 * ## Every entry is one `PUT /iam/roles/:id/permissions` will accept
 *
 * The set is exactly the four conditions that endpoint validates (Doc 02 §6):
 * the permission is active, its application is active in the registry, and that
 * application is enabled for this client. Anything the picker offers is
 * therefore mappable, which is what makes a 409 from a save a real conflict —
 * something changed underneath — rather than the ordinary result of choosing a
 * row that was on screen.
 *
 * ## It reuses {@link RolePermissionDTO}
 *
 * `is_active` and `application_enabled` are constant `true` for every entry
 * here, by construction. They are on the wire anyway so that a picker can hold
 * catalog entries and a role's own *inert* mappings — a preserved
 * `role_permission` whose application is currently disabled (Doc 02 §7) — in one
 * list without a union type. Those two are the rows that differ, and they are
 * the rows the screen has to render differently.
 */
export interface PermissionCatalogResponse {
  /** The caller's tenant, from the token — never from a query parameter. */
  client_id: string;
  /** Ordered by application name, then by permission key. */
  permissions: RolePermissionDTO[];
}

/**
 * `POST /iam/roles` body (Doc 06 §7).
 *
 * The client is the caller's own, taken from the token's `cid` and from nowhere
 * else — there is no `client_id` field here and there will not be one, for the
 * reason `/iam/scopes` has no `?clientId=`: it would look like it selected a
 * tenant while RLS quietly ignored it.
 *
 * `is_system` is likewise absent. A tenant that could set it would be able to
 * make a role it cannot afterwards delete.
 */
export interface CreateRoleRequest {
  name: string;
  description?: string;
}

/**
 * `PATCH /iam/roles/:id` body — Doc 06 §7's "rename", plus the description.
 *
 * The description rides along because it is the same row's editable prose and
 * Doc 10 §4 gives roles a `role.updated` action to record it under — the test
 * `updateScopeNodeSchema` fails, which is why the scope tree's PATCH is narrower
 * than this one rather than the other way round.
 *
 * Permissions are **not** here. They are a `PUT` of their own, because setting
 * them is a replacement of a set with cross-tenant validation attached
 * (Doc 02 §6), not a field of the role.
 */
export interface UpdateRoleRequest {
  name?: string;
  description?: string;
}

/**
 * `PUT /iam/roles/:id/permissions` body (Doc 06 §7).
 *
 * A `PUT` of the whole set, not a pair of add/remove calls: "which permissions
 * does this role have" is one question with one answer, and an editor that saves
 * a picker's state has exactly one set to send. An empty array is legal and
 * means what it says — the role maps nothing.
 *
 * ## Ids, not keys
 *
 * A permission `key` is unique only within its application (`unique
 * (application_id, key)`), so a bare key names a permission only if you already
 * know which application is meant. Accepting keys would therefore mean accepting
 * pairs, and a role editor gets its ids from
 * `GET /iam/applications/:id/permissions` — the same call that renders the
 * picker — so the pair would be assembled from data the caller already holds and
 * then taken apart again on arrival.
 */
export interface SetRolePermissionsRequest {
  permission_ids: string[];
}
