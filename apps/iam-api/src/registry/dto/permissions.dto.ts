/**
 * Request bodies for `/iam/applications/:id/permissions` (Doc 06 §4).
 *
 * Bulk by construction. Doc 02 §2 step 2 registers an application's permissions
 * as one call — "seed atomic permissions (bulk)" — because a catalog half
 * written is a catalog whose roles cannot be built, and the manifest upsert of
 * Session 14 is the same operation with a diff in front of it.
 */

import { z } from 'zod';
import { createZodDto } from '../../common/validation.pipe';

/**
 * How many permissions one call may carry.
 *
 * Generous — an application with two hundred atomic permissions is unusual but
 * not wrong — and present because the whole array runs in one transaction under
 * one request timeout. An unbounded body is an unbounded transaction.
 */
export const MAX_PERMISSIONS_PER_REQUEST = 200;

/**
 * A permission key: dotted, lowercase, at least two segments (Doc 02 §2).
 *
 * `gatepass.dc.approve`, `iam.platform.app.create`. The dot requirement is what
 * keeps keys namespaced — a bare `approve` in one application's catalog and
 * another's is a pair of keys nobody can tell apart in an audit row or a role
 * editor, and Doc 01 §6.3 addresses permissions globally.
 *
 * The key is deliberately **not** required to begin with the owning
 * application's own key. Doc 02 §2's example happens to (`gatepass.*` under
 * `gatepass`), and applications should, but the uniqueness that matters is the
 * `(application_id, key)` pair the schema enforces; adding a prefix rule here
 * would reject a legitimate catalog for a naming preference the spec does not
 * state.
 *
 * Exported for `manifest.dto.ts`, which validates the same keys arriving by the
 * declarative route — see `applications.dto.ts` for why the two must not have
 * separate definitions.
 */
export const permissionKey = z
  .string()
  .trim()
  .min(1, 'key is required')
  .max(160)
  .regex(
    /^[a-z][a-z0-9_-]*(\.[a-z0-9_-]+)+$/,
    'key must be dotted lowercase segments, e.g. "gatepass.dc.approve"',
  );

export const permissionInputSchema = z.object({
  key: permissionKey,
  /** What a role editor shows beside the checkbox (Doc 09) — human, not dotted. */
  name: z.string().trim().min(1, 'name is required').max(160),
  description: z.string().trim().max(1000).optional(),
});

/**
 * `POST /iam/applications/:id/permissions` (Doc 06 §4).
 *
 * Duplicate keys *within* one request are rejected here rather than left to the
 * unique index, and the difference is the answer the caller gets: the index
 * would fire on the second insert and produce a 409 that says the key already
 * exists — true, but only because this same request just created it, which is
 * the one explanation that would send an operator looking in the wrong place.
 */
export const createPermissionsSchema = z
  .object({
    permissions: z
      .array(permissionInputSchema)
      .min(1, 'at least one permission is required')
      .max(MAX_PERMISSIONS_PER_REQUEST),
  })
  .refine(
    (body) =>
      new Set(body.permissions.map((permission) => permission.key)).size ===
      body.permissions.length,
    { path: ['permissions'], message: 'permission keys must be unique within a request' },
  );

export class CreatePermissionsDto extends createZodDto(createPermissionsSchema) {}
