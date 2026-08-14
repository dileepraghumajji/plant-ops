/**
 * Request bodies for `/iam/applications/:id/nav` and `…/nav-permissions`
 * (Doc 06 §4, Doc 02 §2 steps 3–4).
 *
 * Bulk for the reason permissions are: Doc 02 §2 builds a module/menu/sub_menu
 * tree in one call, and a tree written half-way is a menu with orphaned
 * branches.
 */

import { NAV_NODE_KIND_VALUES } from '@plantops/contracts';
import { z } from 'zod';
import { createZodDto } from '../../common/validation.pipe';

/** One call's ceiling, for the reason `MAX_PERMISSIONS_PER_REQUEST` has one. */
export const MAX_NAV_NODES_PER_REQUEST = 200;

/** How many `(nav node, permission)` pairs one mapping call may carry. */
export const MAX_NAV_MAPPINGS_PER_REQUEST = 200;
export const MAX_PERMISSIONS_PER_MAPPING = 50;

/**
 * A nav node key — unique within the application, and the manifest upsert's
 * natural key (Doc 02 §7).
 *
 * Looser than a permission key: it needs no dot, because it is already scoped by
 * the application and by its position in the tree. `dc.approvals` and `settings`
 * are both fine.
 *
 * Exported for `manifest.dto.ts` — see `applications.dto.ts` for why the two
 * routes into the catalog must agree on what a key is.
 */
export const navKey = z
  .string()
  .trim()
  .min(1, 'key is required')
  .max(160)
  .regex(
    /^[a-z0-9][a-z0-9._-]*$/,
    'key must be lowercase alphanumeric, optionally separated by ".", "-" or "_"',
  );

/**
 * A frontend path (Doc 05 §7). Relative, and required to begin with `/`.
 *
 * Rejecting an absolute URL is the point: `route` is rendered into the admin
 * shell's router, and a node whose route is `https://…` turns a menu entry into
 * an off-site redirect that the person who added the node chose, not the one who
 * clicked it.
 */
export const navRoute = z
  .string()
  .trim()
  .min(1)
  .max(512)
  .regex(/^\/[^\s]*$/, 'route must be a relative path beginning with "/"');

export const navNodeInputSchema = z
  .object({
    kind: z.enum(NAV_NODE_KIND_VALUES),
    key: navKey,
    /** What the menu actually shows (Doc 05 §4). */
    label: z.string().trim().min(1, 'label is required').max(160),
    /** Omitted on a pure container — a node that groups rather than navigates. */
    route: navRoute.optional(),
    /** An icon *key*; the frontend maps it to its own set (Doc 05 §7). */
    icon: z.string().trim().min(1).max(64).optional(),
    sort_order: z.number().int().min(0).max(100_000).optional(),
    /**
     * Leaf-only opt-in making an *unmapped* leaf visible to anyone who can see
     * the app (Doc 05 §3). Defaults to false at the column, which is
     * deny-by-default and the reason it must be said explicitly to be true.
     */
    is_public: z.boolean().optional(),
    /**
     * The parent, named either way — both optional, because a top-level node
     * has none. `parent_key` resolves within this application (including nodes
     * created earlier in the same request); `parent_id` is the uuid a caller
     * already holds. Naming both is a 400 rather than a silent preference for
     * one, since the two could disagree.
     */
    parent_id: z.uuid().optional(),
    parent_key: navKey.optional(),
  })
  .refine((node) => node.parent_id === undefined || node.parent_key === undefined, {
    path: ['parent_key'],
    message: 'name the parent with parent_id or parent_key, not both',
  });

/**
 * `POST /iam/applications/:id/nav` (Doc 06 §4).
 *
 * Nodes are created **in the order given**, and `parent_key` may name one
 * created earlier in the same request — that is what lets a single call build a
 * module and hang its menus off it. Duplicate keys within the request are
 * rejected here for the reason duplicate permission keys are: the unique index
 * would report a conflict caused by this very request.
 */
export const createNavNodesSchema = z
  .object({
    nodes: z
      .array(navNodeInputSchema)
      .min(1, 'at least one node is required')
      .max(MAX_NAV_NODES_PER_REQUEST),
  })
  .refine(
    (body) => new Set(body.nodes.map((node) => node.key)).size === body.nodes.length,
    { path: ['nodes'], message: 'nav node keys must be unique within a request' },
  );

export class CreateNavNodesDto extends createZodDto(createNavNodesSchema) {}

/**
 * `POST` and `DELETE /iam/applications/:id/nav-permissions` (Doc 02 §2 step 4).
 *
 * Both directions share this body because they are one statement run two ways.
 * Everything is named by key rather than by uuid: the route already fixes the
 * application, keys are what a manifest is written in, and a caller that has
 * just created a tree by key should not have to hold a uuid map to gate it.
 */
export const navPermissionsSchema = z.object({
  mappings: z
    .array(
      z.object({
        nav_key: navKey,
        permission_keys: z
          .array(z.string().trim().min(1).max(160))
          .min(1, 'at least one permission key is required')
          .max(MAX_PERMISSIONS_PER_MAPPING),
      }),
    )
    .min(1, 'at least one mapping is required')
    .max(MAX_NAV_MAPPINGS_PER_REQUEST),
});

export class NavPermissionsDto extends createZodDto(navPermissionsSchema) {}
