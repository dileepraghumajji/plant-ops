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

// ── bulk upload (Doc 06 §8, Doc 09 §3.3) ────────────────────────────────────

/**
 * How many data rows one `POST /iam/users/bulk` may carry.
 *
 * The same argument {@link MAX_PERMISSIONS_PER_ROLE} makes: the whole upload is
 * validated and written inside one request transaction, so an unbounded body is
 * an unbounded transaction — and this one holds it open while it writes user
 * rows an administrator is about to start binding roles to.
 *
 * Five hundred rather than two hundred because the thing being uploaded is a
 * staff list rather than a hand-curated selection: a plant's shift roster is a
 * few hundred people, and splitting one onboarding into three files to satisfy a
 * limit is friction with nothing behind it. It is still well inside the 64 kB
 * body ceiling of Doc 06 §1 at any realistic row width, so the request is
 * refused for its row count — which names the problem — rather than for its
 * byte count, which does not.
 */
export const MAX_BULK_USER_ROWS = 500;

/**
 * The two shapes a bulk upload may take (Doc 06 §8's "CSV/JSON").
 *
 * Both arrive as `application/json`, and that is deliberate rather than a
 * compromise. A `multipart/form-data` upload would need a second body parser in
 * front of a surface that has exactly one (`body-parser.middleware.ts`), a
 * second failure taxonomy to translate into the Doc 06 §2 envelope, and a second
 * ceiling to publish — all so that a browser could send bytes it has already
 * read into memory to render the operator's preview. Carrying the CSV as a
 * string inside the JSON envelope keeps one parser, one ceiling and one error
 * shape.
 */
export const BULK_USER_UPLOAD_FORMATS = ['csv', 'json'] as const;
export type BulkUserUploadFormat = (typeof BULK_USER_UPLOAD_FORMATS)[number];

/**
 * The CSV columns a bulk upload is read from, in the order the template writes
 * them.
 *
 * Matching is by header **name**, case- and whitespace-insensitive, never by
 * position: a spreadsheet round-trip reorders columns, and a file whose `phone`
 * column silently became its `status` column is the failure mode a positional
 * reader cannot detect. Columns not named here are ignored, which is the same
 * treatment `z.object` gives an unknown key on the JSON side (`users.dto.ts`).
 *
 * `email` and `full_name` are required *of the header*; `phone` and `status` may
 * be absent entirely, and an empty cell in either is the field being omitted
 * rather than being set to the empty string.
 */
export const BULK_USER_CSV_COLUMNS = [
  'email',
  'full_name',
  'phone',
  'status',
] as const;

/**
 * `POST /iam/users/bulk` body (Doc 06 §8).
 *
 * Discriminated on `format` rather than inferred from which field is present,
 * so an upload that carries neither — or both — is refused by the schema with a
 * message that names the field, instead of being guessed at.
 *
 * The `json` arm's rows are typed as {@link CreateUserRequest} here because that
 * is what a well-formed row *is*. The server-side schema deliberately types the
 * array as unknown and validates each element separately: a body validated
 * element-wise by the pipe would fail the whole request on its first bad row,
 * and the per-row report this endpoint exists to produce would never be reached
 * (see `users.dto.ts`).
 */
export type BulkUserUploadRequest =
  | { format: 'csv'; content: string }
  | { format: 'json'; users: CreateUserRequest[] };

/**
 * What happened to one row (Doc 09 §3.3's "created / skipped / errored").
 *
 * The distinction between the two failures is *whose* problem it is:
 *
 * - `skipped` — the row was well-formed and describes a user who already
 *   exists, either earlier in this same file or already in the tenant. Nothing
 *   is wrong with the file; re-uploading it after adding people is the ordinary
 *   way this endpoint gets used, and every previously-uploaded row skipping is
 *   what makes that safe.
 * - `errored` — the row could not be read as a user at all. It is a defect in
 *   the file, and it is the only status whose rows an operator has to go and
 *   fix.
 */
export const BulkUserRowStatus = {
  CREATED: 'created',
  SKIPPED: 'skipped',
  ERRORED: 'errored',
} as const;
export type BulkUserRowStatus =
  (typeof BulkUserRowStatus)[keyof typeof BulkUserRowStatus];

export const BULK_USER_ROW_STATUS_VALUES = [
  BulkUserRowStatus.CREATED,
  BulkUserRowStatus.SKIPPED,
  BulkUserRowStatus.ERRORED,
] as const satisfies readonly BulkUserRowStatus[];

/**
 * One line of the per-row result report (Doc 06 §8, Doc 09 §3.3).
 *
 * `row` is 1-based and counts **data** rows, so row 1 is the first person in the
 * file whichever format it arrived in — a CSV header is not row 1, and the
 * report an operator reads beside their spreadsheet should not be off by one
 * against it.
 *
 * `email` is echoed as submitted, normalized where it could be parsed and `null`
 * where it could not, because a report keyed only by row number is one an
 * operator has to hold two documents open to read.
 */
export interface BulkUserRowResult {
  row: number;
  email: string | null;
  status: BulkUserRowStatus;
  /**
   * Why, for everything that is not `created`.
   *
   * Always present on `skipped` and `errored` and always absent on `created`:
   * Doc 09 §3.3's report table has a reason column, and a blank cell beside a
   * refusal is the one thing it must never show.
   */
  reason?: string;
  /** The created user's id, or `null` — the handle the UI links the row to. */
  user_id: string | null;
}

/**
 * `POST /iam/users/bulk` → the per-row report and its counts (Doc 06 §8).
 *
 * A `200`, not a `201`, and not a `207`. The request as a whole succeeded — it
 * was read, every row was adjudicated, and the answer is this report — so the
 * status describes the request and the report describes the rows. A `201` would
 * claim a location that does not exist (there are up to
 * {@link MAX_BULK_USER_ROWS} of them), and a `207` is a WebDAV multi-status
 * whose body shape is not this one and which the Doc 06 §2 code table does not
 * contain.
 *
 * ## Partial success, stated precisely
 *
 * Valid rows commit even when others do not. What that means mechanically is
 * that an invalid row is *never attempted*: every row is validated, and every
 * duplicate resolved, before a single insert runs, so the write itself cannot
 * fail on a row's account. The transaction is still all-or-nothing — an
 * unexpected database failure rolls the whole upload back and answers `500`,
 * leaving no half-loaded tenant — and `created` in this report therefore always
 * means committed.
 *
 * `results` covers every row in file order, including the created ones, so the
 * report can be rendered as the file with a verdict column rather than as three
 * separate lists.
 */
export interface BulkUserUploadResponse {
  /** Rows read from the file — the length of {@link results}. */
  total: number;
  created: number;
  skipped: number;
  errored: number;
  results: BulkUserRowResult[];
}

// ── users by role (Doc 06 §8, Doc 09 §3.3) ──────────────────────────────────

/**
 * One place a user holds the role being asked about — Session 34's "scope
 * context".
 *
 * The mirror image of {@link UserBindingDTO}: that one names the role and omits
 * the subject, because it answers "what can this person do"; this one names the
 * scope and omits the role, because it answers "who can do this, and where". A
 * shape that carried both would be `role_binding` itself, which is Session 20's
 * surface and a different question again.
 */
export interface RoleScopeGrantDTO {
  /** The `role_binding` row — what `DELETE /iam/role-bindings/:id` takes. */
  binding_id: string;
  scope_node_id: string;
  scope_node_name: string;
  /** The materialized `ltree` path — `n_<hex>` labels (Doc 01 §3.5). */
  scope_node_path: string;
  expires_at: string | null;
  /** Whether {@link expires_at} has passed — see {@link UserBindingDTO.expired}. */
  expired: boolean;
}

/**
 * `GET /iam/users/by-role/:roleId` — one holder of the role (Doc 06 §8).
 *
 * A user appears **once**, with every scope they hold the role at gathered into
 * {@link scopes}, rather than once per binding. "Who has this role" is a
 * question about people, so somebody granted it at four plants is one row of the
 * answer and not four — and the pagination envelope counts people, which is what
 * a total under a role picker has to mean.
 *
 * Expired bindings are listed and flagged rather than dropped, for the reason
 * {@link UserBindingDTO.expired} gives: a lapsed grant is the answer to "why did
 * this stop working". A holder *all* of whose grants have expired still appears,
 * with every entry flagged.
 */
export interface UserByRoleDTO extends UserDTO {
  scopes: RoleScopeGrantDTO[];
}
