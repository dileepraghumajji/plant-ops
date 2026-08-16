/**
 * User contract — the WHO of the access equation (Doc 01 §3.6, Doc 06 §8).
 *
 * A user is a human identity belonging to **exactly one** client. There is no
 * global user and there is not going to be one: `email` is unique per client and
 * login is by `(client_slug, email)` (Doc 03 §3), so the same address is a
 * different person in two tenants and neither of them can see the other.
 *
 * ## No credential is ever on this shape
 *
 * Not the hash — that lives on `user_identity` (Doc 01 §4.6), so an admin list
 * cannot carry one by accident — and not a plaintext password either, because
 * {@link CreateUserRequest} has no password field. A user created here has no
 * credential at all until they set one through the tokenized reset flow of
 * Doc 03 §7, which is the same flow Doc 09 §3.3 puts behind the detail screen's
 * *reset password* button. That makes creation and invitation one act instead of
 * two, and means no operator ever handles somebody else's password.
 *
 * The single exception on the whole surface is `POST /iam/clients/:id/admins`
 * ({@link ClientAdminDTO}), where a platform operator provisions a tenant's very
 * first administrator and there is nobody yet who *could* invite them.
 *
 * ## Status is a state machine, not a field
 *
 * {@link UserStatus} looks like an ordinary enum column and is not: `locked` and
 * `disabled` both force-log-out every session the user has (Doc 03 §6, Doc 04
 * §7), and `disabled` is one-way — an offboarded account is not quietly walked
 * back to `active` through the same control that unlocks a mistyped password.
 * {@link UpdateUserRequest} therefore accepts a status, but the transitions it
 * may express are the ones Doc 03 §8's table allows.
 *
 * Field naming is snake_case, matching every other published shape here.
 */

/**
 * The three account states (Doc 03 §8).
 *
 * | State | Login | Meaning |
 * |---|---|---|
 * | `active` | allowed | the ordinary case |
 * | `locked` | refused `423` | an administrator, or the failed-attempt policy — the "Account Locked Users" list of Doc 09 §3.3 |
 * | `disabled` | refused | offboarded, sessions revoked |
 *
 * Spelled here rather than imported from `@plantops/db`, which contracts must
 * not depend on — it has zero dependencies by design (Doc 08 §3). The Postgres
 * enum is the same three values in the same order, and `libs/db`'s
 * `entities.spec.ts` asserts the two spellings against each other so they cannot
 * drift into a status the API accepts and the column rejects. Same arrangement
 * as {@link ClientStatus} and {@link ServiceAccountStatus}.
 */
export const UserStatus = {
  ACTIVE: 'active',
  LOCKED: 'locked',
  DISABLED: 'disabled',
} as const;
export type UserStatus = (typeof UserStatus)[keyof typeof UserStatus];

export const USER_STATUS_VALUES = [
  UserStatus.ACTIVE,
  UserStatus.LOCKED,
  UserStatus.DISABLED,
] as const satisfies readonly UserStatus[];

/**
 * One user of one tenant (Doc 01 §3.6).
 *
 * `is_client_admin` is published but not settable: it is Doc 01 §3.6's "shortcut
 * flag; still enforced via permissions", the interim stand-in the client-tier
 * services read until Session 23 turns tenant administration into an ordinary
 * `iam.client.*` binding. A screen still has to be able to *show* who holds it —
 * an admin list in which the administrators are indistinguishable is not much of
 * a list — so it is on the read shape and absent from every write one.
 */
export interface UserDTO {
  id: string;
  client_id: string;
  /** Lowercased on write; half of the login credential (Doc 03 §3). */
  email: string;
  full_name: string;
  /** Optional, and reserved for the WhatsApp channel of Doc 03 §10. */
  phone: string | null;
  status: UserStatus;
  /** Interim tenant-administration flag — read-only on this surface. */
  is_client_admin: boolean;
  /** ISO-8601. */
  created_at: string;
  updated_at: string;
}

/**
 * One grant this user holds, as the detail screen's *bindings* sub-panel renders
 * it (Doc 09 §3.3, Doc 01 §4.5).
 *
 * A projection of `role_binding` **from the user's side**, which is why it names
 * no subject: the subject is the user this arrived with. Session 20's
 * `/iam/role-bindings` surface publishes the symmetric shape — one that names
 * the subject and is filterable by role and scope — and the two are deliberately
 * separate: this one exists to answer "what can this person do", and a panel
 * that repeated the person's own id in every row would be answering a question
 * nobody asked.
 *
 * `role_name` and `scope_node_path` are joined in rather than left to the caller
 * to resolve, because a binding rendered as two uuids is not a rendering of
 * anything.
 */
export interface UserBindingDTO {
  /** The `role_binding` row — what `DELETE /iam/role-bindings/:id` takes. */
  id: string;
  role_id: string;
  role_name: string;
  scope_node_id: string;
  scope_node_name: string;
  /** The materialized `ltree` path — `n_<hex>` labels, never display names (Doc 01 §3.5). */
  scope_node_path: string;
  /** ISO-8601, or `null` for a grant that does not expire (Doc 01 §4.5). */
  expires_at: string | null;
  /**
   * Whether {@link expires_at} has passed.
   *
   * Expired bindings are **listed, not hidden**: a grant that lapsed last Friday
   * is the answer to "why did this stop working", and a panel that silently
   * dropped the row would leave that question unanswerable. Resolution ignores
   * them (Doc 04 §4), so the flag is what keeps the screen honest about the
   * difference between held and effective.
   */
  expired: boolean;
  created_at: string;
}

/**
 * `GET /iam/users/:id` — the profile with its grants (Doc 06 §8, Doc 09 §3.3).
 *
 * Bindings are inlined here and deliberately absent from {@link UserDTO}: the
 * list is a page of up to a hundred people and a grant set per row is a payload
 * nobody reads, while the detail screen cannot render without them. The same
 * split {@link RoleDTO} makes for its permission mapping, for the same reason.
 */
export interface UserDetailDTO extends UserDTO {
  bindings: UserBindingDTO[];
}

/**
 * `POST /iam/users` body (Doc 06 §8, Doc 09 §3.3).
 *
 * The client is the caller's own, taken from the token's `cid` and from nowhere
 * else. `is_client_admin` is absent for the reason `is_system` is absent from
 * {@link CreateRoleRequest} — a flag that grants administration is not a field
 * of a create form — and there is no password, for the reason in the header.
 *
 * `status` is Doc 09 §3.3's "initial status", and it is a genuine field rather
 * than a fixed `active`: a tenant onboarding a plant in advance of its opening
 * creates the accounts now and turns them on later, and the alternative — create
 * active, then immediately disable — is two audit records for one intention.
 */
export interface CreateUserRequest {
  email: string;
  full_name: string;
  phone?: string;
  /** Defaults to `active`. */
  status?: UserStatus;
}

/**
 * `PATCH /iam/users/:id` body — Doc 06 §8's "update, lock, unlock, disable".
 *
 * One route for the profile and the state machine, because Doc 06 §8 gives them
 * one, and because they are the same screen's save button (Doc 09 §3.3). What
 * separates them is what happens underneath: a changed `full_name` is an
 * `update`, while a changed `status` runs a transition that revokes sessions and
 * invalidates grants (Doc 03 §8, Doc 04 §7).
 *
 * `email` is editable — it is the only way to correct a typo in an address
 * nobody can log in with, and there is no `DELETE /iam/users/:id` to fall back
 * on (offboarding is `disabled`, so that a person's access history survives
 * them). Changing it changes half the login credential, which is why it is
 * audited with its before and after like any other field.
 *
 * `is_client_admin` is not here. Promoting somebody is an access grant, and
 * access grants are role bindings (Session 20) — routing one through a boolean
 * on a profile form would put the tenant's most consequential change on the
 * screen least likely to be reviewed.
 */
export interface UpdateUserRequest {
  email?: string;
  full_name?: string;
  phone?: string;
  status?: UserStatus;
}
