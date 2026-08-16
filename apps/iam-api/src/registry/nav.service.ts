/**
 * Nav catalog CRUD and menu-permission mapping — steps 3 and 4 of registering an
 * application (Doc 02 §2, Doc 06 §4).
 *
 * ## Navigation is rows, and this is where they come from
 *
 * Doc 02 §8: "navigation is never a static file — it is always resolved from
 * `nav_node` + `menu_permission`". Session 19 writes the resolver that prunes
 * this tree for a subject (Doc 05 §3); this service is what fills it, at
 * runtime, with no deploy.
 *
 * ## A parent belongs to the same application, twice over
 *
 * Migration 0002 carries `application_id` into the self-referencing foreign key,
 * so a cross-application parent is refused by the database whatever this service
 * believes. {@link NavService.add} checks it anyway, and the reason is the
 * response rather than the safety: a foreign-key violation is SQLSTATE 23503,
 * which `HttpExceptionFilter` does not recognise and reports as a 500. Doc 06 §2
 * files a cross-entity reference under 409 `CONFLICT`, next to the cross-tenant
 * violation it is the catalog analogue of.
 *
 * ## Keys, not uuids, in the mapping body
 *
 * `POST /…/nav-permissions` names both sides by key. The route already fixes the
 * application, keys are what a manifest is written in (Doc 02 §2), and a caller
 * that has just built a tree by key should not have to hold a uuid map to gate
 * it. Resolution to ids happens here, and an unknown key on either side is a 404
 * that says which one — these are catalog rows in an application the caller
 * just proved it may administer, so there is nothing to withhold.
 *
 * ## Unmapping is here although Doc 06 §4 does not list it
 *
 * The table there stops at `POST /…/nav-permissions`. Doc 10 §4 nevertheless
 * defines `menu_permission.unmapped`, and this session's acceptance criteria
 * require both halves of that pair to be audited — which needs a writer.
 * `DELETE /…/nav-permissions` is that writer, taking the same body as the POST
 * because it is the same statement run in the other direction. Session 14's
 * manifest upsert will reuse it: a `requires` list that loses a key has to
 * unmap, and doing so through a second private code path is how the two would
 * come to disagree about what an unmap audits.
 */

import { Injectable } from '@nestjs/common';
import type {
  NavCatalogResponse,
  NavNodeCatalogDTO,
  NavNodeKind,
  NavPermissionMapping,
  NavPermissionsResult,
} from '@plantops/contracts';
import { IAM_SCHEMA } from '@plantops/db';
import { AUDIT_ACTIONS } from '../audit/audit-actions';
import { AuditService } from '../audit/audit.service';
import { IamException } from '../common/iam.exception';
import { entityManager } from '../common/transaction-context';
import { ApplicationsService } from './applications.service';
import { rethrowAsConflict } from './conflict';
import { PermissionsService } from './permissions.service';
import { assertPlatformAdmin } from '../common/platform-admin';

const S = `"${IAM_SCHEMA}"`;

const COLUMNS = `id, application_id, parent_id, kind, key, label, route, icon,
                 sort_order, is_active, is_public, created_at, updated_at`;

interface NavNodeRow {
  id: string;
  application_id: string;
  parent_id: string | null;
  kind: NavNodeKind;
  key: string;
  label: string;
  route: string | null;
  icon: string | null;
  sort_order: number;
  is_active: boolean;
  is_public: boolean;
  created_at: Date;
  updated_at: Date;
}

export interface CreateNavNodeInput {
  kind: NavNodeKind;
  key: string;
  label: string;
  route?: string;
  icon?: string;
  sort_order?: number;
  is_public?: boolean;
  parent_id?: string;
  parent_key?: string;
}

/** One resolved `(nav node, permission)` pair, ready to insert or delete. */
interface ResolvedPair {
  navNodeId: string;
  navKey: string;
  permissionId: string;
  permissionKey: string;
}

@Injectable()
export class NavService {
  constructor(
    private readonly audit: AuditService,
    private readonly applications: ApplicationsService,
    private readonly permissions: PermissionsService,
  ) {}

  /**
   * Adds nav nodes to an application (Doc 06 §4).
   *
   * Inserted **in the order given**, so `parent_key` may name a node created
   * earlier in the same request — one call builds a module and hangs its menus
   * off it, which is the shape Doc 02 §2 step 3 describes. That ordering is also
   * why the loop inserts one row at a time rather than one multi-row statement:
   * a later node's parent has to exist before it is inserted, and a single
   * `values` list has no ordering to exploit.
   *
   * A duplicate key is a 409 naming it, not an upsert. Editing an existing node
   * is the manifest's job (Doc 02 §7, Session 14), and an add that silently
   * updated would leave a caller believing a relabel had taken when it had not.
   */
  async add(
    applicationId: string,
    inputs: readonly CreateNavNodeInput[],
  ): Promise<NavNodeCatalogDTO[]> {
    await assertPlatformAdmin();
    await this.requireApplication(applicationId);

    // Every node already in this application, so a `parent_key` can name one of
    // them and a `parent_id` can be checked against the set without a query per
    // node. Both grow as the loop inserts.
    const existing = (await entityManager().query(
      `select id, key from ${S}."nav_node" where application_id = $1`,
      [applicationId],
    )) as { id: string; key: string }[];

    const idByKey = new Map(existing.map((row) => [row.key, row.id]));
    const knownIds = new Set(existing.map((row) => row.id));

    const created: NavNodeRow[] = [];

    for (const input of inputs) {
      const parentId = this.resolveParent(input, idByKey, knownIds);

      let rows: NavNodeRow[];
      try {
        rows = (await entityManager().query(
          `insert into ${S}."nav_node"
             (application_id, parent_id, kind, key, label, route, icon, sort_order, is_public)
           values ($1, $2, $3::${S}."nav_node_kind", $4, $5, $6, $7, coalesce($8, 0), coalesce($9, false))
           returning ${COLUMNS}`,
          [
            applicationId,
            parentId,
            input.kind,
            input.key,
            input.label,
            input.route ?? null,
            input.icon ?? null,
            input.sort_order ?? null,
            input.is_public ?? null,
          ],
        )) as NavNodeRow[];
      } catch (error) {
        rethrowAsConflict(
          error,
          `The nav node key "${input.key}" already exists in this application`,
        );
      }

      const row = rows[0];
      idByKey.set(row.key, row.id);
      knownIds.add(row.id);
      created.push(row);
    }

    await this.audit.recordMany(
      created.map((row) => ({
        action: AUDIT_ACTIONS.NAV_NODE_CREATED,
        target: { type: 'nav_node' as const, id: row.id },
        payload: {
          application_id: row.application_id,
          key: row.key,
          kind: row.kind,
          label: row.label,
          parent_id: row.parent_id,
        },
      })),
    );

    // Freshly created nodes have no mappings yet, so `requires` is empty for all
    // of them — stated by construction rather than by a second query.
    return created.map((row) => toDto(row, []));
  }

  /**
   * The application's full catalog tree (Doc 06 §4).
   *
   * Not paginated: a tree cut off at row 25 is not a partial tree, it is a set
   * of orphans. `Paginated` is for flat lists (Doc 06 §1), and the nav catalog of
   * one application is bounded by what a menu can usefully show.
   *
   * Inactive nodes are included, with `is_active` on each. This is the platform
   * admin's view of what exists; the *pruned* tree a subject sees is Session 19's
   * `GET /iam/navigation`, and it is a different endpoint returning a different
   * type for exactly this reason.
   */
  async tree(applicationId: string): Promise<NavCatalogResponse> {
    await assertPlatformAdmin();
    await this.requireApplication(applicationId);

    const rows = (await entityManager().query(
      `select ${COLUMNS} from ${S}."nav_node"
        where application_id = $1
        order by sort_order asc, key asc`,
      [applicationId],
    )) as NavNodeRow[];

    const mapped = (await entityManager().query(
      `select mp.nav_node_id, p.key
         from ${S}."menu_permission" mp
         join ${S}."permission" p on p.id = mp.permission_id
         join ${S}."nav_node" n on n.id = mp.nav_node_id
        where n.application_id = $1
        order by p.key asc`,
      [applicationId],
    )) as { nav_node_id: string; key: string }[];

    const requires = new Map<string, string[]>();
    for (const row of mapped) {
      const keys = requires.get(row.nav_node_id);
      if (keys === undefined) requires.set(row.nav_node_id, [row.key]);
      else keys.push(row.key);
    }

    return { application_id: applicationId, tree: assemble(rows, requires) };
  }

  /**
   * Maps permissions onto nav nodes — `menu_permission` (Doc 01 §4.4).
   *
   * Idempotent. `on conflict do nothing` means re-sending a mapping is a no-op
   * that audits nothing, which matters because this is the call a deployment
   * script re-runs: a trail with one `menu_permission.mapped` per deploy is a
   * trail in which the deploy that actually changed something is invisible.
   */
  async map(
    applicationId: string,
    mappings: readonly NavPermissionMapping[],
  ): Promise<NavPermissionsResult> {
    const pairs = await this.resolvePairs(applicationId, mappings);

    const changed = (await entityManager().query(
      `with pairs as (
         select unnest($1::uuid[]) as nav_node_id, unnest($2::uuid[]) as permission_id
       ), inserted as (
         insert into ${S}."menu_permission" (nav_node_id, permission_id)
         select nav_node_id, permission_id from pairs
         on conflict do nothing
         returning nav_node_id, permission_id
       )
       select nav_node_id, permission_id from inserted`,
      [pairs.map((pair) => pair.navNodeId), pairs.map((pair) => pair.permissionId)],
    )) as { nav_node_id: string; permission_id: string }[];

    await this.auditMappingChange(
      applicationId,
      AUDIT_ACTIONS.MENU_PERMISSION_MAPPED,
      pairs,
      changed,
    );

    return { changed: changed.length, unchanged: pairs.length - changed.length };
  }

  /**
   * Removes mappings — the other direction of {@link NavService.map}.
   *
   * Idempotent in the same way: unmapping what was never mapped deletes nothing
   * and audits nothing. Note what this does *not* do — it never removes the nav
   * node. A leaf left with no mapping becomes invisible to everyone rather than
   * visible to everyone (Doc 05 §3, deny-by-default), which is the safe
   * direction for an operator who unmapped one key too many.
   */
  async unmap(
    applicationId: string,
    mappings: readonly NavPermissionMapping[],
  ): Promise<NavPermissionsResult> {
    const pairs = await this.resolvePairs(applicationId, mappings);

    const changed = (await entityManager().query(
      `with pairs as (
         select unnest($1::uuid[]) as nav_node_id, unnest($2::uuid[]) as permission_id
       ), removed as (
         delete from ${S}."menu_permission" mp
          using pairs
          where mp.nav_node_id = pairs.nav_node_id
            and mp.permission_id = pairs.permission_id
         returning mp.nav_node_id, mp.permission_id
       )
       select nav_node_id, permission_id from removed`,
      [pairs.map((pair) => pair.navNodeId), pairs.map((pair) => pair.permissionId)],
    )) as { nav_node_id: string; permission_id: string }[];

    await this.auditMappingChange(
      applicationId,
      AUDIT_ACTIONS.MENU_PERMISSION_UNMAPPED,
      pairs,
      changed,
    );

    return { changed: changed.length, unchanged: pairs.length - changed.length };
  }

  /**
   * The parent id for one input, or `null` for a top-level node.
   *
   * Both spellings resolve against the same two collections, which contain this
   * application's nodes and nothing else — so "belongs to another application"
   * and "does not exist" are indistinguishable here, and both are the 409 the
   * acceptance criterion names. That is deliberate: the alternative would be a
   * lookup that confirms a node exists elsewhere in the catalog, which is a
   * question this route has no reason to answer.
   */
  private resolveParent(
    input: CreateNavNodeInput,
    idByKey: ReadonlyMap<string, string>,
    knownIds: ReadonlySet<string>,
  ): string | null {
    if (input.parent_key !== undefined) {
      const parentId = idByKey.get(input.parent_key);
      if (parentId === undefined) {
        throw IamException.conflict(
          `The parent nav node "${input.parent_key}" does not belong to this application`,
        );
      }
      return parentId;
    }

    if (input.parent_id !== undefined) {
      if (!knownIds.has(input.parent_id)) {
        throw IamException.conflict(
          'The parent nav node does not belong to this application',
        );
      }
      return input.parent_id;
    }

    return null;
  }

  /**
   * Turns a mapping body into `(nav node id, permission id)` pairs.
   *
   * Deduplicated, because a body may name the same pair twice and the counts
   * this returns are reported to the caller — `changed` and `unchanged` that do
   * not add up to what was sent would be worse than no counts at all.
   */
  private async resolvePairs(
    applicationId: string,
    mappings: readonly NavPermissionMapping[],
  ): Promise<ResolvedPair[]> {
    await assertPlatformAdmin();
    await this.requireApplication(applicationId);

    const navRows = (await entityManager().query(
      `select id, key from ${S}."nav_node"
        where application_id = $1 and key = any($2::text[])`,
      [applicationId, [...new Set(mappings.map((mapping) => mapping.nav_key))]],
    )) as { id: string; key: string }[];
    const navIdByKey = new Map(navRows.map((row) => [row.key, row.id]));

    const permissionIdByKey = await this.permissions.idsByKey(
      applicationId,
      mappings.flatMap((mapping) => mapping.permission_keys),
    );

    const pairs = new Map<string, ResolvedPair>();

    for (const mapping of mappings) {
      const navNodeId = navIdByKey.get(mapping.nav_key);
      if (navNodeId === undefined) {
        throw IamException.notFound(`The nav node "${mapping.nav_key}"`);
      }

      for (const permissionKey of mapping.permission_keys) {
        const permissionId = permissionIdByKey.get(permissionKey);
        if (permissionId === undefined) {
          throw IamException.notFound(`The permission "${permissionKey}"`);
        }
        pairs.set(`${navNodeId}:${permissionId}`, {
          navNodeId,
          navKey: mapping.nav_key,
          permissionId,
          permissionKey,
        });
      }
    }

    return [...pairs.values()];
  }

  /**
   * One audit record per nav node whose mappings actually moved.
   *
   * Not one per pair. A `menu_permission` row has a composite primary key and no
   * id of its own, so a per-pair record would carry a null target and say in
   * fifty rows what one row says better; the target is therefore the `nav_node`
   * — a real row the id resolves to — and the permission keys ride in the
   * payload, which is the "salient fields" shape Doc 10 §2 asks for.
   *
   * Pairs that changed nothing are excluded, so re-running a deployment script
   * writes no records at all — and, `recordMany` issuing nothing for an empty
   * batch, no statement either.
   */
  private async auditMappingChange(
    applicationId: string,
    action:
      | typeof AUDIT_ACTIONS.MENU_PERMISSION_MAPPED
      | typeof AUDIT_ACTIONS.MENU_PERMISSION_UNMAPPED,
    pairs: readonly ResolvedPair[],
    changed: readonly { nav_node_id: string; permission_id: string }[],
  ): Promise<void> {
    const changedKeys = new Set(
      changed.map((row) => `${row.nav_node_id}:${row.permission_id}`),
    );

    const byNode = new Map<string, { navKey: string; permissionKeys: string[] }>();
    for (const pair of pairs) {
      if (!changedKeys.has(`${pair.navNodeId}:${pair.permissionId}`)) continue;
      const entry = byNode.get(pair.navNodeId);
      if (entry === undefined) {
        byNode.set(pair.navNodeId, {
          navKey: pair.navKey,
          permissionKeys: [pair.permissionKey],
        });
      } else {
        entry.permissionKeys.push(pair.permissionKey);
      }
    }

    await this.audit.recordMany(
      [...byNode].map(([navNodeId, entry]) => ({
        action,
        target: { type: 'nav_node' as const, id: navNodeId },
        payload: {
          application_id: applicationId,
          nav_key: entry.navKey,
          permission_keys: entry.permissionKeys,
        },
      })),
    );
  }

  /** 404s when the application does not exist. See `PermissionsService`. */
  private async requireApplication(applicationId: string): Promise<void> {
    if ((await this.applications.findRow(applicationId)) === null) {
      throw IamException.notFound('The application');
    }
  }
}

/**
 * Rows → a tree, in one pass.
 *
 * The rows arrive ordered by `(sort_order, key)`, and children are appended in
 * that order, so every sibling list comes out ordered without a second sort. A
 * node whose parent is not in the set becomes a root rather than being dropped —
 * that cannot happen while the composite foreign key holds, and silently losing
 * a subtree would be the worse failure if it ever did.
 */
function assemble(
  rows: readonly NavNodeRow[],
  requires: ReadonlyMap<string, string[]>,
): NavNodeCatalogDTO[] {
  const nodes = new Map<string, NavNodeCatalogDTO>();
  for (const row of rows) {
    nodes.set(row.id, toDto(row, requires.get(row.id) ?? []));
  }

  const roots: NavNodeCatalogDTO[] = [];
  for (const row of rows) {
    // `nodes.get` is total over `rows`, which is what was just inserted.
    const node = nodes.get(row.id) as NavNodeCatalogDTO;
    const parent = row.parent_id === null ? undefined : nodes.get(row.parent_id);
    if (parent === undefined) roots.push(node);
    else parent.children.push(node);
  }

  return roots;
}

function toDto(row: NavNodeRow, requires: string[]): NavNodeCatalogDTO {
  return {
    id: row.id,
    application_id: row.application_id,
    parent_id: row.parent_id,
    kind: row.kind,
    key: row.key,
    label: row.label,
    route: row.route,
    icon: row.icon,
    sort_order: row.sort_order,
    is_active: row.is_active,
    is_public: row.is_public,
    requires,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
    children: [],
  };
}
