/**
 * `GET /iam/navigation` — the menu, resolved (Doc 05, Doc 06 §11).
 *
 * ## What this endpoint is for
 *
 * Doc 05 §1: "Add a menu in the admin UI, map a permission to it, and it appears
 * for exactly the users who hold that permission — with no deploy. This is the
 * visible proof that the registry is working." Session 13 built the writers,
 * Session 21 built the grant resolution, and this is the one place the two are
 * multiplied together and handed to a frontend that keeps no menu constants of
 * its own (Doc 05 §7).
 *
 * The algorithm is Doc 05 §5, and it is in `prune.ts` as a pure function over
 * plain values. What is left here is the four lookups it needs: is the
 * application enabled for this tenant, what does the subject hold, what does the
 * catalog contain, and — for the shell — which applications are enabled at all.
 *
 * ## Grants come from the cache, and from the *unfiltered* cache
 *
 * Doc 05 §5 line 3: `grants ← resolve(subject, client).permissions # from cache
 * (Doc 04)`. So this calls {@link ResolverService.grantsFor} with no
 * `applicationId`, which is the read-through cached path — the filtered form is
 * deliberately never cached (`resolver.service.ts` explains why: Doc 04 §6 fixes a
 * key with no application component in it). Passing the application here would
 * therefore turn every navigation call into a Postgres resolve, and the shell
 * variant needs the whole set regardless.
 *
 * The cost of using the unfiltered set is a theoretical one worth naming:
 * permission keys are unique *per application* rather than globally
 * (`registry/dto/permissions.dto.ts`), so two applications could both declare
 * `foo.read`, and a subject holding one would satisfy a gate on the other. Doc 01
 * §3.2 makes keys `app.resource.action` — namespaced by their owning application —
 * precisely so that cannot happen, and the same bare-key matching is already what
 * `@RequirePermission` and `ScopeResolver` do everywhere else in the system. A
 * navigation endpoint that answered differently from the guard protecting the
 * screen behind it would be the worse inconsistency.
 *
 * ## Enablement is read from Postgres on every call, never cached
 *
 * `client_application` is tenant data (migration 0009), and it is the row that
 * decides whether a tenant may see an application at all (Doc 02 §6). It is also
 * the cheapest of the lookups — one indexed row — and the one whose staleness
 * would be least forgivable: an application disabled for a tenant must vanish
 * from their menu immediately, and Doc 04 §7 already treats that toggle as
 * invalidating. Only the *catalog*, which belongs to no tenant, is cached.
 *
 * ## An application the caller may not see is an empty answer, not a 404
 *
 * Doc 05 §5's first line is `if not client_application(client, applicationId)
 * .enabled: return empty`, and this returns exactly that — `{ application: null,
 * tree: [] }` — for all four ways the question can fail: no such application,
 * deactivated platform-wide (Doc 02 §7), not enabled for this tenant, or enabled
 * but switched off. Collapsing them is the point. A 404 that distinguished "no
 * such application" from "not yours" would make an unprivileged, permission-free
 * endpoint into an oracle over the platform catalog, which is the thing Doc 06 §2
 * forbids a response to reveal. The caller knows whether it sent an
 * `applicationId`, so `application: null` is unambiguous to the only reader that
 * matters.
 */

import { Injectable } from '@nestjs/common';
import {
  NavNodeKind,
  type ApplicationSummaryDTO,
  type NavNodeDTO,
  type NavigationResponse,
} from '@plantops/contracts';
import { IAM_SCHEMA } from '@plantops/db';
import type { EntityManager } from 'typeorm';
import { ResolverService, type SubjectRef } from '../authz/resolver.service';
import { NavCatalogCacheService } from './nav-catalog-cache.service';
import { pruneNavTree, type NavCatalog, type NavCatalogNode } from './prune';

const S = `"${IAM_SCHEMA}"`;

@Injectable()
export class NavigationService {
  constructor(
    private readonly resolver: ResolverService,
    private readonly catalogs: NavCatalogCacheService,
  ) {}

  /**
   * The subject's menu — one application's tree, or the cross-application shell
   * (Doc 05 §4).
   *
   * @param manager the request transaction. Passed explicitly for the same reason
   * `authz.controller.ts` passes it: {@link ResolverService} takes its executor as
   * a parameter (`docs/adr/0001-permission-guard-connection-strategy.md`), and a
   * navigation call reads the catalog on whatever connection resolved the grants.
   */
  async navigationFor(
    manager: EntityManager,
    subject: SubjectRef,
    applicationId?: string,
  ): Promise<NavigationResponse> {
    return applicationId === undefined
      ? this.shell(manager, subject)
      : this.forApplication(manager, subject, applicationId);
  }

  /**
   * One application's pruned tree (Doc 05 §4, §5).
   *
   * Enablement first, so a caller naming an application they may not see pays for
   * neither a resolve nor a catalog read.
   */
  private async forApplication(
    manager: EntityManager,
    subject: SubjectRef,
    applicationId: string,
  ): Promise<NavigationResponse> {
    const [application] = await this.enabledApplications(
      manager,
      subject.clientId,
      applicationId,
    );
    if (application === undefined) return { application: null, tree: [] };

    const held = await this.heldPermissions(manager, subject);
    const catalog = await this.catalogOf(manager, application.id);

    return { application, tree: pruneNavTree(catalog, held) };
  }

  /**
   * The unified shell — one top-level node per enabled application, each
   * expandable (Doc 05 §4).
   *
   * ## The synthetic top level
   *
   * An application is not a `nav_node`, so the node standing for it is built here
   * rather than read: its `id` and `key` are the application's own, its `label` is
   * the application's name, and its `kind` is `module` because that is what the
   * enum has for "a container at the top of a tree" (Doc 01 §3.3). It carries no
   * `route` — a shell entry expands, it does not navigate.
   *
   * ## An application contributing nothing is dropped
   *
   * The app node is a container, so Doc 05 §3 rule 2 applies to it like any
   * other: "visible iff at least one descendant leaf is visible. Empty containers
   * are pruned." Enablement decides which applications are *candidates*; the
   * grants decide which of them the subject can actually enter.
   *
   * This is the one place the roadmap's wording ("one top-level node per enabled
   * app") and the algorithm could be read apart, so the two arguments that settle
   * it are worth having here rather than in a commit message:
   *
   * 1. **Doc 05 §7 leaves the server as the only place pruning can happen.** The
   *    console "renders the returned tree directly — it does not maintain its own
   *    menu constants". A node with an empty `children` is therefore not neutral
   *    data; it is a rendered sidebar entry that expands to nothing. Emitting one
   *    obliges the frontend to grow exactly the menu logic §7 forbids it.
   * 2. **`is_public` is already the per-application escape hatch.** An
   *    application that should appear for anyone its tenant enabled it for marks
   *    its landing node `is_public` — Doc 05 §3 rule 1's stated use case, "e.g. an
   *    app landing page". That keeps "always visible" a choice made by whoever
   *    writes the manifest, per application. Returning empty containers instead
   *    would take the choice away and make every application behave as though its
   *    landing page were public.
   *
   * So the roadmap's phrase is about the *shape* of the answer — one node per
   * application rather than one merged tree — which is what this returns.
   *
   * ## Ordering
   *
   * By name, then key. Doc 05 §3 rule 4 orders siblings by `sort_order`, and an
   * `application` row has none — so the choice is this file's, and a menu is
   * ordered by what the user reads. `key` breaks the tie so the answer is stable
   * for two applications sharing a name.
   */
  private async shell(
    manager: EntityManager,
    subject: SubjectRef,
  ): Promise<NavigationResponse> {
    const applications = await this.enabledApplications(manager, subject.clientId);
    if (applications.length === 0) return { application: null, tree: [] };

    const held = await this.heldPermissions(manager, subject);

    const tree: NavNodeDTO[] = [];
    for (const application of applications) {
      const children = pruneNavTree(await this.catalogOf(manager, application.id), held);
      if (children.length === 0) continue;

      tree.push({
        id: application.id,
        kind: NavNodeKind.MODULE,
        key: application.key,
        label: application.name,
        route: null,
        icon: null,
        children,
      });
    }

    return { application: null, tree };
  }

  /** The subject's held permission keys, from the cached grant set (Doc 04 §6). */
  private async heldPermissions(
    manager: EntityManager,
    subject: SubjectRef,
  ): Promise<ReadonlySet<string>> {
    const grants = await this.resolver.grantsFor(manager, subject);
    return new Set(grants.permissions);
  }

  /**
   * The applications this tenant may see, optionally narrowed to one.
   *
   * Three conditions, and each is a different switch with a different owner:
   * `ca.enabled` is the tenant's own toggle (Doc 06 §5), `a.is_active` is the
   * platform's global one (Doc 02 §7), and `ca.client_id` is the tenant itself.
   * The client is pinned in the predicate as well as by RLS, for the reason
   * `resolver.service.ts` gives: it lets the planner use the tenant-scoped index,
   * and it keeps the query from depending on somebody else having set the context.
   */
  private async enabledApplications(
    manager: EntityManager,
    clientId: string,
    applicationId?: string,
  ): Promise<ApplicationSummaryDTO[]> {
    const parameters: unknown[] = [clientId];
    let narrowing = '';

    if (applicationId !== undefined) {
      parameters.push(applicationId);
      narrowing = `and ca.application_id = $${parameters.length}::uuid`;
    }

    return (await manager.query(
      `select a.id, a.key, a.name
         from ${S}."client_application" ca
         join ${S}."application" a on a.id = ca.application_id
        where ca.client_id = $1::uuid
          and ca.enabled
          and a.is_active
          ${narrowing}
        order by a.name asc, a.key asc`,
      parameters,
    )) as ApplicationSummaryDTO[];
  }

  /** The application's active catalog, from Redis when it can be trusted. */
  private async catalogOf(
    manager: EntityManager,
    applicationId: string,
  ): Promise<NavCatalog> {
    const cached = await this.catalogs.read(applicationId);
    if (cached.catalog !== null) return cached.catalog;

    const catalog = await this.readCatalog(manager, applicationId);

    // With the version observed *before* the read, never one read after it — the
    // rule `resolver.service.ts` states for grants, and the reason is the same: a
    // bump that landed in between must leave this entry stamped stale rather than
    // stamped current.
    await this.catalogs.write(applicationId, catalog, cached.version);
    return catalog;
  }

  /**
   * The catalog, from Postgres (Doc 05 §5 lines 4–5).
   *
   * Two statements rather than one join, because they answer differently shaped
   * questions: the nodes are a tree and the gates are a many-to-many over it, and
   * a single join would return one row per `(node, permission)` pair — every
   * ungated node lost to an inner join, or every node's columns repeated by an
   * outer one. `registry/nav.service.ts`'s `tree()` splits them for the same
   * reason.
   *
   * `is_active` is applied to the nodes here (Doc 05 §3 rule 4) and *not* to the
   * permissions behind the gates, which is deliberate. A permission that a
   * manifest re-upload soft-deactivated (Doc 02 §7) keeps its `menu_permission`
   * row — the row is what makes re-declaring the key restore the gate — and
   * `resolve()` already drops the key from every grant set. So the leaf stays
   * *mapped* and becomes unsatisfiable, which hides it. Dropping the inactive key
   * from the gate list instead would make the leaf look *unmapped*, and an
   * unmapped leaf with `is_public = true` would then become visible to everyone —
   * a retired permission opening a screen up, which is the wrong direction for
   * Invariant I3 to fail in.
   */
  private async readCatalog(
    manager: EntityManager,
    applicationId: string,
  ): Promise<NavCatalog> {
    const nodes = (await manager.query(
      `select id, parent_id, kind, key, label, route, icon, is_public
         from ${S}."nav_node"
        where application_id = $1::uuid and is_active
        order by sort_order asc, key asc`,
      [applicationId],
    )) as NavCatalogNode[];

    const mapped = (await manager.query(
      `select mp.nav_node_id, p.key
         from ${S}."menu_permission" mp
         join ${S}."permission" p on p.id = mp.permission_id
         join ${S}."nav_node" n on n.id = mp.nav_node_id
        where n.application_id = $1::uuid and n.is_active
        order by p.key asc`,
      [applicationId],
    )) as { nav_node_id: string; key: string }[];

    const gates: Record<string, string[]> = {};
    for (const row of mapped) {
      const keys = gates[row.nav_node_id];
      if (keys === undefined) gates[row.nav_node_id] = [row.key];
      else keys.push(row.key);
    }

    return { nodes, gates };
  }
}
