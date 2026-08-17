/**
 * The org-tree CRUD — the WHERE dimension (Doc 06 §6, Doc 01 §3.5, Doc 07 §7).
 *
 * ## Three operations that look alike and are not
 *
 * Everything here is one table, and the whole design is the distance between
 * three edits to it:
 *
 * - **Rename** writes one column. `path` is id-derived (Doc 01 §3.5), so it is
 *   untouched, and therefore no binding's coverage changes, no cached
 *   resolution goes stale, and nothing is invalidated. That is the entire payoff
 *   of the label rule: the most common edit an admin makes is free.
 * - **Create** appends one label to the parent's path. A new leaf is covered by
 *   every binding above it from the instant it exists, which is what "access
 *   follows the tree" means and why creating a node is a grant-relevant act
 *   without being a grant.
 * - **Move** rewrites the `path` of the node *and its entire subtree*, changing
 *   what every binding beneath it covers. Doc 04 §7.1 names it the highest-risk
 *   concurrency case in the system, and {@link ScopesService.update} follows its
 *   ordering literally — see below.
 *
 * ## The move, step by step
 *
 * 1. **Capture the affected subjects first.** The `<@` query has to run against
 *    the *pre-move* subtree, because after the rewrite there is no way to ask
 *    which bindings were under the old prefix.
 * 2. **`REPEATABLE READ`.** Declared on the route with `@Transactional`, not
 *    here: the level must be set before the transaction's first statement, and
 *    `TenantContextInterceptor` has already run one (Doc 07 §5). A concurrent
 *    binding insert into the same subtree therefore cannot attach to a
 *    half-rewritten path set.
 * 3. **One statement.** The subtree is rewritten by a single `subpath`-based
 *    `update`, never a row-by-row walk — the whole subtree moves or none of it
 *    does, whatever else is happening on the connection.
 * 4. **Publish after commit.** The invalidation goes through `afterCommit()`, so
 *    it runs once `COMMIT` has returned. Publishing earlier lets a reader
 *    repopulate its cache from the old tree mid-transaction and re-poison it.
 * 5. **Retry on serialization failure.** Also declared on the route. A lost race
 *    re-runs the whole handler against committed state.
 *
 * ## Deletion is guarded, never cascading
 *
 * A node with children or with bindings is a 409 (Doc 06 §6). The database backs
 * both with `on delete restrict`, so the check exists for the *message* rather
 * than the safety — but the choice not to cascade is the substantive one: a
 * recursive delete of a subtree would silently remove the grants anchored to it,
 * which is the one class of change an operator must never make by accident.
 *
 * ## Authorization
 *
 * `@RequirePermission('iam.client.scope.…')` on the routes, checked by
 * `PermissionGuard` before this service runs (Session 23). `PATCH` and `DELETE`
 * name the node itself with `scopeFrom: 'params.id'`, so an admin may only
 * restructure the part of the tree they hold the permission over; `POST` names
 * the parent, and tolerates its absence because a tenant's first root has none.
 * Tenant isolation does not depend on any of that: every statement below runs under the
 * request's RLS context, so a node id from another client is invisible rather
 * than forbidden, and comes back as the same 404 a nonexistent id gets.
 */

import { Injectable } from '@nestjs/common';
import {
  MAX_SCOPE_TREE_DEPTH,
  SubjectType,
  type ScopeNodeDTO,
  type ScopeNodeKind,
  type ScopeTreeResponse,
} from '@plantops/contracts';
import { IAM_SCHEMA, type VerifiedClaims } from '@plantops/db';
import { randomUUID } from 'node:crypto';
import { AUDIT_ACTIONS } from '../audit/audit-actions';
import { AuditService } from '../audit/audit.service';
import {
  GrantInvalidationService,
  type AffectedSubject,
} from '../authz/invalidation.service';
import { IamException } from '../common/iam.exception';
import { afterCommit, entityManager } from '../common/transaction-context';
import {
  childPath,
  depthAfterMove,
  isDepthAllowed,
  pathDepth,
  rootPath,
} from './path.util';

const S = `"${IAM_SCHEMA}"`;

/** `path` is cast to text on the way out — the driver has no ltree type. */
const COLUMNS = `id, client_id, parent_id, kind, name, path::text as path,
                 metadata, created_at, updated_at`;

export interface ScopeNodeRow {
  id: string;
  client_id: string;
  parent_id: string | null;
  kind: ScopeNodeKind;
  name: string;
  path: string;
  metadata: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
}

export interface CreateScopeNodeInput {
  parent_id?: string;
  kind: ScopeNodeKind;
  name: string;
  metadata?: Record<string, unknown>;
}

export interface UpdateScopeNodeInput {
  name?: string;
  parent_id?: string;
}

@Injectable()
export class ScopesService {
  constructor(
    private readonly audit: AuditService,
    private readonly invalidation: GrantInvalidationService,
  ) {}

  /**
   * The caller's whole tree (Doc 06 §6).
   *
   * Not paginated, for the reason `NavService.tree` is not: a tree cut off at
   * row 25 is not a partial tree, it is a set of orphans. The bound is the
   * organisation's own structure, which is a thing people have to be able to
   * hold in their heads.
   *
   * The tenant comes from the token, never from a query parameter (Doc 06 §1),
   * and RLS would return nothing for any other one regardless.
   */
  async tree(claims: VerifiedClaims): Promise<ScopeTreeResponse> {
    const rows = (await entityManager().query(
      `select ${COLUMNS} from ${S}."scope_node"
        where client_id = $1
        order by name asc, id asc`,
      [claims.cid],
    )) as ScopeNodeRow[];

    return { client_id: claims.cid, tree: assemble(rows) };
  }

  /**
   * Adds a node (Doc 06 §6).
   *
   * The id is generated here and the path built from it, in that order, which is
   * what keeps a display name out of `path`: there is no step at which the name
   * is available to whatever builds the label (Doc 01 §3.5). Migration 0003's
   * check constraint independently enforces the same rule, so a future code path
   * that got this wrong would be refused by the database rather than quietly
   * corrupting coverage.
   *
   * @throws {IamException} 409 when the parent is not this client's, when the
   * tenant already has a root and none was named, or when the tree would exceed
   * {@link MAX_SCOPE_TREE_DEPTH}.
   */
  async create(
    claims: VerifiedClaims,
    input: CreateScopeNodeInput,
  ): Promise<ScopeNodeDTO> {
    const id = randomUUID();
    const path = await this.pathForNewNode(claims, id, input.parent_id);

    const [row] = (await entityManager().query(
      `insert into ${S}."scope_node"
         (id, client_id, parent_id, kind, name, path, metadata)
       values ($1, $2, $3, $4::${S}."scope_node_kind", $5, $6::ltree,
               coalesce($7::jsonb, '{}'::jsonb))
       returning ${COLUMNS}`,
      [
        id,
        claims.cid,
        input.parent_id ?? null,
        input.kind,
        input.name,
        path,
        input.metadata === undefined ? null : JSON.stringify(input.metadata),
      ],
    )) as ScopeNodeRow[];

    await this.audit.record(
      AUDIT_ACTIONS.SCOPE_NODE_CREATED,
      { type: 'scope_node', id: row.id },
      { name: row.name, kind: row.kind, path: row.path, parent_id: row.parent_id },
    );

    return toDto(row);
  }

  /**
   * Renames and/or moves a node (Doc 06 §6).
   *
   * The two halves are applied in that order — the rename first, then the
   * reparenting — so that the audit records and the returned row describe the
   * same final state. Each half is skipped entirely when the request would not
   * change anything, which is why a re-submitted unchanged form audits nothing
   * (the rule `ClientsService.update` follows).
   *
   * Returns `null` when no such node is visible to this caller.
   */
  async update(
    claims: VerifiedClaims,
    id: string,
    input: UpdateScopeNodeInput,
  ): Promise<ScopeNodeDTO | null> {
    const current = await this.findRow(claims, id);
    if (current === null) return null;

    let row = current;

    if (input.name !== undefined && input.name !== current.name) {
      row = await this.rename(row, input.name);
    }

    if (input.parent_id !== undefined && input.parent_id !== current.parent_id) {
      row = await this.move(claims, row, input.parent_id);
    }

    return toDto(row);
  }

  /**
   * Removes a node, if nothing depends on it (Doc 06 §6).
   *
   * Returns `false` when no such node is visible to this caller.
   *
   * @throws {IamException} 409 when the node has children or bindings.
   */
  async remove(claims: VerifiedClaims, id: string): Promise<boolean> {
    const row = await this.findRow(claims, id);
    if (row === null) return false;

    const [counts] = (await entityManager().query(
      `select (select count(*)::int from ${S}."scope_node" c
                where c.client_id = $1 and c.parent_id = $2) as children,
              (select count(*)::int from ${S}."role_binding" rb
                where rb.client_id = $1 and rb.scope_node_id = $2) as bindings`,
      [claims.cid, id],
    )) as { children: number; bindings: number }[];

    if (counts.children > 0) {
      throw IamException.conflict(
        `"${row.name}" still has ${counts.children} child node(s). ` +
          'Move or remove them first — deleting a node never deletes what is under it.',
      );
    }

    if (counts.bindings > 0) {
      throw IamException.conflict(
        `"${row.name}" still has ${counts.bindings} role binding(s) anchored to it. ` +
          'Remove those grants first, or they would be deleted with the node.',
      );
    }

    await entityManager().query(
      `delete from ${S}."scope_node" where client_id = $1 and id = $2`,
      [claims.cid, id],
    );

    await this.audit.record(
      AUDIT_ACTIONS.SCOPE_NODE_DELETED,
      { type: 'scope_node', id: row.id },
      { name: row.name, kind: row.kind, path: row.path, parent_id: row.parent_id },
    );

    return true;
  }

  /**
   * The node, or `null`. RLS and the explicit `client_id` both confine it to the
   * caller's tenant.
   *
   * Public since Session 20: anchoring a grant to a node has to establish that
   * the node is the caller's own before the binding is written (Doc 02 §6), and
   * "is this scope node mine" should have exactly one implementation — a second
   * copy in `BindingsService` is how the two would eventually disagree about
   * what a visible node is.
   */
  async findRow(claims: VerifiedClaims, id: string): Promise<ScopeNodeRow | null> {
    const [row] = (await entityManager().query(
      `select ${COLUMNS} from ${S}."scope_node" where client_id = $1 and id = $2`,
      [claims.cid, id],
    )) as ScopeNodeRow[];

    return row ?? null;
  }

  /**
   * The path a new node gets, and the checks that decide whether it may have one.
   *
   * A `parent_id` that names a node in another tenant is invisible under RLS, so
   * it lands in the same branch as one that does not exist at all — and both
   * answer 409 `CONFLICT` with a message that commits to neither. Doc 06 §2 files
   * a cross-tenant reference exactly there, next to the duplicate key.
   */
  private async pathForNewNode(
    claims: VerifiedClaims,
    id: string,
    parentId: string | undefined,
  ): Promise<string> {
    if (parentId === undefined) {
      const [existing] = (await entityManager().query(
        `select id from ${S}."scope_node"
          where client_id = $1 and parent_id is null
          limit 1`,
        [claims.cid],
      )) as { id: string }[];

      if (existing !== undefined) {
        throw IamException.conflict(
          'This client already has a root scope node; name a parent_id to add ' +
            'beneath it. A second root would make "everything this admin covers" ' +
            'a question with two answers.',
        );
      }

      return rootPath(id);
    }

    const parent = await this.findRow(claims, parentId);
    if (parent === null) {
      throw IamException.conflict(
        'The parent scope node does not belong to this client',
      );
    }

    const depth = pathDepth(parent.path) + 1;
    if (!isDepthAllowed(depth)) {
      throw IamException.conflict(
        `A scope tree may be at most ${MAX_SCOPE_TREE_DEPTH} levels deep`,
      );
    }

    return childPath(parent.path, id);
  }

  /**
   * The cheap half of `PATCH`: one column.
   *
   * `path` is not in the statement and could not be — that is the point of the
   * id-derived label (Doc 01 §3.5). Nothing is invalidated: a rename changes what
   * an operator *reads*, never what a binding *covers*, so the entry in Doc 04 §7's
   * table ("scope_node moved/renamed (path change)") does not apply to a rename
   * in this schema. The parenthetical is the condition, and a rename never meets
   * it.
   */
  private async rename(current: ScopeNodeRow, name: string): Promise<ScopeNodeRow> {
    // Wrapped in a CTE so the statement's command is SELECT: TypeORM's Postgres
    // driver returns `[rows, rowCount]` for a bare `update … returning`.
    const [row] = (await entityManager().query(
      `with updated as (
         update ${S}."scope_node"
            set name = $3
          where client_id = $1 and id = $2
         returning ${COLUMNS}
       )
       select ${COLUMNS} from updated`,
      [current.client_id, current.id, name],
    )) as ScopeNodeRow[];

    await this.audit.record(
      AUDIT_ACTIONS.SCOPE_NODE_RENAMED,
      { type: 'scope_node', id: row.id },
      {
        before: current.name,
        after: row.name,
        // Stated in the record because it is the claim worth being able to
        // audit: the path did not move, so nothing beneath this node changed.
        path: row.path,
      },
    );

    return row;
  }

  /**
   * The expensive half: reparenting, and the subtree rewrite it implies.
   *
   * Every guard below refuses *before* the rewrite, because a move that fails
   * halfway is the one outcome the whole design is arranged to make impossible.
   *
   * @throws {IamException} 409 when the new parent is not this client's, is the
   * node itself or one of its descendants, or when the move would exceed
   * {@link MAX_SCOPE_TREE_DEPTH}.
   */
  private async move(
    claims: VerifiedClaims,
    current: ScopeNodeRow,
    newParentId: string,
  ): Promise<ScopeNodeRow> {
    const parent = await this.findRow(claims, newParentId);
    if (parent === null) {
      throw IamException.conflict(
        'The parent scope node does not belong to this client',
      );
    }

    // A node cannot become its own ancestor. The check is on paths rather than
    // ids so that it covers the whole subtree in one comparison, and it catches
    // "move a node under itself" as the depth-zero case of the same mistake.
    if (parent.path === current.path || parent.path.startsWith(`${current.path}.`)) {
      throw IamException.conflict(
        `"${current.name}" cannot be moved beneath itself or one of its own descendants`,
      );
    }

    // Both facts about the subtree in one pass: how many levels it occupies,
    // which decides whether it fits under the new parent, and how many nodes are
    // about to be rewritten, which is what the audit record reports.
    const [{ height, nodes }] = (await entityManager().query(
      `select coalesce(max(nlevel(path)), nlevel($2::ltree))::int
                - nlevel($2::ltree) + 1 as height,
              count(*)::int as nodes
         from ${S}."scope_node"
        where client_id = $1 and path <@ $2::ltree`,
      [claims.cid, current.path],
    )) as { height: number; nodes: number }[];

    const depth = depthAfterMove(pathDepth(parent.path), height);
    if (!isDepthAllowed(depth)) {
      throw IamException.conflict(
        `Moving "${current.name}" there would make the tree ${depth} levels deep; ` +
          `the maximum is ${MAX_SCOPE_TREE_DEPTH}`,
      );
    }

    // Step 1 of Doc 04 §7.1: captured against the *pre-move* subtree, because
    // after the rewrite nothing can be asked about the old prefix.
    const subjects = await this.subjectsUnder(claims, current.path);

    // Step 3: one statement. The moved node keeps its own label and every
    // descendant keeps the tail below it — `subpath(path, nlevel(old) - 1)` —
    // so the rewrite is a prefix substitution over the whole subtree at once.
    // `parent_id` moves with it, for the one row whose parent actually changed.
    const [row] = (await entityManager().query(
      `with moved as (
         update ${S}."scope_node"
            set path = $3::ltree || subpath(path, nlevel($2::ltree) - 1),
                parent_id = case when id = $4 then $5::uuid else parent_id end
          where client_id = $1 and path <@ $2::ltree
         returning ${COLUMNS}
       )
       select ${COLUMNS} from moved where id = $4`,
      [claims.cid, current.path, parent.path, current.id, newParentId],
    )) as ScopeNodeRow[];

    await this.audit.record(
      AUDIT_ACTIONS.SCOPE_NODE_MOVED,
      { type: 'scope_node', id: row.id },
      {
        name: row.name,
        before_path: current.path,
        after_path: row.path,
        before_parent_id: current.parent_id,
        after_parent_id: newParentId,
        /** Nodes whose `path` this one statement rewrote, the moved node included. */
        nodes_moved: nodes,
        // The count, not the ids: Doc 10 §2 asks for salient fields, and a
        // subject list on a large subtree would be a payload nobody can scan.
        subjects_invalidated: subjects.length,
      },
    );

    // Step 4: after COMMIT, never before. `afterCommit` is what makes that
    // structural rather than a comment — see `transaction-context.ts`.
    afterCommit(() =>
      this.invalidation.publish(claims.cid, subjects, {
        cause: 'scope_node.moved',
        scopeNodeId: row.id,
      }),
    );

    return row;
  }

  /**
   * Every subject with a binding anywhere in the subtree at `path`.
   *
   * The `<@` prefix test on the GiST index of migration 0006 — the same operator
   * resolution uses for coverage, which is what makes "who is affected" and "who
   * is covered" the same question asked at two moments.
   */
  private async subjectsUnder(
    claims: VerifiedClaims,
    path: string,
  ): Promise<AffectedSubject[]> {
    const rows = (await entityManager().query(
      `select distinct rb.user_id, rb.service_account_id
         from ${S}."role_binding" rb
         join ${S}."scope_node" sn on sn.id = rb.scope_node_id
        where rb.client_id = $1 and sn.path <@ $2::ltree`,
      [claims.cid, path],
    )) as { user_id: string | null; service_account_id: string | null }[];

    return rows.map((row) =>
      row.user_id === null
        ? { type: SubjectType.SERVICE, id: row.service_account_id as string }
        : { type: SubjectType.USER, id: row.user_id },
    );
  }
}

/**
 * Rows → a tree, in one pass.
 *
 * The rows arrive ordered by name, and children are appended in that order, so
 * every sibling list comes out ordered without a second sort. A node whose
 * parent is not in the set becomes a root rather than being dropped — the
 * composite foreign key of migration 0003 makes that unreachable, and silently
 * losing a subtree would be the worse failure if it ever happened. Same shape,
 * and the same reasoning, as `NavService`'s assembler.
 */
function assemble(rows: readonly ScopeNodeRow[]): ScopeNodeDTO[] {
  const nodes = new Map<string, ScopeNodeDTO>();
  for (const row of rows) nodes.set(row.id, toDto(row));

  const roots: ScopeNodeDTO[] = [];
  for (const row of rows) {
    const node = nodes.get(row.id) as ScopeNodeDTO;
    const parent = row.parent_id === null ? undefined : nodes.get(row.parent_id);
    if (parent === undefined) roots.push(node);
    else parent.children.push(node);
  }

  return roots;
}

function toDto(row: ScopeNodeRow): ScopeNodeDTO {
  return {
    id: row.id,
    client_id: row.client_id,
    parent_id: row.parent_id,
    kind: row.kind,
    name: row.name,
    path: row.path,
    depth: pathDepth(row.path),
    metadata: row.metadata,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
    children: [],
  };
}
