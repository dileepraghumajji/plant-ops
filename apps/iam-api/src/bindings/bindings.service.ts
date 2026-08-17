/**
 * Role bindings — the write path for WHO × WHAT × WHERE (Doc 06 §9, Doc 01 §4.5,
 * Doc 02 §6, Doc 09 §3.4).
 *
 * Every other client-tier surface builds one dimension of the access equation
 * and grants nothing: `/iam/scopes` shapes the WHERE, `/iam/roles` bundles the
 * WHAT, `/iam/users` and `/iam/service-accounts` register the WHO. This is where
 * they meet, and it is the only endpoint in the system whose success gives
 * somebody access to something. Everything below is arranged around that.
 *
 * ## Four ids, one tenant, and the rule the schema cannot state
 *
 * Doc 02 §6's three binding rules — the node belongs to the role's client, the
 * user belongs to their own client, platform authority stays outside the
 * tenant's binding space — are *mostly* the database's. Migration 0004 gives
 * `role_binding` composite foreign keys `(user_id, client_id)`,
 * `(role_id, client_id)` and `(scope_node_id, client_id)` against the
 * `unique (id, client_id)` indexes of migration 0003, so a row naming another
 * tenant's role, node or user cannot be written whatever this service believes.
 *
 * Two things are left over, and they are why {@link BindingsService.create}
 * resolves all three ids before it writes anything:
 *
 * - **The service-account arm has no composite key.** It cannot: a platform
 *   account's `client_id` is null (Doc 01 §3.7) and a composite key would make
 *   the bootstrap identity unbindable at the platform root, which is the one
 *   binding that has to exist for the platform to administer anything. Migration
 *   0004 says so at the constraint and hands the check here.
 *   {@link ServiceAccountsService.findRow} is that check.
 * - **A foreign-key violation is the wrong answer.** It arrives as SQLSTATE
 *   23503 with a constraint name in it, which either leaks the schema or becomes
 *   the filter's generic 500. Resolving first turns all three into a `409` whose
 *   message names *which* of the four ids the caller cannot use — and, crucially,
 *   says nothing about whether it exists somewhere else.
 *
 * ## Why every cross-tenant refusal is the same 409
 *
 * A role id from another client and a role id from nowhere at all produce byte
 * identical responses. That is Doc 06 §2's rule — "denials never reveal whether
 * the target exists across tenants" — and it matters more here than on a read
 * surface: `POST /iam/role-bindings` takes four ids and reports on each, so a
 * message that distinguished "not yours" from "not real" would turn this
 * endpoint into an oracle for enumerating every other tenant's roles, nodes and
 * people, one uuid at a time. The messages below therefore commit to neither,
 * exactly as `ScopesService.pathForNewNode` does for a foreign `parent_id`.
 *
 * A 409 rather than a 404 because nothing is missing from the *caller's* world
 * view — they named an id that does not belong to their tenant, which is
 * Doc 06 §2's "cross-tenant violation", filed next to the duplicate key.
 * `DELETE` is the exception and is a 404: there the id is the resource, and a
 * binding that is not the caller's is simply not there.
 *
 * ## Duplicates, and the one duplicate that is not one
 *
 * `role_binding_subject_role_scope_key` — unique over
 * `(coalesce(user_id, service_account_id), role_id, scope_node_id)` — makes a
 * second identical grant a 409. Binding the same subject and role at an
 * **ancestor and a descendant** is deliberately *not* a duplicate (Doc 01 §4.5):
 * the ancestor already covers the descendant, so the second row grants nothing
 * new, but it is also not a mistake — an admin who grants at Plant A and later
 * at the whole region has expressed two intentions, and resolution dedupes the
 * covering paths rather than the rows (Doc 04 §4.1). Refusing it here would mean
 * deleting the regional grant silently revoked the plant one.
 *
 * ## Expiry
 *
 * Stored, never swept. `expires_at` is enforced at resolve time (Doc 04 §4.1)
 * and fires no event when it passes — "time simply passing cannot trigger a
 * hook" (Doc 01 §4.5) — so an expired binding is a row that stopped granting and
 * stayed. Both reads below list it and flag it rather than filtering it, because
 * "why did this stop working" is a question only the row can answer. Session 22
 * added the periodic sweep (`authz/expiry-sweep.job.ts`) that invalidates the
 * cache for newly-lapsed grants and audits `role_binding.expired` — the row
 * stays exactly as it is, and `expiry_swept_at` records only that the system
 * noticed.
 *
 * ## Invalidation
 *
 * Doc 04 §7's first row: a binding created or deleted invalidates *that
 * subject*. Published through {@link GrantInvalidationService} from
 * `afterCommit()`, never inline — a grant announced before its transaction
 * commits lets a reader repopulate its cache from pre-change state, which is the
 * failure Doc 04 §7.1 describes at its worst and which applies here in its
 * ordinary form.
 *
 * ## Authorization, and where tenant isolation actually comes from
 *
 * `@RequirePermission('iam.client.binding.…')` on the routes, checked by
 * `PermissionGuard` before this service runs (Session 23). `POST` additionally
 * names its target node with `scopeFrom: 'body.scope_node_id'`, so an admin may
 * only grant *where they themselves hold the permission* — a plant coordinator
 * bound at Plant B cannot bind anybody at Plant A, which is the whole point of
 * the WHERE dimension applied to the surface that creates it.
 *
 * Isolation does not depend on any of that: every statement below runs under the
 * request's RLS context and additionally pins `client_id` to the token's `cid`.
 */

import { Injectable } from '@nestjs/common';
import {
  SubjectType,
  normalizePagination,
  paginated,
  type Paginated,
  type RoleBindingDTO,
  type RoleBindingsQuery,
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
import { RolesService } from '../roles/roles.service';
import { ScopesService } from '../scopes/scopes.service';
import { ServiceAccountsService } from '../service-accounts/service-accounts.service';
import { UsersService } from '../users/users.service';

const S = `"${IAM_SCHEMA}"`;

/**
 * Everything Doc 09 §3.4's list renders, in one row.
 *
 * `expired` is computed in SQL rather than from `expires_at` in TypeScript, so
 * that "has this lapsed" is answered by the same clock the resolution engine
 * uses (Doc 04 §4) rather than by whichever machine rendered the response —
 * `UsersService`'s bindings panel makes the same choice, and the two views of one
 * row must not disagree about whether it still grants anything.
 *
 * `subject_name` collapses the subject XOR with `coalesce`, the way the
 * duplicate-prevention index does. It cannot be null in a row this surface can
 * return: the user join is pinned to the same tenant as the binding, and a
 * service account visible to a tenant caller is one of its own.
 */
const COLUMNS = `
  rb.id, rb.client_id,
  rb.user_id, rb.service_account_id,
  coalesce(u.full_name, sa.name) as subject_name,
  u.email as subject_email,
  rb.role_id, r.name as role_name,
  rb.scope_node_id, sn.name as scope_node_name, sn.path::text as scope_node_path,
  rb.expires_at,
  (rb.expires_at is not null and rb.expires_at <= now()) as expired,
  rb.created_at
`;

/**
 * The joins behind {@link COLUMNS}.
 *
 * The role and node joins are inner and the two subject joins are outer, which
 * is exactly the shape of the constraints: a binding always has a role and a
 * node, and has precisely one of the two subjects.
 *
 * Each join carries `client_id` alongside the id — redundant against the
 * composite foreign keys, and kept because it lets the planner use the same
 * tenant-scoped indexes the RLS predicate already narrows to, and because a
 * future join written by copying this one inherits the pinning rather than
 * relying on a constraint the author has to know about. The service-account join
 * cannot: its `client_id` is nullable by design.
 */
const SOURCE = `
  from ${S}."role_binding" rb
  join ${S}."role" r
    on r.id = rb.role_id and r.client_id = rb.client_id
  join ${S}."scope_node" sn
    on sn.id = rb.scope_node_id and sn.client_id = rb.client_id
  left join ${S}."user" u
    on u.id = rb.user_id and u.client_id = rb.client_id
  left join ${S}."service_account" sa
    on sa.id = rb.service_account_id
`;

interface BindingRow {
  id: string;
  client_id: string;
  user_id: string | null;
  service_account_id: string | null;
  subject_name: string;
  subject_email: string | null;
  role_id: string;
  role_name: string;
  scope_node_id: string;
  scope_node_name: string;
  scope_node_path: string;
  expires_at: Date | null;
  expired: boolean;
  created_at: Date;
}

export interface CreateBindingInput {
  user_id?: string;
  service_account_id?: string;
  role_id: string;
  scope_node_id: string;
  /** ISO-8601, already checked to be in the future by the DTO. */
  expires_at?: string;
}

/** A resolved subject — the id, which column it goes in, and its display name. */
interface ResolvedSubject {
  type: SubjectType;
  id: string;
  name: string;
}

@Injectable()
export class BindingsService {
  constructor(
    private readonly audit: AuditService,
    private readonly invalidation: GrantInvalidationService,
    private readonly users: UsersService,
    private readonly serviceAccounts: ServiceAccountsService,
    private readonly roles: RolesService,
    private readonly scopes: ScopesService,
  ) {}

  /**
   * Grants a role to a subject at a scope node (Doc 06 §9, Doc 09 §3.4).
   *
   * The three references are resolved before anything is written, in the order a
   * reader of the response would want them checked: subject, role, node. Each is
   * a read under the caller's own RLS context pinned to `claims.cid`, so a
   * foreign id is invisible rather than forbidden and comes back as a 409 that
   * commits to nothing about where it does exist — see the header.
   *
   * `client_id` on the inserted row is the token's `cid` and nothing else, so
   * there is no request in which a caller names the tenant a grant lands in.
   *
   * @throws {IamException} 409 when any of the three ids is not this client's,
   * or when the subject already holds this role at this node.
   */
  async create(
    claims: VerifiedClaims,
    input: CreateBindingInput,
  ): Promise<RoleBindingDTO> {
    const subject = await this.resolveSubject(claims, input);

    const role = await this.roles.findRow(claims, input.role_id);
    if (role === null) {
      throw IamException.conflict('The role does not belong to this client');
    }

    const node = await this.scopes.findRow(claims, input.scope_node_id);
    if (node === null) {
      throw IamException.conflict('The scope node does not belong to this client');
    }

    let rows: { id: string }[];
    try {
      rows = (await entityManager().query(
        `insert into ${S}."role_binding"
           (client_id, user_id, service_account_id, role_id, scope_node_id, expires_at)
         values ($1, $2, $3, $4, $5, $6::timestamptz)
         returning id`,
        [
          claims.cid,
          subject.type === SubjectType.USER ? subject.id : null,
          subject.type === SubjectType.SERVICE ? subject.id : null,
          role.id,
          node.id,
          input.expires_at ?? null,
        ],
      )) as { id: string }[];
    } catch (error) {
      // `role_binding_subject_role_scope_key`. Naming the three parts is safe:
      // the caller sent all of them, and the index is scoped to their own
      // tenant, so the message reveals only that the grant they just tried to
      // make is one they already have.
      rethrowAsConflict(
        error,
        `${subject.name} already holds "${role.name}" at "${node.name}". ` +
          'Binding the same subject and role at an ancestor or a descendant of ' +
          'that node is permitted; binding it twice at the same node is not.',
      );
    }

    // Re-read through the same statement the list uses, rather than assembling
    // the response from the pieces above: `created_at`, `expired` and the
    // normalized `expires_at` are the database's answers, and a DTO built here
    // would be this service's guess at three of them.
    const binding = await this.findDto(claims, rows[0].id);
    if (binding === null) {
      // Unreachable: the insert committed to this transaction and the read runs
      // inside it. Stated rather than asserted away, because the alternative is
      // a non-null assertion that would hide a genuine RLS misconfiguration.
      throw IamException.conflict('The role binding could not be read back');
    }

    await this.audit.record(
      AUDIT_ACTIONS.ROLE_BINDING_CREATED,
      { type: 'role_binding', id: binding.id },
      payloadOf(binding),
    );

    afterCommit(() =>
      this.invalidation.publish(claims.cid, [affected(binding)], {
        cause: 'role_binding.created',
        bindingId: binding.id,
      }),
    );

    return binding;
  }

  /**
   * The tenant's grants, filtered (Doc 06 §9, Doc 09 §3.4).
   *
   * Ordered by subject, then by scope path, then by role. That order answers the
   * two ways the screen is read: unfiltered it groups the table by *who*, which
   * is how an operator scans a tenant's access; filtered to one person it
   * degenerates to path-then-role, which is how `UsersService.bindings` orders
   * the same rows on the user detail panel. The `id` tie-break keeps a page
   * boundary stable when two people share a name.
   *
   * Expired bindings are included and flagged — see the header.
   */
  async list(
    claims: VerifiedClaims,
    query: RoleBindingsQuery = {},
  ): Promise<Paginated<RoleBindingDTO>> {
    const { page, limit } = normalizePagination(query);
    const { where, parameters } = filters(claims, query);

    const rows = (await entityManager().query(
      `select ${COLUMNS}
       ${SOURCE}
        where ${where}
        order by subject_name asc, sn.path asc, r.name asc, rb.id asc
        limit $${parameters.length + 1} offset $${parameters.length + 2}`,
      [...parameters, limit, (page - 1) * limit],
    )) as BindingRow[];

    // Over `role_binding` alone: every filter keys off a column of that table,
    // so the joins the page needs for its names would only make the count
    // slower without changing it.
    const [count] = (await entityManager().query(
      `select count(*)::int as total from ${S}."role_binding" rb where ${where}`,
      parameters,
    )) as { total: number }[];

    return paginated(rows.map(toDto), count?.total ?? rows.length, query);
  }

  /**
   * Revokes a grant (Doc 06 §9).
   *
   * Returns `false` when no such binding is visible to this caller — another
   * tenant's is invisible under RLS, so the controller's 404 is the same one a
   * nonexistent id gets and the response cannot be used to discover that a grant
   * exists elsewhere (Doc 06 §2).
   *
   * The row is read before it is deleted, so the audit record can name whose
   * access was removed and where: afterwards there is nothing left to say it,
   * which is the argument `RolesService.remove` makes for the cascade it audits.
   */
  async remove(claims: VerifiedClaims, id: string): Promise<boolean> {
    const binding = await this.findDto(claims, id);
    if (binding === null) return false;

    await entityManager().query(
      `delete from ${S}."role_binding" where client_id = $1 and id = $2`,
      [claims.cid, id],
    );

    await this.audit.record(
      AUDIT_ACTIONS.ROLE_BINDING_DELETED,
      { type: 'role_binding', id: binding.id },
      // No `cause`: `RolesService.remove` writes this same action with one, and
      // its absence is what distinguishes a grant somebody deliberately revoked
      // from one that went with the role it was made through.
      payloadOf(binding),
    );

    afterCommit(() =>
      this.invalidation.publish(claims.cid, [affected(binding)], {
        cause: 'role_binding.deleted',
        bindingId: binding.id,
      }),
    );

    return true;
  }

  /**
   * The subject the body names, established as the caller's own.
   *
   * The XOR itself is the DTO's (`bindings.dto.ts`) and the check constraint's;
   * what is left here is *which tenant the named subject belongs to*, which is
   * a question about rows. Both arms answer the same 409 for a foreign id and
   * for a nonexistent one.
   *
   * The final `throw` is unreachable through the controller — the schema
   * guarantees one of the two ids — and exists because this method is also the
   * type narrowing: without it, neither branch would establish that an id is a
   * `string`.
   */
  private async resolveSubject(
    claims: VerifiedClaims,
    input: CreateBindingInput,
  ): Promise<ResolvedSubject> {
    if (input.user_id !== undefined) {
      const user = await this.users.findRow(claims, input.user_id);
      if (user === null) {
        throw IamException.conflict('The user does not belong to this client');
      }
      return { type: SubjectType.USER, id: user.id, name: `"${user.full_name}"` };
    }

    if (input.service_account_id !== undefined) {
      const account = await this.serviceAccounts.findRow(
        claims,
        input.service_account_id,
      );
      if (account === null) {
        // Also the refusal a platform-level account gets (null `client_id`,
        // Doc 01 §3.7): Doc 02 §6 keeps platform authority out of a client's
        // binding space entirely, and `findRow`'s explicit `client_id` is what
        // enforces it — see there.
        throw IamException.conflict(
          'The service account does not belong to this client',
        );
      }
      return {
        type: SubjectType.SERVICE,
        id: account.id,
        name: `The service account "${account.name}"`,
      };
    }

    throw IamException.conflict(
      'Exactly one of user_id or service_account_id must be given',
    );
  }

  /** One binding, joined and confined to the caller's tenant, or `null`. */
  private async findDto(
    claims: VerifiedClaims,
    id: string,
  ): Promise<RoleBindingDTO | null> {
    const [row] = (await entityManager().query(
      `select ${COLUMNS}
       ${SOURCE}
        where rb.client_id = $1 and rb.id = $2`,
      [claims.cid, id],
    )) as BindingRow[];

    return row === undefined ? null : toDto(row);
  }
}

/** `where` and its parameters, shared by the page and its total. */
function filters(
  claims: VerifiedClaims,
  query: RoleBindingsQuery,
): { where: string; parameters: unknown[] } {
  const conditions = ['rb.client_id = $1'];
  const parameters: unknown[] = [claims.cid];

  const filter = (column: string, value: string | undefined): void => {
    if (value === undefined) return;
    parameters.push(value);
    conditions.push(`rb.${column} = $${parameters.length}`);
  };

  filter('user_id', query.user_id);
  filter('service_account_id', query.service_account_id);
  filter('role_id', query.role_id);
  filter('scope_node_id', query.scope_node_id);

  return { where: conditions.join(' and '), parameters };
}

/** The subject a binding grants to, in the shape the invalidation hook takes. */
function affected(binding: RoleBindingDTO): AffectedSubject {
  return { type: binding.subject_type, id: binding.subject_id };
}

/**
 * What a `role_binding.created` / `.deleted` record carries (Doc 10 §2, §4).
 *
 * Both subject columns are written, not just the populated one, and the path is
 * written beside the node id — the same fields `RolesService.remove` records for
 * a cascaded binding, so the two writers of `role_binding.deleted` produce rows
 * an operator can read as one series. Ids alone would make the trail unreadable
 * the moment the rows they name are gone, which for a delete is immediately.
 */
function payloadOf(binding: RoleBindingDTO): Record<string, unknown> {
  return {
    subject_type: binding.subject_type,
    user_id: binding.subject_type === SubjectType.USER ? binding.subject_id : null,
    service_account_id:
      binding.subject_type === SubjectType.SERVICE ? binding.subject_id : null,
    subject_name: binding.subject_name,
    role_id: binding.role_id,
    role_name: binding.role_name,
    scope_node_id: binding.scope_node_id,
    scope_node_path: binding.scope_node_path,
    expires_at: binding.expires_at,
  };
}

function toDto(row: BindingRow): RoleBindingDTO {
  const isUser = row.user_id !== null;

  return {
    id: row.id,
    client_id: row.client_id,
    subject_type: isUser ? SubjectType.USER : SubjectType.SERVICE,
    // The check constraint guarantees one of the two is set, so the cast is a
    // statement about `role_binding_subject_xor` rather than an assumption.
    subject_id: (isUser ? row.user_id : row.service_account_id) as string,
    subject_name: row.subject_name,
    subject_email: row.subject_email,
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
