/**
 * Role-binding contract — WHO × WHAT × WHERE in one row (Doc 01 §4.5,
 * Doc 06 §9, Doc 09 §3.4).
 *
 * The other three client-tier contracts each describe one dimension: a
 * {@link UserDTO} or a {@link ServiceAccountDTO} is a WHO, a {@link RoleDTO} is
 * a bundle of WHATs, a {@link ScopeNodeDTO} is a WHERE. None of them grants
 * anything. A binding is the only shape in the system that does, and everything
 * below follows from that.
 *
 * ## One subject, expressed as one pair
 *
 * The table carries two nullable subject columns with a check constraint making
 * exactly one of them set (Doc 01 §4.5, migration 0004). That is the right shape
 * for a schema — a subject is genuinely a user *or* a service account, with a
 * foreign key each — and the wrong shape for a response: a consumer that had to
 * test which of two fields was populated would be re-deriving, in every client,
 * what the constraint already guarantees. So {@link RoleBindingDTO} publishes
 * {@link RoleBindingDTO.subject_type} and {@link RoleBindingDTO.subject_id},
 * which is the same collapse the duplicate-prevention index makes with its
 * `coalesce(user_id, service_account_id)`.
 *
 * {@link CreateRoleBindingRequest} goes the other way and keeps the two columns
 * apart, because a request is where the XOR is *decided* rather than reported —
 * a `subject_type` discriminator there would let a caller name a user id and
 * label it a service account, and the resulting 409 would be about the wrong
 * thing.
 *
 * ## Expiry does not remove a binding from this surface
 *
 * `expires_at` is enforced at resolve time (Doc 04 §4.1) and nowhere else: a
 * lapsed grant stops granting and stays a row. So expired bindings are listed
 * and flagged rather than filtered, for the reason {@link UserBindingDTO.expired}
 * gives — "why did this stop working last Friday" is a question only the row can
 * answer — and because Doc 01 §4.5 makes time passing a thing that fires no
 * event at all.
 *
 * Field naming is snake_case, matching every other published shape here.
 */

import type { SubjectType } from './jwt.js';
import type { PaginationQuery } from './pagination.js';

/**
 * One grant (Doc 01 §4.5).
 *
 * The names beside every id — `role_name`, `scope_node_name`, `subject_name` —
 * are joined in rather than left to the caller, for the reason
 * {@link UserBindingDTO} gives: a binding rendered as four uuids is not a
 * rendering of anything, and Doc 09 §3.4's list is the screen an operator
 * reviews access on.
 */
export interface RoleBindingDTO {
  /** The row `DELETE /iam/role-bindings/:id` takes. */
  id: string;
  client_id: string;
  /** Which of the two subject columns is set — see the header. */
  subject_type: SubjectType;
  /** The `user` or `service_account` id, whichever {@link subject_type} names. */
  subject_id: string;
  /** `user.full_name` or `service_account.name`. */
  subject_name: string;
  /** The user's address; `null` for a service account, which has none. */
  subject_email: string | null;
  role_id: string;
  role_name: string;
  scope_node_id: string;
  scope_node_name: string;
  /** The materialized `ltree` path — `n_<hex>` labels, never display names (Doc 01 §3.5). */
  scope_node_path: string;
  /** ISO-8601, or `null` for a grant that does not expire. */
  expires_at: string | null;
  /** Whether {@link expires_at} has passed — see the header. */
  expired: boolean;
  created_at: string;
}

/**
 * `POST /iam/role-bindings` body (Doc 06 §9, Doc 09 §3.4).
 *
 * Doc 09 §3.4's single action: pick a subject, pick a role, pick a scope node,
 * optionally set an expiry.
 *
 * `client_id` is absent, like everywhere else on the client tier: the tenant is
 * the token's `cid`, and every one of the three ids is checked against it before
 * a row is written (Doc 02 §6). Naming a role, node or subject from another
 * client is a `409`, indistinguishable from naming one that does not exist —
 * a binding request must not become a way to enumerate another tenant.
 *
 * Exactly one of {@link user_id} / {@link service_account_id}. Neither and both
 * are `400`s: the body is malformed in a way no row could settle, so it is
 * refused by the schema rather than by the check constraint.
 *
 * `expires_at` is ISO-8601 and must be in the future. A grant that lapsed before
 * it was written grants nothing from the instant it exists, which is never what
 * the operator meant.
 */
export interface CreateRoleBindingRequest {
  user_id?: string;
  service_account_id?: string;
  role_id: string;
  scope_node_id: string;
  /** ISO-8601, in the future. Omit for a grant that does not expire. */
  expires_at?: string;
}

/**
 * `GET /iam/role-bindings` query (Doc 06 §9, Doc 09 §3.4).
 *
 * Doc 06 §9's "filter by user, role, scope", with the subject split into its two
 * columns for the reason {@link CreateRoleBindingRequest} splits them.
 *
 * `scope_node_id` matches the node the binding is **anchored to**, not the
 * subtree it covers. The two are different questions — "what was granted here"
 * against "who can act here" — and only the first is a list of bindings; the
 * second is `POST /iam/permissions/check` (Doc 06 §11), which answers it for a
 * subject rather than by enumerating rows.
 *
 * Every filter is combined with `and`, so an unfiltered call is the tenant's
 * whole grant table and a fully filtered one is the duplicate check an operator
 * can run before binding.
 */
export interface RoleBindingsQuery extends PaginationQuery {
  user_id?: string;
  service_account_id?: string;
  role_id?: string;
  scope_node_id?: string;
}
