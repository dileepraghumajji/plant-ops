/**
 * Role CRUD and role-permission mapping — the WHAT dimension (Doc 06 §7,
 * Doc 02 §6, Doc 01 §4.2–4.3).
 *
 * ## The one rule this session exists to enforce
 *
 * Doc 02 §6, first bullet: *a role may only map permissions belonging to
 * applications enabled for that role's client*. Nothing in the schema enforces
 * it and nothing can — `role_permission` joins a tenant's role to a **catalog**
 * permission, and the catalog has no `client_id` to compare against (Doc 07 §6).
 * The `client_application` row is the only thing that connects them, so the check
 * is this service's, and {@link RolesService.setPermissions} does it in one
 * statement before it writes anything.
 *
 * ## Enabled at write time, preserved at read time
 *
 * The rule governs the moment a mapping is *created*. It deliberately does not
 * govern the moment one is *read*, because Doc 02 §7 preserves mappings when an
 * application is disabled — they go inert, not away, so that re-enabling is a
 * toggle rather than a re-setup.
 *
 * That distinction has a consequence worth stating, because it is the one place
 * the two rules could be made to contradict each other: a `PUT` that **retains**
 * an already-mapped permission from a since-disabled application is accepted,
 * while one that **adds** it is refused. The alternative — validating the whole
 * submitted set — would mean the first ordinary role edit after an application
 * was disabled either failed with a 409 the operator cannot act on, or silently
 * stripped exactly the mappings Doc 02 §7 promises to keep. So only the diff is
 * validated. Removing is always allowed; nothing about unmapping a permission
 * depends on its application being enabled.
 *
 * ## Delete cascades, and the audit is written first
 *
 * `role_binding.role_id` and `role_permission.role_id` are both `on delete
 * cascade` (migration 0004), so deleting a role revokes every grant made through
 * it. That is the intended behaviour — Doc 06 §7 calls the route "delete
 * (guarded / cascades bindings with audit)" — and it is why
 * {@link RolesService.remove} writes a `role_binding.deleted` record for each
 * binding *before* the delete: afterwards the rows are gone, and a cascade that
 * left no trace of whose access it removed is precisely the audit gap Doc 10 §4
 * exists to close.
 *
 * The guard is `is_system`. A tenant does not delete or rename the role that
 * grants it administration (`client-admin.service.ts`), and the flag is not
 * settable through this API.
 *
 * ## Authorization, and where tenant isolation actually comes from
 *
 * `@RequirePermission('iam.client.role.…')` on the routes, checked by
 * `PermissionGuard` — which resolves grants on its own connection, because at
 * guard time the request transaction that carries the RLS context does not exist
 * yet (`docs/adr/0001-permission-guard-connection-strategy.md`). Renaming and
 * setting a role's permissions carry *different* keys, because they are
 * different powers: one is cosmetic, the other changes what every subject bound
 * to the role may do (`authz/iam-permissions.ts`).
 * Isolation does not depend on it: every statement below runs under the request's
 * RLS context and additionally pins `client_id` to the token's `cid`, so another
 * tenant's role is invisible rather than forbidden and comes back as the same 404
 * a nonexistent id gets (Doc 06 §2).
 *
 * ## Invalidation
 *
 * Two of Doc 04 §7's rows are this service's, and both are *role-level*: editing
 * a role's permissions and deleting a role each change the effective grants of
 * every subject bound to it. That is the widest fan-out in the table, and the
 * only place in the application where the affected set has to be enumerated
 * rather than named — see `authz/invalidation.service.ts` for why enumeration
 * beat a second version counter.
 *
 * The two capture their subjects at different moments, deliberately.
 * `setPermissions` reads them after its write, because nothing it does changes
 * who is bound; `remove` derives them from the binding rows it already read
 * *before* the delete, because `role_binding` cascades and a lookup afterwards
 * would find nobody. Both publish from `afterCommit()`.
 */

import { Injectable } from '@nestjs/common';
import {
  normalizePagination,
  paginated,
  SubjectType,
  type Paginated,
  type RoleDTO,
  type RolePermissionDTO,
  type RolePermissionsResponse,
} from '@plantops/contracts';
import { IAM_SCHEMA, type VerifiedClaims } from '@plantops/db';
import { AUDIT_ACTIONS } from '../audit/audit-actions';
import { AuditService } from '../audit/audit.service';
import {
  GrantInvalidationService,
  type AffectedSubject,
} from '../authz/invalidation.service';
import { IamException } from '../common/iam.exception';
import { afterCommit, entityManager } from '../common/transaction-context';
import { rethrowAsConflict } from '../registry/conflict';

const S = `"${IAM_SCHEMA}"`;

const COLUMNS = `id, client_id, name, description, is_system, created_at, updated_at`;

/** The same columns, qualified — for the reads that carry the Doc 09 §3.2 counts. */
const R_COLUMNS = `r.id, r.client_id, r.name, r.description, r.is_system,
                   r.created_at, r.updated_at`;

/**
 * Doc 09 §3.2's two list columns, as correlated subqueries.
 *
 * Subqueries rather than joins with a `group by`, for the reason
 * `ClientsService`'s `ENABLED_COUNT` gives: two independent counts over two
 * different tables would need two levels of aggregation to avoid multiplying
 * each other's rows, and the planner turns each of these into one index lookup.
 *
 * `bound_subject_count` counts **distinct subjects**, not bindings: one user
 * bound at three plants is one person whose access this role carries, which is
 * what the column is read as. `coalesce` collapses the subject XOR of
 * `role_binding` (Doc 01 §4.5) into whichever of the two columns is set.
 */
const COUNTS = `
  (select count(*)::int from ${S}."role_permission" rp where rp.role_id = r.id)
    as permission_count,
  (select count(distinct coalesce(rb.user_id, rb.service_account_id))::int
     from ${S}."role_binding" rb
    where rb.client_id = r.client_id and rb.role_id = r.id)
    as bound_subject_count
`;

/**
 * A mapped permission with everything the Doc 09 §3.2 picker renders.
 *
 * The `left join` on `client_application` is what makes `application_enabled`
 * honest for the disabled case: there may be **no row at all** for an
 * application that was never enabled, and an inner join would then drop a
 * preserved mapping from the response entirely — reporting the tenant's role as
 * smaller than it is.
 */
const PERMISSION_COLUMNS = `
  p.id, p.key, p.name, p.description, p.is_active,
  a.id as application_id, a.key as application_key, a.name as application_name,
  coalesce(ca.enabled, false) as application_enabled
`;

const PERMISSION_SOURCE = `
  from ${S}."role_permission" rp
  join ${S}."permission" p on p.id = rp.permission_id
  join ${S}."application" a on a.id = p.application_id
  left join ${S}."client_application" ca
    on ca.application_id = a.id and ca.client_id = $2
`;

export interface RoleRow {
  id: string;
  client_id: string;
  name: string;
  description: string | null;
  is_system: boolean;
  created_at: Date;
  updated_at: Date;
}

interface RoleListRow extends RoleRow {
  permission_count: number;
  bound_subject_count: number;
}

interface RolePermissionRow {
  id: string;
  key: string;
  name: string;
  description: string | null;
  is_active: boolean;
  application_id: string;
  application_key: string;
  application_name: string;
  application_enabled: boolean;
}

/** One requested permission id, resolved against the catalog and the tenant. */
interface CandidateRow {
  requested_id: string;
  permission_id: string | null;
  key: string | null;
  is_active: boolean | null;
  application_key: string | null;
  application_is_active: boolean | null;
  application_enabled: boolean;
}

export interface CreateRoleInput {
  name: string;
  description?: string;
}

export interface UpdateRoleInput {
  name?: string;
  description?: string;
}

@Injectable()
export class RolesService {
  constructor(
    private readonly audit: AuditService,
    private readonly invalidation: GrantInvalidationService,
  ) {}

  /**
   * Creates a role for the caller's own tenant (Doc 06 §7).
   *
   * `client_id` comes from the verified token and from nowhere else, so there is
   * no request in which a caller names the tenant a role lands in.
   *
   * A duplicate name is the 409 `unique (client_id, name)` promises, and naming
   * the collided name is safe here in a way it is not on the registry's
   * cross-tenant surfaces: the index is scoped to this caller's own client, so
   * the message reveals only that the caller's own tenant already has a role they
   * just tried to create.
   */
  async create(claims: VerifiedClaims, input: CreateRoleInput): Promise<RoleDTO> {
    let rows: RoleRow[];
    try {
      rows = (await entityManager().query(
        `insert into ${S}."role" (client_id, name, description)
         values ($1, $2, $3)
         returning ${COLUMNS}`,
        [claims.cid, input.name, input.description ?? null],
      )) as RoleRow[];
    } catch (error) {
      rethrowAsConflict(error, `A role named "${input.name}" already exists in this client`);
    }

    const row = rows[0];
    await this.audit.record(
      AUDIT_ACTIONS.ROLE_CREATED,
      { type: 'role', id: row.id },
      { name: row.name, is_system: false },
    );

    // Freshly inserted: nothing maps to it and nothing is bound to it.
    return toDto(row, 0, 0);
  }

  /**
   * The caller's roles, alphabetically (Doc 06 §7).
   *
   * By name rather than newest-first, for the reason `ClientsService.list` is:
   * an operator scans this list for a role they already know the name of. System
   * roles are included — `Client Admin` is a role the tenant has, and hiding it
   * would make the list disagree with the picker every binding screen uses.
   */
  async list(
    claims: VerifiedClaims,
    query: { page?: number; limit?: number } = {},
  ): Promise<Paginated<RoleDTO>> {
    const { page, limit } = normalizePagination(query);

    const rows = (await entityManager().query(
      `select ${R_COLUMNS}, ${COUNTS}
         from ${S}."role" r
        where r.client_id = $1
        order by r.name asc, r.id asc
        limit $2 offset $3`,
      [claims.cid, limit, (page - 1) * limit],
    )) as RoleListRow[];

    const [count] = (await entityManager().query(
      `select count(*)::int as total from ${S}."role" where client_id = $1`,
      [claims.cid],
    )) as { total: number }[];

    return paginated(
      rows.map((row) => toDto(row, row.permission_count, row.bound_subject_count)),
      count?.total ?? rows.length,
      query,
    );
  }

  /**
   * Renames a role, or edits its description (Doc 06 §7).
   *
   * Only genuinely changed fields reach the `update`, and a wholly no-op PATCH
   * writes no audit record — `ClientsService.update`'s rule, for the same reason:
   * a trail that logs "updated" every time a form is re-submitted unchanged is
   * one nobody can read.
   *
   * Returns `null` when no such role is visible to this caller.
   *
   * @throws {IamException} 409 when the role is a system role, or when the new
   * name is already taken in this client.
   */
  async update(
    claims: VerifiedClaims,
    id: string,
    input: UpdateRoleInput,
  ): Promise<RoleDTO | null> {
    const current = await this.findRow(claims, id);
    if (current === null) return null;

    this.refuseSystemRole(current, 'renamed or edited');

    const assignments: string[] = [];
    const parameters: unknown[] = [claims.cid, id];
    const changed: string[] = [];

    const assign = (column: string, value: unknown): void => {
      parameters.push(value);
      assignments.push(`${column} = $${parameters.length}`);
      changed.push(column);
    };

    if (input.name !== undefined && input.name !== current.name) {
      assign('name', input.name);
    }
    if (
      input.description !== undefined &&
      input.description !== (current.description ?? undefined)
    ) {
      assign('description', input.description);
    }

    if (assignments.length === 0) return this.toDtoWithCounts(claims, current);

    let rows: RoleRow[];
    try {
      // Wrapped in a CTE so the statement's command is SELECT: TypeORM's Postgres
      // driver returns `[rows, rowCount]` for a bare `update … returning`.
      rows = (await entityManager().query(
        `with updated as (
           update ${S}."role"
              set ${assignments.join(', ')}
            where client_id = $1 and id = $2
           returning ${COLUMNS}
         )
         select ${COLUMNS} from updated`,
        parameters,
      )) as RoleRow[];
    } catch (error) {
      rethrowAsConflict(
        error,
        `A role named "${input.name}" already exists in this client`,
      );
    }

    const row = rows[0];
    await this.audit.record(
      AUDIT_ACTIONS.ROLE_UPDATED,
      { type: 'role', id: row.id },
      {
        name: row.name,
        changed,
        before: summarize(current, changed),
        after: summarize(row, changed),
      },
    );

    return this.toDtoWithCounts(claims, row);
  }

  /**
   * Deletes a role, and with it every grant made through it (Doc 06 §7).
   *
   * Returns `false` when no such role is visible to this caller.
   *
   * The bindings are read and audited **before** the delete, one
   * `role_binding.deleted` record each, because after the cascade there is
   * nothing left to say whose access was removed. Both statements are in the
   * request transaction, so a failure anywhere leaves the role and its grants
   * exactly as they were — and, in the other direction, an audit row cannot
   * survive a delete that rolled back.
   *
   * `role_permission` cascades too and gets a count in the `role.deleted` record
   * rather than a record per row: a mapping is a statement about the role, which
   * is the thing being deleted, while a binding is a statement about a *subject*,
   * whose access history has to name it.
   *
   * @throws {IamException} 409 when the role is a system role.
   */
  async remove(claims: VerifiedClaims, id: string): Promise<boolean> {
    const role = await this.findRow(claims, id);
    if (role === null) return false;

    this.refuseSystemRole(role, 'deleted');

    const bindings = (await entityManager().query(
      `select rb.id, rb.user_id, rb.service_account_id, rb.scope_node_id,
              sn.path::text as scope_node_path, rb.expires_at
         from ${S}."role_binding" rb
         join ${S}."scope_node" sn on sn.id = rb.scope_node_id
        where rb.client_id = $1 and rb.role_id = $2
        order by rb.created_at asc, rb.id asc`,
      [claims.cid, id],
    )) as {
      id: string;
      user_id: string | null;
      service_account_id: string | null;
      scope_node_id: string;
      scope_node_path: string;
      expires_at: Date | null;
    }[];

    const [{ mapped }] = (await entityManager().query(
      `select count(*)::int as mapped from ${S}."role_permission" where role_id = $1`,
      [id],
    )) as { mapped: number }[];

    // Doc 04 §7, "role deleted → all subjects bound to that role". Captured
    // here, before the `DELETE` below, and this is the ordering that matters:
    // `role_binding` cascades on the role's foreign key (migration 0004), so a
    // lookup afterwards would find an empty set and invalidate nobody — every
    // one of these people would keep the deleted role's permissions until their
    // cache entry expired.
    //
    // Derived from `bindings` rather than queried again: those rows are the
    // cascade, they were read in the same transaction, and asking twice would
    // let the audit trail and the invalidation disagree about who was affected.
    const subjects = affectedSubjects(bindings);

    // One statement for the whole cascade, however wide it is: the role row is
    // still present and lockable until the delete below, so the interval this
    // holds it for should not scale with the number of subjects bound to it.
    await this.audit.recordMany(
      bindings.map((binding) => ({
        action: AUDIT_ACTIONS.ROLE_BINDING_DELETED,
        target: { type: 'role_binding' as const, id: binding.id },
        payload: {
          user_id: binding.user_id,
          service_account_id: binding.service_account_id,
          role_id: role.id,
          role_name: role.name,
          scope_node_id: binding.scope_node_id,
          scope_node_path: binding.scope_node_path,
          // The reason, stated in the record: this binding was not unbound by
          // anyone, it went with the role. Without it the trail shows a grant
          // disappearing with no act that removed it.
          cause: AUDIT_ACTIONS.ROLE_DELETED,
        },
      })),
    );

    await entityManager().query(
      `delete from ${S}."role" where client_id = $1 and id = $2`,
      [claims.cid, id],
    );

    await this.audit.record(
      AUDIT_ACTIONS.ROLE_DELETED,
      { type: 'role', id: role.id },
      {
        name: role.name,
        /** Rows `role_permission`'s cascade removed. */
        permissions_unmapped: mapped,
        /** Grants revoked, each with its own record above. */
        bindings_deleted: bindings.length,
      },
    );

    afterCommit(() =>
      this.invalidation.publish(claims.cid, subjects, {
        cause: 'role.deleted',
        roleId: role.id,
      }),
    );

    return true;
  }

  /**
   * The role's whole permission set (Doc 06 §7).
   *
   * Returns `null` when no such role is visible to this caller. Inert mappings
   * are included and flagged rather than filtered — see the header, and
   * {@link RolePermissionDTO}.
   */
  async permissions(
    claims: VerifiedClaims,
    id: string,
  ): Promise<RolePermissionsResponse | null> {
    const role = await this.findRow(claims, id);
    if (role === null) return null;

    return { role_id: role.id, permissions: await this.mappedPermissions(claims, role.id) };
  }

  /**
   * Replaces the role's permission set (Doc 06 §7, Doc 02 §6).
   *
   * The diff is computed first, then validated, then written — in that order,
   * and the order is the whole of the "no partial write" acceptance criterion.
   * Every candidate is checked in one statement before any row is touched, so a
   * body whose hundredth id names a disabled application's permission changes
   * nothing at all. (The request transaction would roll a partial write back
   * regardless; refusing before writing means the 409 is not also a rollback of
   * work the caller cannot see.)
   *
   * Idempotent: re-submitting the current set writes nothing and audits nothing,
   * for the reason a no-op `PATCH` does not audit.
   *
   * Returns `null` when no such role is visible to this caller.
   *
   * @throws {IamException} 409 when an id names no permission, or names one
   * whose application is not enabled for this client, is globally deactivated, or
   * whose own `is_active` is false.
   */
  async setPermissions(
    claims: VerifiedClaims,
    id: string,
    permissionIds: readonly string[],
  ): Promise<RolePermissionsResponse | null> {
    const role = await this.findRow(claims, id);
    if (role === null) return null;

    const current = (await entityManager().query(
      `select permission_id from ${S}."role_permission" where role_id = $1`,
      [role.id],
    )) as { permission_id: string }[];

    const held = new Set(current.map((row) => row.permission_id));
    const desired = new Set(permissionIds);

    const toAdd = [...desired].filter((permissionId) => !held.has(permissionId));
    const toRemove = [...held].filter((permissionId) => !desired.has(permissionId));

    // Only the additions are validated. Retaining an inert mapping and removing
    // anything at all are both always legal — see the header.
    const added = await this.validateAdditions(claims, toAdd);

    if (toRemove.length > 0) {
      await entityManager().query(
        `delete from ${S}."role_permission"
          where role_id = $1 and permission_id = any($2::uuid[])`,
        [role.id, toRemove],
      );
    }

    if (toAdd.length > 0) {
      await entityManager().query(
        `insert into ${S}."role_permission" (role_id, permission_id)
         select $1, id from unnest($2::uuid[]) as requested(id)`,
        [role.id, toAdd],
      );
    }

    const mapped = await this.mappedPermissions(claims, role.id);

    if (toAdd.length > 0 || toRemove.length > 0) {
      const removedKeys = await this.keysOf(toRemove);
      await this.audit.record(
        // The target is the **role**, not the mapping: `role_permission` rows
        // have no id of their own, and "what happened to this role" is the query
        // an operator runs. `role_permission.set` on the action side already says
        // which of the role's aspects changed (Doc 10 §2).
        AUDIT_ACTIONS.ROLE_PERMISSION_SET,
        { type: 'role', id: role.id },
        {
          role_name: role.name,
          // The diff rather than the resulting set: a compact payload (Doc 10 §2)
          // and the thing an auditor is actually asking about — what this role
          // gained and lost.
          //
          // Sorted, like `removed`, because the alternative is the order a join
          // over `unnest` happened to return — which is the planner's business,
          // not the caller's, and would make two identical edits produce two
          // differently-ordered records.
          added: added.map((permission) => permission.key).sort(),
          removed: removedKeys,
          total: mapped.length,
        },
      );

      // Doc 04 §7, "role_permission changed → all subjects bound to that role".
      // Inside the `if`, so an idempotent re-submission of the current set
      // invalidates nothing — the same condition that governs whether this is an
      // audited event at all. A no-op edit that flushed every holder's cache
      // would make the Doc 09 §3.2 permission picker's save button a
      // denial-of-service on the tenant's own hot path.
      //
      // Enumerated after the write rather than before it, unlike `remove`:
      // nothing here cascades, so the set of bound subjects is the same on both
      // sides of the statement, and reading it later keeps it next to the
      // publish it feeds.
      const subjects = await this.invalidation.subjectsBoundToRole(claims.cid, role.id);
      afterCommit(() =>
        this.invalidation.publish(claims.cid, subjects, {
          cause: 'role_permission.changed',
          roleId: role.id,
        }),
      );
    }

    return { role_id: role.id, permissions: mapped };
  }

  /**
   * The role, or `null`. RLS and the explicit `client_id` both confine it to the
   * caller's tenant.
   *
   * Exported for Session 20: binding a subject to a role has to establish that
   * the role is the caller's own before anchoring a grant to it (Doc 02 §6).
   */
  async findRow(claims: VerifiedClaims, id: string): Promise<RoleRow | null> {
    const [row] = (await entityManager().query(
      `select ${COLUMNS} from ${S}."role" where client_id = $1 and id = $2`,
      [claims.cid, id],
    )) as RoleRow[];

    return row ?? null;
  }

  /**
   * Checks every id that is about to become a new mapping, in one statement.
   *
   * The `left join` chain is what makes the four failure modes distinguishable:
   * an id that names no permission at all, one whose application is globally
   * deactivated (Doc 02 §7), one whose application was never enabled for this
   * client or is currently disabled (Doc 02 §6), and one whose own `is_active` is
   * false. They get different messages because they need different fixes — enable
   * the application, or stop mapping a retired key — and a single "invalid
   * permission" would send an operator to the wrong one.
   *
   * Nothing here leaks across tenants: `permission` and `application` are catalog
   * tables, globally readable by any authenticated subject (Doc 07 §6), so naming
   * a key tells the caller nothing they could not read from
   * `GET /iam/applications/:id/permissions`. The only tenant-scoped fact involved
   * is `client_application`, which is the caller's own.
   *
   * @throws {IamException} 409 on the first candidate that fails.
   */
  private async validateAdditions(
    claims: VerifiedClaims,
    ids: readonly string[],
  ): Promise<{ id: string; key: string }[]> {
    if (ids.length === 0) return [];

    const candidates = (await entityManager().query(
      `select requested.id as requested_id,
              p.id as permission_id, p.key, p.is_active,
              a.key as application_key, a.is_active as application_is_active,
              coalesce(ca.enabled, false) as application_enabled
         from unnest($1::uuid[]) as requested(id)
         left join ${S}."permission" p on p.id = requested.id
         left join ${S}."application" a on a.id = p.application_id
         left join ${S}."client_application" ca
           on ca.application_id = p.application_id and ca.client_id = $2`,
      [[...ids], claims.cid],
    )) as CandidateRow[];

    for (const candidate of candidates) {
      if (candidate.permission_id === null) {
        throw IamException.conflict(
          `No permission with the id ${candidate.requested_id} exists in the catalog`,
        );
      }
      if (candidate.application_is_active !== true) {
        throw IamException.conflict(
          `The permission "${candidate.key}" belongs to the application ` +
            `"${candidate.application_key}", which is deactivated platform-wide`,
        );
      }
      if (!candidate.application_enabled) {
        throw IamException.conflict(
          `The permission "${candidate.key}" belongs to the application ` +
            `"${candidate.application_key}", which is not enabled for this client. ` +
            'Ask a platform administrator to enable it first.',
        );
      }
      if (candidate.is_active !== true) {
        throw IamException.conflict(
          `The permission "${candidate.key}" has been retired from the ` +
            `"${candidate.application_key}" catalog and can no longer be mapped`,
        );
      }
    }

    return candidates.map((candidate) => ({
      id: candidate.permission_id as string,
      key: candidate.key as string,
    }));
  }

  /** The role's mappings, ordered the way the Doc 09 §3.2 picker groups them. */
  private async mappedPermissions(
    claims: VerifiedClaims,
    roleId: string,
  ): Promise<RolePermissionDTO[]> {
    const rows = (await entityManager().query(
      `select ${PERMISSION_COLUMNS}
       ${PERMISSION_SOURCE}
        where rp.role_id = $1
        order by a.key asc, p.key asc`,
      [roleId, claims.cid],
    )) as RolePermissionRow[];

    return rows.map(toPermissionDto);
  }

  /** The keys behind a set of ids, for an audit payload a person can read. */
  private async keysOf(ids: readonly string[]): Promise<string[]> {
    if (ids.length === 0) return [];

    const rows = (await entityManager().query(
      `select key from ${S}."permission" where id = any($1::uuid[]) order by key asc`,
      [[...ids]],
    )) as { key: string }[];

    return rows.map((row) => row.key);
  }

  /** The counts Doc 09 §3.2 lists, for a single role that has just been written. */
  private async toDtoWithCounts(
    claims: VerifiedClaims,
    row: RoleRow,
  ): Promise<RoleDTO> {
    const [counts] = (await entityManager().query(
      `select ${COUNTS} from ${S}."role" r where r.client_id = $1 and r.id = $2`,
      [claims.cid, row.id],
    )) as { permission_count: number; bound_subject_count: number }[];

    return toDto(row, counts?.permission_count ?? 0, counts?.bound_subject_count ?? 0);
  }

  /**
   * Refuses an edit to a platform-seeded role.
   *
   * A 409 rather than a 403, because the caller *is* permitted to administer
   * roles — this one simply is not theirs to restructure (Doc 06 §2's conflict:
   * the request contradicts existing data). Mapping permissions is the deliberate
   * exception and does not come through here: `client-admin.service.ts` maps the
   * `Client Admin` role to the IAM's own `iam.client.*` catalog when it creates
   * it, through ordinary `role_permission` rows.
   */
  private refuseSystemRole(role: RoleRow, attempted: string): void {
    if (role.is_system) {
      throw IamException.conflict(
        `"${role.name}" is a system role and cannot be ${attempted}. ` +
          'It is what grants this client its administration.',
      );
    }
  }
}

/** The changed fields, by name, for a `before`/`after` payload (Doc 10 §2). */
function summarize(row: RoleRow, columns: readonly string[]): Record<string, unknown> {
  const summary: Record<string, unknown> = {};
  for (const column of columns) {
    if (column === 'name') summary['name'] = row.name;
    if (column === 'description') summary['description'] = row.description;
  }
  return summary;
}

function toDto(
  row: RoleRow,
  permissionCount: number,
  boundSubjectCount: number,
): RoleDTO {
  return {
    id: row.id,
    client_id: row.client_id,
    name: row.name,
    description: row.description,
    is_system: row.is_system,
    permission_count: permissionCount,
    bound_subject_count: boundSubjectCount,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}

/**
 * The distinct subjects behind a set of cascaded bindings (Doc 04 §7).
 *
 * Deduplicated, because one person bound to the same role at three plants is
 * three rows and one cache entry. `AffectedSubject`'s two fields are the whole
 * key, so a `Map` over the pair is the identity — and the XOR that migration
 * 0004 enforces is what makes reading whichever column is populated total.
 */
function affectedSubjects(
  bindings: readonly { user_id: string | null; service_account_id: string | null }[],
): AffectedSubject[] {
  const distinct = new Map<string, AffectedSubject>();

  for (const binding of bindings) {
    const subject: AffectedSubject =
      binding.user_id === null
        ? { type: SubjectType.SERVICE, id: binding.service_account_id as string }
        : { type: SubjectType.USER, id: binding.user_id };
    distinct.set(`${subject.type}:${subject.id}`, subject);
  }

  return [...distinct.values()];
}

function toPermissionDto(row: RolePermissionRow): RolePermissionDTO {
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    description: row.description,
    is_active: row.is_active,
    application_id: row.application_id,
    application_key: row.application_key,
    application_name: row.application_name,
    application_enabled: row.application_enabled,
  };
}
