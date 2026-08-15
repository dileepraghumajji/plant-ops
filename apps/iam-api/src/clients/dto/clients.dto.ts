/**
 * Request bodies and query parameters for `/iam/clients` (Doc 06 §5).
 *
 * Same conventions as `registry/dto/*`: the field names are the spec's, and
 * every schema is a `z.object`, which **strips** unknown keys. That matters more
 * here than anywhere else in the API, because these bodies reach inserts on
 * *tenant* tables — a tolerated `id`, `client_id` or `is_client_admin` in a
 * create body would be a mass-assignment hole with a tenant boundary on the
 * other side of it.
 */

import { CLIENT_STATUS_VALUES } from '@plantops/contracts';
import { z } from 'zod';
import { passwordSchema } from '../../auth/password.util';
import { createZodDto } from '../../common/validation.pipe';
import { applicationKey } from '../../registry/dto/applications.dto';

/** How many applications one enablement call may carry. */
export const MAX_APPLICATIONS_PER_REQUEST = 100;

/**
 * The tenant slug — half of the login credential (Doc 03 §3).
 *
 * The pattern is migration 0003's `client_slug_format` check, spelled again in
 * the one place a caller can supply it: lowercase kebab-case, no leading,
 * trailing or doubled hyphens. Restated rather than left to the constraint
 * because a check violation arrives as a 500 with a generic message, and the
 * honest answer to a malformed slug is a 400 that says which rule it broke.
 *
 * The upper bound is this file's own: nothing in the schema caps it, and a slug
 * is something a person types into a login form.
 */
export const clientSlug = z
  .string()
  .trim()
  .toLowerCase()
  .min(1, 'slug is required')
  .max(64)
  .regex(
    /^[a-z0-9]+(-[a-z0-9]+)*$/,
    'slug must be lowercase alphanumeric segments separated by single hyphens, e.g. "acme-steel"',
  );

export const clientName = z.string().trim().min(1, 'name is required').max(160);

/**
 * Per-tenant settings (Doc 01 §3.4) — an opaque `jsonb` blob this API does not
 * interpret, for the reason `applications.dto.ts` leaves the application's alone.
 */
const config = z.record(z.string(), z.unknown());

/** `POST /iam/clients` (Doc 06 §5, Doc 02 §3 step 1). */
export const createClientSchema = z.object({
  name: clientName,
  slug: clientSlug,
  config: config.optional(),
});

export class CreateClientDto extends createZodDto(createClientSchema) {}

/**
 * `PATCH /iam/clients/:id` — update, or suspend / reactivate (Doc 06 §5).
 *
 * At least one field, so an empty body is a 400 rather than a 200 that audits a
 * change nobody made — the rule `updateApplicationSchema` follows.
 *
 * `slug` is deliberately absent. It is not merely a natural key: every user of
 * the tenant types it to log in (Doc 03 §3), so renaming it would lock out an
 * organisation while leaving every row in the database looking correct.
 */
export const updateClientSchema = z
  .object({
    name: clientName.optional(),
    status: z.enum(CLIENT_STATUS_VALUES).optional(),
    config: config.optional(),
  })
  .refine((body) => Object.keys(body).length > 0, {
    message: 'at least one field must be provided',
  });

export class UpdateClientDto extends createZodDto(updateClientSchema) {}

/**
 * One application being enabled for the client.
 *
 * Named by uuid **or** key, never both — the rule `navNodeInputSchema` applies
 * to a parent, for the same reason: the two could disagree, and silently
 * preferring one would make the request mean something the caller did not write.
 */
export const enableApplicationInputSchema = z
  .object({
    application_id: z.uuid().optional(),
    application_key: applicationKey.optional(),
    config: config.optional(),
  })
  .refine(
    (entry) =>
      (entry.application_id === undefined) !== (entry.application_key === undefined),
    {
      path: ['application_key'],
      message: 'name the application with application_id or application_key, not both',
    },
  );

/**
 * `POST /iam/clients/:id/applications` — bulk (Doc 02 §3 step 2).
 *
 * Bulk because enablement is how a tenant is handed its whole product surface at
 * once, and because the alternative — one call per application — makes partial
 * onboarding a state an operator can leave behind by closing a tab.
 *
 * Duplicates within one request are rejected here rather than left to the
 * primary key, for the reason `createPermissionsSchema` gives: the conflict
 * would be caused by this very request, which is the one explanation that sends
 * an operator looking in the wrong place. Both spellings are checked, since the
 * same application can be named by id in one entry and by key in another — that
 * pair is only caught once the keys are resolved, which the service does.
 */
export const enableApplicationsSchema = z
  .object({
    applications: z
      .array(enableApplicationInputSchema)
      .min(1, 'at least one application is required')
      .max(MAX_APPLICATIONS_PER_REQUEST),
  })
  .refine(
    (body) => {
      const named = body.applications.map(
        (entry) => entry.application_id ?? entry.application_key,
      );
      return new Set(named).size === named.length;
    },
    { path: ['applications'], message: 'applications must be unique within a request' },
  );

export class EnableApplicationsDto extends createZodDto(enableApplicationsSchema) {}

/** `PATCH /iam/clients/:id/applications/:appId` — the toggle (Doc 06 §5). */
export const updateClientApplicationSchema = z
  .object({
    enabled: z.boolean().optional(),
    config: config.optional(),
  })
  .refine((body) => Object.keys(body).length > 0, {
    message: 'at least one field must be provided',
  });

export class UpdateClientApplicationDto extends createZodDto(
  updateClientApplicationSchema,
) {}

/**
 * `POST /iam/clients/:id/admins` — the initial client admin (Doc 06 §5).
 *
 * `email` is lowercased here rather than in the service, because migration 0003
 * rejects anything else (`user_email_is_lowercase`) and the per-client
 * uniqueness index is only case-insensitive *because* the stored form is
 * normalised. Doing it at the boundary means there is one place where an address
 * becomes canonical.
 *
 * `password` reuses `passwordSchema` — the same Doc 03 §7 policy `/auth/password/reset`
 * applies — so the day-one credential cannot be weaker than one the user could
 * later choose for themselves. It is never echoed and never audited: `redact.ts`
 * denies the key outright, and the service does not put it in a payload anyway.
 */
export const createClientAdminSchema = z.object({
  email: z
    .string()
    .trim()
    .toLowerCase()
    .min(3)
    .max(320)
    .regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/, 'email must be a valid address'),
  full_name: z.string().trim().min(1, 'full_name is required').max(160),
  password: passwordSchema,
  phone: z.string().trim().min(1).max(32).optional(),
  /**
   * What the client's root scope node is called. Display only — the ltree label
   * is id-derived and a name never reaches `path` (Doc 01 §3.5), which is why a
   * hostile value here is a cosmetic problem rather than a structural one.
   */
  scope_name: z.string().trim().min(1).max(160).optional(),
});

export class CreateClientAdminDto extends createZodDto(createClientAdminSchema) {}

/**
 * `?page=&limit=` (Doc 06 §1).
 *
 * Spelled again rather than imported from the registry's DTOs: the two surfaces
 * are independent, and a shared query DTO is the coupling that makes one
 * endpoint's pagination change break another's.
 */
export const paginationSchema = z.object({
  page: z.coerce.number().int().optional(),
  limit: z.coerce.number().int().optional(),
});

export class PaginationDto extends createZodDto(paginationSchema) {}
