/**
 * Request bodies and query parameters for `/iam/applications` (Doc 06 §4).
 *
 * The same conventions as `auth.dto.ts` and `service-accounts.dto.ts`: the field
 * names are the spec's, and every schema is a `z.object`, which **strips**
 * unknown keys. That matters here because these bodies reach an `insert` and an
 * `update` on catalog tables — a tolerated `id`, `is_active` or `created_at` in
 * a create body is the mass-assignment hole.
 */

import { z } from 'zod';
import { createZodDto } from '../../common/validation.pipe';

/**
 * The machine key of an application — `gatepass`, `iam` (Doc 01 §3.1).
 *
 * Restricted to lowercase, digits, `-` and `_`, starting with a letter, because
 * this string is a *namespace*: it prefixes permission keys (Doc 02 §2), appears
 * in manifests keyed by it, and gets typed by hand into deployment config.
 * Allowing case would make `Gatepass` and `gatepass` two applications that read
 * as one, and the unique index would not save anyone from it.
 *
 * Exported because `manifest.dto.ts` validates the same field. Two spellings of
 * "what an application key is" would let a manifest name a key this endpoint
 * would refuse — which is the one disagreement the manifest, being the primary
 * registration path, must not have with the form path.
 */
export const applicationKey = z
  .string()
  .trim()
  .min(1, 'key is required')
  .max(64)
  .regex(
    /^[a-z][a-z0-9_-]*$/,
    'key must start with a lowercase letter and contain only lowercase letters, digits, "-" or "_"',
  );

export const displayName = z.string().trim().min(1, 'name is required').max(160);

/**
 * Bounded and optional. It is operator-authored prose rendered into an admin
 * screen (Doc 09), so the only rule it needs is a length that keeps a list view
 * usable.
 */
export const description = z.string().trim().max(1000);

/**
 * Per-application settings (Doc 01 §3.1) — an opaque `jsonb` blob this API does
 * not interpret.
 *
 * Left unvalidated beyond "is an object" on purpose: its contents belong to the
 * application, and a schema here would have to be updated every time a module
 * added a setting, which is the deploy-to-change the registry exists to avoid
 * (Doc 02 §8).
 */
const config = z.record(z.string(), z.unknown());

/** `POST /iam/applications` (Doc 06 §4). */
export const createApplicationSchema = z.object({
  key: applicationKey,
  name: displayName,
  description: description.optional(),
  config: config.optional(),
});

export class CreateApplicationDto extends createZodDto(createApplicationSchema) {}

/**
 * `PATCH /iam/applications/:id` — update, or activate / deactivate (Doc 06 §4).
 *
 * Every field is optional and at least one is required, so a `{}` body is a 400
 * rather than a silent no-op that still answers 200 and writes an audit record
 * saying nothing changed.
 *
 * `key` is deliberately not patchable. It is the natural key that manifest
 * uploads (Doc 02 §2), permission addresses (Doc 01 §6.3) and deployed consumers
 * are all written against; renaming it would re-point a whole catalog while
 * every foreign key kept pointing at the same uuid, so nothing would look
 * broken until something was.
 *
 * `description` accepts `null` — clearing a description is a real edit, and
 * `undefined` cannot express it because that is how "leave it alone" is spelled.
 */
export const updateApplicationSchema = z
  .object({
    name: displayName.optional(),
    description: description.nullable().optional(),
    is_active: z.boolean().optional(),
    config: config.optional(),
  })
  .refine((body) => Object.keys(body).length > 0, {
    message: 'at least one field must be provided',
  });

export class UpdateApplicationDto extends createZodDto(updateApplicationSchema) {}

/**
 * `?page=&limit=` (Doc 06 §1).
 *
 * Coerced because query parameters arrive as strings, and left unbounded because
 * `normalizePagination` clamps both — the same reasoning, and the same shape, as
 * `service-accounts.dto.ts`. Spelled again rather than imported across feature
 * folders: the two surfaces are independent, and a shared query DTO is the kind
 * of coupling that makes one endpoint's pagination change break another's.
 */
export const paginationSchema = z.object({
  page: z.coerce.number().int().optional(),
  limit: z.coerce.number().int().optional(),
});

export class PaginationDto extends createZodDto(paginationSchema) {}
