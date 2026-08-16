/**
 * User CRUD and the account state machine's administrative face — the WHO
 * dimension (Doc 06 §8, Doc 03 §8, Doc 09 §3.3).
 *
 * ## One `PATCH`, two different kinds of change
 *
 * Doc 06 §8 gives a single route for "update, lock, unlock, disable", and
 * Doc 09 §3.3 gives it a single save button, so this service takes one body and
 * splits it. A changed `full_name` or `phone` is an ordinary column write
 * audited as `user.updated`. A changed `status` is a **transition**: it revokes
 * every session the account has and invalidates its cached grants (Doc 03 §6,
 * Doc 04 §7), and it is audited under the auth vocabulary — `auth.account.locked`
 * rather than `user.updated` — because the failed-attempt policy writes the same
 * event from the login path and one event must not have two spellings depending
 * on who tripped it (migration 0014's header).
 *
 * That second half is deliberately **not** implemented here. It lives in
 * `AccountStateService`, beside the login path that enforces it, and this
 * service's job is to establish that the target is the caller's own tenant's
 * user, decide whether the requested transition is one Doc 03 §8 allows, and
 * hand it over.
 *
 * ## Three refusals worth stating, because none of them is a schema rule
 *
 * - **`disabled → active` is refused.** Doc 03 §8 makes `disabled` the
 *   offboarding state, and Doc 06 §8's verbs are "lock, unlock, disable" with no
 *   reactivate among them. Unlock exists for somebody who mistyped their
 *   password six times; walking an offboarded person back through the same
 *   control is not a thing an administrator should be able to do by accident.
 * - **A caller cannot change their own status.** Every transition out of
 *   `active` revokes the actor's own sessions, and `disabled` cannot be undone
 *   through this API at all — so a tenant whose only administrator disabled
 *   themselves would need a platform operator to provision a new one
 *   (`POST /iam/clients/:id/admins`). The rail costs nothing: a second
 *   administrator can always do it, which is also the review the action deserves.
 * - **`is_client_admin` is not writable.** Promoting somebody is an access
 *   grant, and access grants are role bindings (Session 20). Until Session 23
 *   turns tenant administration into an `iam.client.*` binding, this flag *is*
 *   the authorization `assertAdministrator` reads — so a profile form that could
 *   set it would be a privilege-escalation surface disguised as a checkbox.
 *
 * ## What creation deliberately does not do
 *
 * It writes no `user_identity`. A user created here has no credential until they
 * set one through the tokenized reset flow of Doc 03 §7 — which works for any
 * `active` user of an `active` client, credential or not (migration 0014), so
 * creation and invitation are one act and no operator handles anybody else's
 * password. The only place a password is ever accepted is
 * `POST /iam/clients/:id/admins`, where there is nobody yet who could invite the
 * tenant's first administrator.
 *
 * ## Interim authorization, and where tenant isolation actually comes from
 *
 * `assertAdministrator()` in front of every method, replaced in Session 23 by
 * `@RequirePermission('iam.client.user.*')` (`common/administrator.ts`).
 * Isolation does not depend on it: every statement below runs under the
 * request's RLS context and additionally pins `client_id` to the token's `cid`,
 * so another tenant's user is invisible rather than forbidden and comes back as
 * the same 404 a nonexistent id gets (Doc 06 §2).
 */

import { Injectable } from '@nestjs/common';
import {
  UserStatus,
  normalizePagination,
  paginated,
  type Paginated,
  type UserBindingDTO,
  type UserDTO,
  type UserDetailDTO,
} from '@plantops/contracts';
import { IAM_SCHEMA, type VerifiedClaims } from '@plantops/db';
import { AccountStateService } from '../auth/account-state.service';
import { AUDIT_ACTIONS } from '../audit/audit-actions';
import { AuditService } from '../audit/audit.service';
import { assertAdministrator } from '../common/administrator';
import { IamException } from '../common/iam.exception';
import { entityManager } from '../common/transaction-context';
import { rethrowAsConflict } from '../registry/conflict';

const S = `"${IAM_SCHEMA}"`;

const COLUMNS = `id, client_id, email, full_name, phone, status,
                 is_client_admin, created_at, updated_at`;

/**
 * The user's grants, as the Doc 09 §3.3 detail panel renders them.
 *
 * `expired` is computed in SQL rather than from `expires_at` in TypeScript, so
 * that "has this lapsed" is answered by the same clock the resolution engine
 * will use (Doc 04 §4) rather than by whichever machine rendered the response.
 *
 * Ordered by path then role name: the panel groups a person's access by *where*
 * it applies, which is the question somebody reading it is asking.
 */
const BINDINGS = `
  select rb.id, rb.role_id, r.name as role_name,
         rb.scope_node_id, sn.name as scope_node_name,
         sn.path::text as scope_node_path,
         rb.expires_at,
         (rb.expires_at is not null and rb.expires_at <= now()) as expired,
         rb.created_at
    from ${S}."role_binding" rb
    join ${S}."role" r on r.id = rb.role_id
    join ${S}."scope_node" sn on sn.id = rb.scope_node_id
   where rb.client_id = $1 and rb.user_id = $2
   order by sn.path asc, r.name asc, rb.created_at asc
`;

export interface UserRow {
  id: string;
  client_id: string;
  email: string;
  full_name: string;
  phone: string | null;
  status: UserStatus;
  is_client_admin: boolean;
  created_at: Date;
  updated_at: Date;
}

interface BindingRow {
  id: string;
  role_id: string;
  role_name: string;
  scope_node_id: string;
  scope_node_name: string;
  scope_node_path: string;
  expires_at: Date | null;
  expired: boolean;
  created_at: Date;
}

export interface CreateUserInput {
  email: string;
  full_name: string;
  phone?: string;
  status?: UserStatus;
}

export interface UpdateUserInput {
  email?: string;
  full_name?: string;
  phone?: string;
  status?: UserStatus;
}

export interface ListUsersQuery {
  page?: number;
  limit?: number;
  /** Doc 09 §3.3's "Account Locked Users" screen is `status=locked`. */
  status?: UserStatus;
  /** Substring of the address or the name. */
  q?: string;
}

@Injectable()
export class UsersService {
  constructor(
    private readonly audit: AuditService,
    private readonly accountState: AccountStateService,
  ) {}

  /**
   * Creates a user in the caller's own tenant (Doc 06 §8).
   *
   * `client_id` comes from the verified token and from nowhere else, so there is
   * no request in which a caller names the tenant a person lands in.
   *
   * A duplicate address is the 409 `unique (client_id, email)` promises, and
   * naming it is safe: the index is scoped to the caller's own client, so the
   * message reveals only that their own tenant already has the user they just
   * tried to create. Across tenants the same address is a different person and
   * neither learns of the other (Doc 01 §3.6).
   */
  async create(claims: VerifiedClaims, input: CreateUserInput): Promise<UserDTO> {
    await assertAdministrator(claims);

    const status = input.status ?? UserStatus.ACTIVE;

    let rows: UserRow[];
    try {
      rows = (await entityManager().query(
        `insert into ${S}."user" (client_id, email, full_name, phone, status, is_client_admin)
         values ($1, $2, $3, $4, $5::${S}."user_status", false)
         returning ${COLUMNS}`,
        [claims.cid, input.email, input.full_name, input.phone ?? null, status],
      )) as UserRow[];
    } catch (error) {
      rethrowAsConflict(
        error,
        `A user with the email "${input.email}" already exists in this client`,
      );
    }

    const row = rows[0];
    await this.audit.record(
      AUDIT_ACTIONS.USER_CREATED,
      { type: 'user', id: row.id },
      {
        email: row.email,
        full_name: row.full_name,
        status: row.status,
        is_client_admin: false,
        // Stated in the record because it is the thing an operator will ask
        // about later: this account cannot log in until somebody completes the
        // reset flow for it (Doc 03 §7).
        credential: 'none — set through the password reset flow',
      },
    );

    return toDto(row);
  }

  /**
   * The caller's users, filtered and searched (Doc 06 §8).
   *
   * By name rather than newest-first, for the reason `RolesService.list` is: an
   * operator scans this for somebody they already know the name of. The `id` tie
   * break keeps the page boundary stable when two people share a name, which
   * they do more often than a paginated list can afford to ignore.
   */
  async list(
    claims: VerifiedClaims,
    query: ListUsersQuery = {},
  ): Promise<Paginated<UserDTO>> {
    await assertAdministrator(claims);

    const { page, limit } = normalizePagination(query);
    const { where, parameters } = this.filters(claims, query);

    const rows = (await entityManager().query(
      `select ${COLUMNS}
         from ${S}."user"
        where ${where}
        order by full_name asc, id asc
        limit $${parameters.length + 1} offset $${parameters.length + 2}`,
      [...parameters, limit, (page - 1) * limit],
    )) as UserRow[];

    const [count] = (await entityManager().query(
      `select count(*)::int as total from ${S}."user" where ${where}`,
      parameters,
    )) as { total: number }[];

    return paginated(rows.map(toDto), count?.total ?? rows.length, query);
  }

  /**
   * One user, with the grants they hold (Doc 06 §8, Doc 09 §3.3).
   *
   * Returns `null` when no such user is visible to this caller.
   */
  async detail(claims: VerifiedClaims, id: string): Promise<UserDetailDTO | null> {
    await assertAdministrator(claims);

    const row = await this.findRow(claims, id);
    if (row === null) return null;

    return { ...toDto(row), bindings: await this.bindings(claims, row.id) };
  }

  /**
   * Edits the profile, runs the state transition, or both (Doc 06 §8).
   *
   * Order matters and is deliberate: the profile columns are written first, then
   * the transition runs. Both are in the request transaction, so a refused
   * transition takes the profile edit back with it — a `PATCH` that renamed
   * somebody and then declined to disable them would be a half-applied form.
   * Doing it the other way round would revoke the sessions of a request that
   * then failed on a duplicate address.
   *
   * A wholly no-op body writes nothing and audits nothing, for the reason
   * `RolesService.update` gives.
   *
   * Returns `null` when no such user is visible to this caller.
   *
   * @throws {IamException} 409 when the address is taken inside this client,
   * when the transition is one Doc 03 §8 does not allow, or when the caller is
   * the target — see the header.
   */
  async update(
    claims: VerifiedClaims,
    id: string,
    input: UpdateUserInput,
  ): Promise<UserDetailDTO | null> {
    await assertAdministrator(claims);

    const current = await this.findRow(claims, id);
    if (current === null) return null;

    if (input.status !== undefined && input.status !== current.status) {
      this.refuseIllegalTransition(claims, current, input.status);
    }

    await this.writeProfile(claims, current, input);

    if (input.status !== undefined) {
      await this.applyStatus(claims, current, input.status);
    }

    // Re-read rather than assembling the response from the pieces above: the
    // transition wrote `status` (and cleared the failed-attempt counter) inside
    // `AccountStateService`, and a DTO built here would be this service's guess
    // at what that one did.
    const updated = await this.findRow(claims, id);
    return updated === null
      ? null
      : { ...toDto(updated), bindings: await this.bindings(claims, id) };
  }

  /**
   * The user, or `null`. RLS and the explicit `client_id` both confine it to the
   * caller's tenant.
   *
   * Exported for Sessions 19 and 20: the bulk upload has to know whether a row's
   * address is already taken, and binding a subject to a role has to establish
   * that the subject is the caller's own before anchoring a grant to it
   * (Doc 02 §6).
   */
  async findRow(claims: VerifiedClaims, id: string): Promise<UserRow | null> {
    const [row] = (await entityManager().query(
      `select ${COLUMNS} from ${S}."user" where client_id = $1 and id = $2`,
      [claims.cid, id],
    )) as UserRow[];

    return row ?? null;
  }

  /**
   * The grants a user holds, expired ones included and flagged.
   *
   * Public because Doc 09 §3.3's detail screen is not the only reader: Session
   * 20's binding surface answers the same question from the other direction, and
   * the two should agree about what a user's access looks like.
   */
  async bindings(claims: VerifiedClaims, userId: string): Promise<UserBindingDTO[]> {
    const rows = (await entityManager().query(BINDINGS, [
      claims.cid,
      userId,
    ])) as BindingRow[];

    return rows.map(toBindingDto);
  }

  /** `where` and its parameters, shared by the page and its total. */
  private filters(
    claims: VerifiedClaims,
    query: ListUsersQuery,
  ): { where: string; parameters: unknown[] } {
    const conditions = ['client_id = $1'];
    const parameters: unknown[] = [claims.cid];

    if (query.status !== undefined) {
      parameters.push(query.status);
      conditions.push(`status = $${parameters.length}::${S}."user_status"`);
    }

    if (query.q !== undefined) {
      // `%` and `_` escaped, so a search for "a_b" looks for that text rather
      // than for any character between an "a" and a "b". Backslash is `ilike`'s
      // default escape character, so no `escape` clause is needed.
      parameters.push(`%${query.q.replace(/[\\%_]/g, (match) => `\\${match}`)}%`);
      conditions.push(
        `(email ilike $${parameters.length} or full_name ilike $${parameters.length})`,
      );
    }

    return { where: conditions.join(' and '), parameters };
  }

  /**
   * Writes the changed profile columns, and audits the diff.
   *
   * Only genuinely changed fields reach the `update`, so a form re-submitted
   * unchanged writes nothing — `RolesService.update`'s rule, for the same
   * reason: a trail that logs "updated" every time a screen is saved is one
   * nobody can read.
   *
   * `email` is audited with its before and after like any other column, and it
   * is worth noticing that it is not like any other column: it is half the login
   * credential (Doc 03 §3), so this record is the only thing that explains why
   * somebody's address stopped working. Existing sessions are deliberately left
   * alone — a `sid` is not derived from the address, and logging somebody out
   * for a corrected spelling would be a surprise with no security value.
   */
  private async writeProfile(
    claims: VerifiedClaims,
    current: UserRow,
    input: UpdateUserInput,
  ): Promise<void> {
    const assignments: string[] = [];
    const parameters: unknown[] = [claims.cid, current.id];
    const changed: string[] = [];

    const assign = (column: string, value: unknown): void => {
      parameters.push(value);
      assignments.push(`${column} = $${parameters.length}`);
      changed.push(column);
    };

    if (input.email !== undefined && input.email !== current.email) {
      assign('email', input.email);
    }
    if (input.full_name !== undefined && input.full_name !== current.full_name) {
      assign('full_name', input.full_name);
    }
    if (input.phone !== undefined && input.phone !== (current.phone ?? undefined)) {
      assign('phone', input.phone);
    }

    if (assignments.length === 0) return;

    let rows: UserRow[];
    try {
      // Wrapped in a CTE so the statement's command is SELECT: TypeORM's Postgres
      // driver returns `[rows, rowCount]` for a bare `update … returning`.
      rows = (await entityManager().query(
        `with updated as (
           update ${S}."user"
              set ${assignments.join(', ')}
            where client_id = $1 and id = $2
           returning ${COLUMNS}
         )
         select ${COLUMNS} from updated`,
        parameters,
      )) as UserRow[];
    } catch (error) {
      rethrowAsConflict(
        error,
        `A user with the email "${input.email}" already exists in this client`,
      );
    }

    await this.audit.record(
      AUDIT_ACTIONS.USER_UPDATED,
      { type: 'user', id: current.id },
      {
        email: rows[0].email,
        changed,
        before: summarize(current, changed),
        after: summarize(rows[0], changed),
      },
    );
  }

  /**
   * Hands the requested state to the machine that owns it (Doc 03 §8).
   *
   * Every branch is idempotent on the other side — re-applying a state the
   * account already has changes no row and writes no audit record — so the
   * equality check here is about which method to call, not about avoiding a
   * duplicate write.
   */
  private async applyStatus(
    claims: VerifiedClaims,
    current: UserRow,
    status: UserStatus,
  ): Promise<void> {
    if (status === current.status) return;

    switch (status) {
      case UserStatus.LOCKED:
        await this.accountState.lock(claims.cid, current.id);
        return;
      case UserStatus.DISABLED:
        await this.accountState.disable(claims.cid, current.id);
        return;
      case UserStatus.ACTIVE:
        await this.accountState.unlock(claims.cid, current.id);
        return;
    }
  }

  /**
   * The two transitions this API does not perform, refused before anything is
   * written.
   *
   * A 409 rather than a 403 in both cases, because the caller *is* permitted to
   * administer users — this particular change simply contradicts the state the
   * rows are in (Doc 06 §2's conflict).
   */
  private refuseIllegalTransition(
    claims: VerifiedClaims,
    current: UserRow,
    status: UserStatus,
  ): void {
    if (current.id === claims.sub) {
      throw IamException.conflict(
        'You cannot change your own account status. Every transition out of ' +
          '`active` revokes your own sessions, and a disabled account cannot be ' +
          're-enabled through this API — ask another administrator.',
      );
    }

    if (current.status === UserStatus.DISABLED && status === UserStatus.ACTIVE) {
      throw IamException.conflict(
        `"${current.email}" has been disabled, and a disabled account is not ` +
          're-enabled through this API. Offboarding is deliberately one-way ' +
          '(Doc 03 §8); create a new user if this person is returning.',
      );
    }
  }
}

/** The changed fields, by name, for a `before`/`after` payload (Doc 10 §2). */
function summarize(row: UserRow, columns: readonly string[]): Record<string, unknown> {
  const summary: Record<string, unknown> = {};
  for (const column of columns) {
    if (column === 'email') summary['email'] = row.email;
    if (column === 'full_name') summary['full_name'] = row.full_name;
    if (column === 'phone') summary['phone'] = row.phone;
  }
  return summary;
}

function toDto(row: UserRow): UserDTO {
  return {
    id: row.id,
    client_id: row.client_id,
    email: row.email,
    full_name: row.full_name,
    phone: row.phone,
    status: row.status,
    is_client_admin: row.is_client_admin,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}

function toBindingDto(row: BindingRow): UserBindingDTO {
  return {
    id: row.id,
    role_id: row.role_id,
    role_name: row.role_name,
    scope_node_id: row.scope_node_id,
    scope_node_name: row.scope_node_name,
    scope_node_path: row.scope_node_path,
    expires_at: row.expires_at?.toISOString() ?? null,
    expired: row.expired,
    created_at: row.created_at.toISOString(),
  };
}
