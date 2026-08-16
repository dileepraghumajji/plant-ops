/**
 * `POST /iam/applications/:id/manifest` — the declarative catalog upsert
 * (Doc 02 §2, §7, Doc 06 §4).
 *
 * ## The primary registration path
 *
 * Doc 02 §2 describes registering an application as four calls; this is the
 * fifth, and it is the one applications actually use. A manifest is a JSON
 * document that ships with the application and enumerates its permissions and
 * its nav tree; uploading it *is* registration, and re-uploading it is how the
 * catalog evolves — "without deploys", which is the promise the whole registry
 * exists to keep (Doc 02 §8).
 *
 * ## It composes the imperative services rather than re-implementing them
 *
 * Every insert here goes through {@link PermissionsService.add},
 * {@link NavService.add} and {@link NavService.map}/`unmap`. That is deliberate,
 * and `nav.service.ts` states the reason from the other side: a second private
 * code path for the same write is how the two come to disagree about what a
 * creation or an unmap audits. The manifest and the form path produce the same
 * rows and the same trail, because they run the same code.
 *
 * What is *not* delegated is the part that has no imperative counterpart:
 * updating a permission or a nav node in place, and deactivating one. Doc 06 §4
 * offers no `PATCH` for either — Session 13's services say so explicitly — since
 * the manifest is the only sanctioned way to edit or retire them. Those three
 * statements are the whole of this file's own SQL.
 *
 * ## One transaction, and it is not this service's doing
 *
 * "A mid-manifest validation failure changes nothing" comes free:
 * `TenantContextInterceptor` opens one transaction per request and everything
 * below runs on `entityManager()`, so a throw anywhere — a 409 on the tenth
 * permission, a foreign-key violation on the fiftieth node — rolls back the nine
 * and the forty-nine along with every audit record they wrote (Doc 07 §5,
 * Doc 10 §3). The stronger guarantee is upstream of even that: everything about
 * the document alone is checked by `manifest.dto.ts` before a statement runs.
 *
 * ## Order of operations, and why it is that order
 *
 * 1. **Application row** — a rename, through `ApplicationsService.update`.
 * 2. **Permissions**, created then updated, *before* nav: a `requires` cannot be
 *    mapped to a permission that does not exist yet.
 * 3. **Nav nodes**, created depth-first then updated. Creation first because an
 *    existing node may be re-parented under a brand-new one; the update pass
 *    resolves parents against a map that by then contains both.
 * 4. **Mappings**, in both directions — every key on both sides now exists.
 * 5. **Deactivations**, last. A node absent from the manifest may still have
 *    been the old parent of a node the manifest moved elsewhere, and the move
 *    has to happen while the row is still the thing being moved off.
 * 6. **The summary record**, once, with the diff.
 *
 * ## Idempotence is checked, not hoped for
 *
 * The plan is computed against a snapshot before anything is written, and an
 * empty plan returns early having written nothing at all — no rows, no audit
 * record, `changed: false`. That is what makes a re-upload a true no-op rather
 * than a series of `update`s that happen to set the same values (Doc 02 §7).
 */

import { Injectable } from '@nestjs/common';
import type { ApplicationManifest, ManifestUpsertResponse } from '@plantops/contracts';
import { IAM_SCHEMA } from '@plantops/db';
import { AUDIT_ACTIONS } from '../audit/audit-actions';
import { AuditService, type AuditEntry } from '../audit/audit.service';
import { GrantInvalidationService } from '../authz/invalidation.service';
import { IamException } from '../common/iam.exception';
import { afterCommit, entityManager } from '../common/transaction-context';
import { ApplicationsService, type ApplicationRow } from './applications.service';
import {
  computeManifestPlan,
  isNoOpDiff,
  toManifestDiff,
  type CatalogNavNode,
  type CatalogPermission,
  type CurrentCatalog,
  type DesiredNavNode,
  type ManifestPlan,
  type NavNodeUpdate,
  type PermissionUpdate,
} from './manifest-diff';
import { NavService } from './nav.service';
import { PermissionsService } from './permissions.service';
import { assertPlatformAdmin } from '../common/platform-admin';

const S = `"${IAM_SCHEMA}"`;

@Injectable()
export class ManifestService {
  constructor(
    private readonly audit: AuditService,
    private readonly applications: ApplicationsService,
    private readonly permissions: PermissionsService,
    private readonly nav: NavService,
    private readonly invalidation: GrantInvalidationService,
  ) {}

  /**
   * Applies a manifest to an application (Doc 02 §2).
   *
   * @throws 404 when the application does not exist, 409 when the manifest's
   * `key` is not the target application's.
   */
  async upsert(
    applicationId: string,
    manifest: ApplicationManifest,
  ): Promise<ManifestUpsertResponse> {
    await assertPlatformAdmin();

    const application = await this.applications.findRow(applicationId);
    if (application === null) throw IamException.notFound('The application');

    // The route names the application by uuid and the document names it by key,
    // and if they disagree one of them is a mistake nobody would notice
    // afterwards: applying `gatepass`'s manifest to `visitor` would deactivate
    // every one of `visitor`'s permissions and rebuild its menu as a copy of
    // another application's, all reported as a successful upsert. `key` is not
    // patchable for the same reason (`applications.dto.ts`).
    if (manifest.key !== application.key) {
      throw IamException.conflict(
        `This manifest is for the application "${manifest.key}", but ` +
          `"${application.key}" was addressed`,
      );
    }

    const plan = computeManifestPlan(await this.snapshot(application), manifest);
    const diff = toManifestDiff(plan);

    if (isNoOpDiff(diff)) {
      return { application_id: applicationId, changed: false, diff };
    }

    if (plan.application.changed.length > 0) {
      await this.applications.update(applicationId, {
        name: plan.application.name,
        description: plan.application.description,
      });
    }

    await this.applyPermissions(applicationId, plan);
    const navIdByKey = await this.applyNav(applicationId, plan);
    await this.applyMappings(applicationId, plan);
    await this.deactivate(applicationId, plan, navIdByKey);

    // The whole diff, not a count of it. This one record is where an operator
    // looks to answer "what did that upload do", and Doc 09 §2.1 shows the
    // operator the same value before they confirm it — the record should be what
    // they approved.
    await this.audit.record(
      AUDIT_ACTIONS.APPLICATION_MANIFEST_UPSERTED,
      { type: 'application', id: applicationId },
      {
        application: diff.application,
        permissions: diff.permissions,
        nav: diff.nav,
        menu_permissions: diff.menu_permissions,
      },
    );

    return { application_id: applicationId, changed: true, diff };
  }

  // ── reading the catalog as it is ──────────────────────────────────────────

  /**
   * The whole of one application's catalog, keyed for diffing.
   *
   * Inactive rows included, deliberately: a key that was deactivated by an
   * earlier upload and appears again is a *reactivation* of the row that is
   * still there, not a new row — and inserting a second one would fail on the
   * unique index anyway, reported as a conflict with a key the caller can see
   * nowhere in the catalog.
   */
  private async snapshot(application: ApplicationRow): Promise<CurrentCatalog> {
    const permissions = (await entityManager().query(
      `select key, name, description, is_active from ${S}."permission"
        where application_id = $1
        order by key asc`,
      [application.id],
    )) as CatalogPermission[];

    const navNodes = (await entityManager().query(
      `select n.key, n.kind, n.label, n.route, n.icon, n.sort_order,
              n.is_public, n.is_active, parent.key as parent_key
         from ${S}."nav_node" n
         left join ${S}."nav_node" parent on parent.id = n.parent_id
        where n.application_id = $1
        order by n.key asc`,
      [application.id],
    )) as CatalogNavNode[];

    const mapped = (await entityManager().query(
      `select n.key as nav_key, p.key as permission_key
         from ${S}."menu_permission" mp
         join ${S}."nav_node" n on n.id = mp.nav_node_id
         join ${S}."permission" p on p.id = mp.permission_id
        where n.application_id = $1
        order by p.key asc`,
      [application.id],
    )) as { nav_key: string; permission_key: string }[];

    const mappings = new Map<string, string[]>();
    for (const row of mapped) {
      const keys = mappings.get(row.nav_key);
      if (keys === undefined) mappings.set(row.nav_key, [row.permission_key]);
      else keys.push(row.permission_key);
    }

    return {
      application: {
        key: application.key,
        name: application.name,
        description: application.description,
      },
      permissions,
      navNodes,
      mappings,
    };
  }

  // ── applying it ───────────────────────────────────────────────────────────

  private async applyPermissions(
    applicationId: string,
    plan: ManifestPlan,
  ): Promise<void> {
    if (plan.permissions.created.length > 0) {
      await this.permissions.add(applicationId, plan.permissions.created);
    }

    // The updates stay one statement each — they set different values — but
    // their records do not have to. See {@link AuditService.recordMany}: an
    // upload that relabels two hundred permissions writes two hundred rows
    // through one round-trip instead of two hundred.
    const audited: AuditEntry[] = [];
    for (const update of plan.permissions.updated) {
      audited.push(await this.updatePermission(applicationId, update));
    }
    await this.audit.recordMany(audited);
  }

  /**
   * A permission's label, description, or its return from deactivation.
   *
   * `is_active = true` unconditionally rather than only when it moved: the
   * manifest declares the key, and declaring it is what active means. The audit
   * record still names `is_active` only when it actually changed, because the
   * plan compared it.
   *
   * Returns the record rather than writing it, so the caller can write the whole
   * pass in one statement. The record is still built here, beside the statement
   * it describes and from the same plan entry.
   */
  private async updatePermission(
    applicationId: string,
    update: PermissionUpdate,
  ): Promise<AuditEntry> {
    const [row] = (await entityManager().query(
      `with updated as (
         update ${S}."permission"
            set name = $3, description = $4, is_active = true
          where application_id = $1 and key = $2
         returning id
       )
       select id from updated`,
      [
        applicationId,
        update.desired.key,
        update.desired.name,
        update.desired.description ?? null,
      ],
    )) as { id: string }[];

    return {
      action: AUDIT_ACTIONS.PERMISSION_UPDATED,
      target: { type: 'permission', id: row.id },
      payload: {
        application_id: applicationId,
        key: update.desired.key,
        changed: update.changed,
        before: summarize(update.changed, {
          name: update.current.name,
          description: update.current.description,
          is_active: update.current.is_active,
        }),
        after: summarize(update.changed, {
          name: update.desired.name,
          description: update.desired.description ?? null,
          is_active: true,
        }),
      },
    };
  }

  /**
   * Creates and updates nav nodes, and returns every key's id.
   *
   * The map is built from one query rather than from the services' return values
   * because the deactivation pass needs ids for nodes this run never touched.
   */
  private async applyNav(
    applicationId: string,
    plan: ManifestPlan,
  ): Promise<Map<string, string>> {
    if (plan.nav.created.length > 0) {
      // Depth-first order, so `parent_key` always names a node that either
      // already existed or was created moments earlier in this same call — which
      // is precisely what `NavService.add` supports.
      await this.nav.add(
        applicationId,
        plan.nav.created.map((node) => ({
          kind: node.kind,
          key: node.key,
          label: node.label,
          route: node.route ?? undefined,
          icon: node.icon ?? undefined,
          sort_order: node.sort_order,
          is_public: node.is_public,
          parent_key: node.parent_key ?? undefined,
        })),
      );
    }

    const idByKey = await this.navIdsByKey(applicationId);

    const audited: AuditEntry[] = [];
    for (const update of plan.nav.updated) {
      audited.push(await this.updateNavNode(applicationId, update, idByKey));
    }
    await this.audit.recordMany(audited);

    return idByKey;
  }

  /**
   * A nav node's label, route, icon, order, visibility flag, kind or parent.
   *
   * The parent is resolved through the id map, which contains this application's
   * nodes and nothing else — so a re-parenting can only ever point inside the
   * application, the rule migration 0002's composite foreign key enforces and
   * `NavService.add` reports as a 409. A missing key here would be a bug in the
   * plan rather than in the request, which is why it throws rather than
   * producing an `IamException`.
   *
   * Returns its record rather than writing it, for the reason
   * {@link ManifestService.updatePermission} does.
   */
  private async updateNavNode(
    applicationId: string,
    update: NavNodeUpdate,
    idByKey: ReadonlyMap<string, string>,
  ): Promise<AuditEntry> {
    const { desired } = update;
    const id = idByKey.get(desired.key);
    const parentId = desired.parent_key === null ? null : idByKey.get(desired.parent_key);

    if (id === undefined || parentId === undefined) {
      throw new Error(
        `Manifest plan referenced a nav node absent from the catalog: ` +
          `${desired.key} (parent ${desired.parent_key ?? 'none'})`,
      );
    }

    await entityManager().query(
      `update ${S}."nav_node"
          set kind = $3::${S}."nav_node_kind", label = $4, route = $5, icon = $6,
              sort_order = $7, is_public = $8, parent_id = $9, is_active = true
        where application_id = $1 and key = $2`,
      [
        applicationId,
        desired.key,
        desired.kind,
        desired.label,
        desired.route,
        desired.icon,
        desired.sort_order,
        desired.is_public,
        parentId,
      ],
    );

    return {
      action: AUDIT_ACTIONS.NAV_NODE_UPDATED,
      target: { type: 'nav_node', id },
      payload: {
        application_id: applicationId,
        key: desired.key,
        changed: update.changed,
        before: summarize(update.changed, navFields(update.current)),
        after: summarize(update.changed, navFields({ ...desired, is_active: true })),
      },
    };
  }

  /**
   * The `menu_permission` rows, both directions, through the mapping service.
   *
   * Split into two calls rather than one because they are two audit actions —
   * `menu_permission.mapped` and `.unmapped` — and Doc 10 §4 keeps them
   * separate.
   */
  private async applyMappings(applicationId: string, plan: ManifestPlan): Promise<void> {
    if (plan.mappings.mapped.length > 0) {
      await this.nav.map(applicationId, plan.mappings.mapped);
    }
    if (plan.mappings.unmapped.length > 0) {
      await this.nav.unmap(applicationId, plan.mappings.unmapped);
    }
  }

  /**
   * Soft-deactivation — the only removal Doc 02 §7 has.
   *
   * Nav nodes first, then permissions, though nothing depends on the order:
   * neither statement touches `menu_permission`, which is the point. A node's
   * gates survive its deactivation so that a key returning in a later upload
   * returns gated as it was, and a `role_permission` row keeps naming a
   * deactivated permission so that re-declaring the key restores the grant
   * rather than requiring every role to be rebuilt.
   */
  private async deactivate(
    applicationId: string,
    plan: ManifestPlan,
    navIdByKey: ReadonlyMap<string, string>,
  ): Promise<void> {
    for (const key of plan.nav.deactivated) {
      await entityManager().query(
        `update ${S}."nav_node" set is_active = false
          where application_id = $1 and key = $2`,
        [applicationId, key],
      );
    }

    await this.audit.recordMany(
      plan.nav.deactivated.map((key) => ({
        action: AUDIT_ACTIONS.NAV_NODE_DEACTIVATED,
        target: { type: 'nav_node' as const, id: navIdByKey.get(key) ?? null },
        payload: { application_id: applicationId, key },
      })),
    );

    if (plan.permissions.deactivated.length === 0) return;

    const rows = (await entityManager().query(
      `with deactivated as (
         update ${S}."permission" set is_active = false
          where application_id = $1 and key = any($2::text[])
         returning id, key
       )
       select id, key from deactivated`,
      [applicationId, plan.permissions.deactivated],
    )) as { id: string; key: string }[];

    await this.audit.recordMany(
      rows.map((row) => ({
        action: AUDIT_ACTIONS.PERMISSION_DEACTIVATED,
        target: { type: 'permission' as const, id: row.id },
        payload: { application_id: applicationId, key: row.key },
      })),
    );

    // The subtlest row of Doc 04 §7: "permission soft-deactivated / removed via
    // manifest re-upload → all subjects bound to any role mapping that
    // permission", because "cached grants may still reference a now-inert
    // permission key".
    //
    // Nothing about the binding graph moved — the `role_permission` rows are
    // deliberately left in place (see this method's header) — so no other row of
    // the table fires and the only thing that changed is `is_active`, which
    // `resolve()` filters on. Without this the retired key keeps working for up
    // to a TTL after the upload that retired it, on every tenant that had it.
    //
    // Cross-tenant, and the only cause that is: an application's catalog is
    // platform-owned and any number of clients may have enabled it (Doc 02 §7),
    // so the affected subjects span tenants and the publish groups them by
    // client. The lookup is correct here only because `upsert` asserted platform
    // admin — under a tenant context RLS would narrow it to one client and
    // silently under-invalidate the rest.
    const subjects = await this.invalidation.subjectsBoundToPermissions(
      rows.map((row) => row.id),
    );

    afterCommit(() =>
      this.invalidation.publishAcrossTenants(subjects, {
        cause: 'permission.deactivated',
        applicationId,
        permissionKeys: rows.map((row) => row.key),
      }),
    );
  }

  private async navIdsByKey(applicationId: string): Promise<Map<string, string>> {
    const rows = (await entityManager().query(
      `select id, key from ${S}."nav_node" where application_id = $1`,
      [applicationId],
    )) as { id: string; key: string }[];

    return new Map(rows.map((row) => [row.key, row.id]));
  }
}

/**
 * The changed fields, by name — a compact before/after (Doc 10 §2).
 *
 * Only the fields that moved, so a relabel records a label rather than the whole
 * row.
 */
function summarize(
  changed: readonly string[],
  values: Record<string, unknown>,
): Record<string, unknown> {
  const summary: Record<string, unknown> = {};
  for (const field of changed) {
    if (field in values) summary[field] = values[field];
  }
  return summary;
}

/**
 * The comparable fields of a nav node, under the names the diff reports.
 *
 * `parent_key` rather than `parent_id` — see `manifest-diff.ts`. `requires` is
 * absent: mappings are their own pair of actions, with their own records.
 */
function navFields(node: CatalogNavNode | (DesiredNavNode & { is_active: boolean })) {
  return {
    kind: node.kind,
    label: node.label,
    route: node.route,
    icon: node.icon,
    sort_order: node.sort_order,
    is_public: node.is_public,
    parent_key: node.parent_key,
    is_active: node.is_active,
  };
}
