/**
 * Client contract — the tenant-provisioning surface (Doc 06 §5, Doc 02 §3).
 *
 * Three things live here, and they are three because provisioning a tenant is
 * three separable decisions: **who the tenant is** ({@link ClientDTO}), **what
 * they are allowed to run** ({@link ClientApplicationDTO}), and **who
 * administers them on day one** ({@link ClientAdminDTO}). Doc 02 §3 lists them
 * in that order and the API follows it, because each step is only meaningful
 * once the one before it has happened.
 *
 * ## These are tenant rows described by a platform API
 *
 * Unlike {@link ApplicationDTO} and friends, everything here carries a
 * `client_id` and lives behind RLS (Doc 07 §6). The surface is nonetheless
 * platform-tier: a tenant does not create itself, and the endpoints are gated on
 * `iam.platform.*`. That split is why the DTOs name the client explicitly rather
 * than leaving it implied by the caller's token, the way the client-admin
 * surfaces of Doc 06 §6–9 do.
 *
 * Field naming is snake_case, matching every other published shape in this
 * package.
 */

/**
 * A tenant's lifecycle states (Doc 01 §3.4).
 *
 * Two, and neither is `deleted`: a tenant is suspended, never removed. Doc 06 §5
 * makes suspension the off switch — a suspended client's users cannot log in,
 * which migration 0012's `auth_begin_session` enforces by re-checking
 * `client.status` at the moment a session is created — while every scope node,
 * role, binding and audit row it owns stays exactly where it was. Deleting a
 * client would take an organisation's entire access history with it, and
 * `on delete restrict` on every child table (migration 0003) makes sure nobody
 * does it by accident.
 *
 * Spelled here rather than imported from `@plantops/db`, which contracts must
 * not depend on — it has zero dependencies by design (Doc 08 §3). The Postgres
 * enum is the same two values, and `libs/db`'s `entities.spec.ts` asserts the
 * two spellings against each other so they cannot drift into a status the API
 * accepts and the column rejects. Same arrangement as
 * {@link ServiceAccountStatus}.
 */
export const ClientStatus = {
  ACTIVE: 'active',
  SUSPENDED: 'suspended',
} as const;
export type ClientStatus = (typeof ClientStatus)[keyof typeof ClientStatus];

export const CLIENT_STATUS_VALUES = [
  ClientStatus.ACTIVE,
  ClientStatus.SUSPENDED,
] as const satisfies readonly ClientStatus[];

/**
 * One tenant (Doc 01 §3.4).
 *
 * `slug` is half of the login credential — `POST /auth/login` takes
 * `{ email, password, client_slug }` (Doc 03 §3) — which is why it is returned
 * on every read and why nothing can change it.
 */
export interface ClientDTO {
  id: string;
  name: string;
  /** Lowercase kebab-case, and the half of the login credential a user types. */
  slug: string;
  status: ClientStatus;
  /** Free-form per-tenant settings (Doc 01 §3.4). */
  config: Record<string, unknown>;
  /**
   * How many applications this client currently has **enabled**.
   *
   * Included because Doc 09 §2.2's client list shows exactly this column, and a
   * list view that had to issue one extra request per row to render it would be
   * a list view nobody keeps. Disabled `client_application` rows are not counted
   * — they are preserved, not active (Doc 02 §7).
   */
  enabled_application_count: number;
  /** ISO-8601. */
  created_at: string;
  updated_at: string;
}

/**
 * One application enabled for one client (Doc 01 §4.1).
 *
 * The application's `key` and `name` ride along with the ids for the reason
 * {@link NavNodeCatalogDTO} carries `requires`: the toggle list of Doc 09 §2.2
 * is unreadable as a column of uuids, and a consumer that had to join the
 * catalog itself would be keeping a second copy of it.
 *
 * `enabled = false` is the tenant-level off switch of Doc 02 §7. The row stays,
 * with its config, and every role mapping that referenced the app's permissions
 * stays intact but inert — which is what makes re-enabling a toggle rather than
 * a re-setup.
 */
export interface ClientApplicationDTO {
  client_id: string;
  application_id: string;
  /** The application's machine key, e.g. `gatepass`. */
  application_key: string;
  application_name: string;
  enabled: boolean;
  /** Per-client settings for this application (Doc 01 §4.1). */
  config: Record<string, unknown>;
  /** ISO-8601. */
  created_at: string;
  updated_at: string;
}

/**
 * What `POST /iam/clients/:id/admins` created (Doc 06 §5, Doc 09 §2.2).
 *
 * Flat, and deliberately not a `UserDTO`: this describes the **bootstrap**, not
 * a user resource. One call creates four rows that are only useful together —
 * the user, the client's root scope node, the system client-admin role, and the
 * binding that ties them — and the caller's next question is "can this person
 * log in and see their whole organisation", which the four ids answer. The user
 * management surface, and the `UserDTO` it publishes, is Doc 06 §8 / Session 18.
 *
 * No credential appears here. The password is chosen by the caller and is never
 * echoed, stored in the clear, or written to the audit payload (Doc 10 §8).
 */
export interface ClientAdminDTO {
  client_id: string;
  user_id: string;
  email: string;
  full_name: string;
  /** The system role the user was bound to — `is_system`, per Doc 06 §5. */
  role_id: string;
  role_name: string;
  /** The client's root scope node: everything the admin's grants cover. */
  scope_node_id: string;
  scope_node_name: string;
  /** The root's ltree path — one `n_<hex>` label (Doc 01 §3.5). */
  scope_node_path: string;
  role_binding_id: string;
  /** ISO-8601. */
  created_at: string;
}

/** `POST /iam/clients` body (Doc 06 §5). */
export interface CreateClientRequest {
  name: string;
  slug: string;
  config?: Record<string, unknown>;
}

/**
 * `PATCH /iam/clients/:id` body (Doc 06 §5) — update, or suspend / reactivate.
 *
 * `slug` is absent on purpose, for a sharper version of the reason
 * {@link UpdateApplicationRequest} omits `key`: the slug is not merely a natural
 * key, it is something every one of the tenant's users types to log in
 * (Doc 03 §3). Renaming it would lock out an entire organisation at once, and
 * nothing in the row would look wrong afterwards.
 */
export interface UpdateClientRequest {
  name?: string;
  status?: ClientStatus;
  config?: Record<string, unknown>;
}

/**
 * One entry of the `POST /iam/clients/:id/applications` body.
 *
 * The application is named by **either** `application_id` or `application_key`,
 * never both — the same rule, for the same reason, as
 * {@link CreateNavNodeInput}'s two ways of naming a parent. The key is what an
 * operator recognises and what a manifest is written against; the uuid is what a
 * UI already holds after listing the catalog.
 */
export interface EnableApplicationInput {
  application_id?: string;
  application_key?: string;
  config?: Record<string, unknown>;
}

/** `POST /iam/clients/:id/applications` body — bulk (Doc 02 §3 step 2). */
export interface EnableApplicationsRequest {
  applications: EnableApplicationInput[];
}

/** `PATCH /iam/clients/:id/applications/:appId` body (Doc 06 §5). */
export interface UpdateClientApplicationRequest {
  enabled?: boolean;
  config?: Record<string, unknown>;
}

/**
 * `POST /iam/clients/:id/admins` body (Doc 06 §5).
 *
 * `password` is chosen rather than generated, unlike a service-account secret.
 * The distinction is what the credential is: a machine secret is never typed by
 * anyone, so minting it removes a decision nobody benefits from making, whereas
 * this one belongs to a person who is about to type it and change it. Doc 03 §7
 * already governs its strength, and the tokenized reset of Doc 06 §3 is
 * available from the moment the account exists.
 *
 * `scope_name` names the root of the tenant's org tree — the node every grant in
 * this call covers. It defaults to the client's own name, which is what an
 * operator means by it nine times out of ten; the tree beneath it is the
 * client admin's to build (Doc 06 §6).
 */
export interface CreateClientAdminRequest {
  email: string;
  full_name: string;
  password: string;
  phone?: string;
  scope_name?: string;
}
