/**
 * The manifest body of `POST /iam/applications/:id/manifest` (Doc 02 §2, §7).
 *
 * ## This schema validates a *document*, not a form
 *
 * Every other body in this folder arrives from the admin UI. A manifest arrives
 * from a file in an application's repository, written by hand, uploaded by a CI
 * job or by `tools/upload-manifest.ts`. Two consequences follow, and they are
 * the reasons this file does not simply reuse the shapes next door.
 *
 * **It is `strictObject`, not `object`.** Everywhere else, stripping unknown
 * keys is the mass-assignment defence — a tolerated `is_active` in a create body
 * is a hole. Here the threat is the opposite one: the caller is a platform admin
 * uploading their own file, and a silently dropped key is a menu that does not
 * appear with no error to explain it. `sort_order` instead of `sortOrder`,
 * `permission` instead of `permissions`, a typo in `icon` — stripping turns each
 * of those into a successful upload with the wrong result, which the operator
 * then debugs against the database. Rejecting names the field.
 *
 * **It is camelCase**, because {@link ApplicationManifest} is. The document
 * shape has been published since Session 1 and applications are written against
 * it; the *response* is snake_case like every other one (see `manifest.ts` in
 * contracts).
 *
 * ## Everything checkable is checked here, before a transaction exists
 *
 * "A mid-manifest validation failure changes nothing" is this session's
 * acceptance criterion. The request transaction already guarantees that by
 * rolling back, but the stronger and more useful version is to fail before any
 * statement runs at all, with an error that names the offending path. So the
 * cross-entity rules a single node cannot see — duplicate keys anywhere in the
 * tree, a `requires` naming a permission the manifest does not declare, an
 * `isPublic` container — live in {@link applicationManifestSchema}'s
 * `superRefine` rather than in the service.
 *
 * What is *not* checkable here is anything about the catalog already in the
 * database. That belongs to `manifest.service.ts`, which is the only place that
 * knows it.
 */

import { NAV_NODE_KIND_VALUES, type ManifestNavNode } from '@plantops/contracts';
import { z } from 'zod';
import { createZodDto } from '../../common/validation.pipe';
import { applicationKey, description, displayName } from './applications.dto';
import { navKey, navRoute } from './nav.dto';
import { permissionKey } from './permissions.dto';

/** Matching `MAX_PERMISSIONS_PER_REQUEST` — one manifest is one transaction. */
export const MAX_MANIFEST_PERMISSIONS = 200;

/** Nodes in the whole tree, not per level. Matching `MAX_NAV_NODES_PER_REQUEST`. */
export const MAX_MANIFEST_NAV_NODES = 200;

/** Permission keys one node may be gated by (OR semantics, Doc 01 §4.4). */
export const MAX_MANIFEST_REQUIRES_PER_NODE = 50;

/**
 * `module` → `menu` → `sub_menu` (Doc 01 §3.3).
 *
 * The model has exactly three tiers and the Postgres enum has exactly three
 * labels, so a fourth level of nesting is an authoring mistake rather than a
 * deep tree — and it would render as a menu nobody can reach, since the admin
 * shell draws three (Doc 05 §4). The kind of each node is deliberately *not*
 * pinned to its depth: nothing in the schema requires a `sub_menu` to sit under
 * a `menu`, and inventing that rule here would reject catalogs the imperative
 * route accepts.
 */
export const MAX_MANIFEST_NAV_DEPTH = 3;

export const manifestPermissionSchema = z.strictObject({
  key: permissionKey,
  name: displayName,
  description: description.optional(),
});

/**
 * One nav node and, recursively, its children.
 *
 * The explicit annotation is what makes the recursion type-check: `z.lazy`
 * cannot infer a type that refers to itself, and without it the schema widens to
 * `any` — at which point the checks below are still enforced at runtime but the
 * handler's parameter stops being typed.
 */
export const manifestNavNodeSchema: z.ZodType<ManifestNavNode> = z.lazy(() =>
  z
    .strictObject({
      kind: z.enum(NAV_NODE_KIND_VALUES),
      key: navKey,
      label: displayName,
      /** Omitted on a pure container — a node that groups rather than navigates. */
      route: navRoute.optional(),
      icon: z.string().trim().min(1).max(64).optional(),
      /**
       * Optional, and rarely worth writing: a node without one takes its
       * position in the array it was declared in (`manifest-diff.ts`). Give one
       * only to pin an order the document's own order does not express.
       */
      sortOrder: z.number().int().min(0).max(100_000).optional(),
      isPublic: z.boolean().optional(),
      requires: z.array(permissionKey).max(MAX_MANIFEST_REQUIRES_PER_NODE).optional(),
      children: z.array(manifestNavNodeSchema).optional(),
    })
    .refine((node) => !(node.isPublic === true && (node.children?.length ?? 0) > 0), {
      path: ['isPublic'],
      message:
        'isPublic applies to leaves only — a container is visible when a descendant is (Doc 05 §3)',
    }),
);

/**
 * The manifest (Doc 02 §2).
 *
 * `permissions` and `nav` are required and may be empty. An empty array is a
 * real declaration — "this application has no permissions any more" — and it
 * deactivates what is there, which is the shrink half of Doc 02 §7. Omitting the
 * field entirely is an accident, and it would silently mean the same thing.
 */
export const applicationManifestSchema = z
  .strictObject({
    key: applicationKey,
    name: displayName,
    description: description.optional(),
    permissions: z.array(manifestPermissionSchema).max(MAX_MANIFEST_PERMISSIONS),
    nav: z.array(manifestNavNodeSchema).max(MAX_MANIFEST_NAV_NODES),
  })
  .superRefine((manifest, ctx) => {
    const declared = new Set<string>();
    manifest.permissions.forEach((permission, index) => {
      if (declared.has(permission.key)) {
        ctx.addIssue({
          code: 'custom',
          path: ['permissions', index, 'key'],
          message: `duplicate permission key "${permission.key}"`,
        });
      }
      declared.add(permission.key);
    });

    const seen = new Set<string>();
    let total = 0;

    for (const { node, path, depth } of walk(manifest.nav)) {
      total += 1;

      if (seen.has(node.key)) {
        ctx.addIssue({
          code: 'custom',
          path: [...path, 'key'],
          message: `duplicate nav key "${node.key}" — keys are unique across the whole tree`,
        });
      }
      seen.add(node.key);

      if (depth > MAX_MANIFEST_NAV_DEPTH) {
        ctx.addIssue({
          code: 'custom',
          path,
          message: `nav nesting is at most ${MAX_MANIFEST_NAV_DEPTH} deep (module → menu → sub_menu)`,
        });
      }

      // A `requires` key the manifest does not declare is refused even when the
      // application already has a permission by that name, and that is the
      // point: this same upload deactivates undeclared keys, so gating a node on
      // one would map a menu to a permission nobody can hold by the time the
      // transaction commits.
      node.requires?.forEach((key, index) => {
        if (!declared.has(key)) {
          ctx.addIssue({
            code: 'custom',
            path: [...path, 'requires', index],
            message: `"${key}" is not declared in this manifest's permissions`,
          });
        }
      });
    }

    if (total > MAX_MANIFEST_NAV_NODES) {
      ctx.addIssue({
        code: 'custom',
        path: ['nav'],
        message: `a manifest may declare at most ${MAX_MANIFEST_NAV_NODES} nav nodes in total`,
      });
    }
  });

export class ApplicationManifestDto extends createZodDto(applicationManifestSchema) {}

/**
 * `?dryRun=` — preview instead of apply (Doc 09 §2.1).
 *
 * The upload screen shows an operator what a manifest would do *before* it does
 * it, and the only honest way to produce that is to compute it the way the real
 * upload computes it: same snapshot, same `computeManifestPlan`, same
 * `ManifestDiff`. So the preview is this endpoint with a flag rather than a
 * second route with a second implementation — see `manifest.service.ts` for
 * where the two paths part company (one statement after the plan is built).
 *
 * `z.stringbool()` rather than `z.coerce.boolean()`, and the distinction is the
 * whole reason this is spelled out: `Boolean("false")` is `true`, so a coerced
 * `?dryRun=false` would *write the catalog* on a request that asked not to. This
 * accepts the spellings a caller might reasonably send — `true`/`false`,
 * `1`/`0`, `yes`/`no`, `on`/`off` — and rejects anything else with a 400 rather
 * than guessing.
 *
 * Absent means `false`: a `POST …/manifest` with no query string is the upload,
 * exactly as it was before this parameter existed.
 */
export const manifestQuerySchema = z.object({
  dryRun: z.stringbool().optional(),
});

export class ManifestQueryDto extends createZodDto(manifestQuerySchema) {}

/** Every node of a manifest tree, depth-first, with its path and 1-based depth. */
function* walk(
  nodes: readonly ManifestNavNode[],
  path: (string | number)[] = ['nav'],
  depth = 1,
): Generator<{ node: ManifestNavNode; path: (string | number)[]; depth: number }> {
  for (const [index, node] of nodes.entries()) {
    const here = [...path, index];
    yield { node, path: here, depth };
    if (node.children !== undefined) {
      yield* walk(node.children, [...here, 'children'], depth + 1);
    }
  }
}
