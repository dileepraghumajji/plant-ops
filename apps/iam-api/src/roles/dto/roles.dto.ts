/**
 * Request bodies and query parameters for `/iam/roles` (Doc 06 §7).
 *
 * Same conventions as `clients/dto/*` and `scopes/dto/*`: the field names are the
 * spec's, and every schema is a `z.object`, which **strips** unknown keys. These
 * bodies reach inserts on a tenant table, so the stripping is load-bearing —
 * `client_id` in a create body would place a role under another tenant, and
 * `is_system` would let a tenant mint a role it can never delete.
 *
 * What no schema here can decide is the rule this session exists for: whether a
 * permission belongs to an application **enabled for the caller's client**
 * (Doc 02 §6). That is a question about rows, and `RolesService` asks it.
 */

import { MAX_PERMISSIONS_PER_ROLE } from '@plantops/contracts';
import { z } from 'zod';
import { createZodDto } from '../../common/validation.pipe';

/**
 * The role name (Doc 01 §4.2).
 *
 * Trimmed and length-bounded; the non-blank rule restates migration 0003's
 * `role_name_not_blank`, so a whitespace-only name is a 400 that says so rather
 * than a 500 from a check violation. Uniqueness within the client is the index's
 * job and arrives as a 409 — a schema cannot ask what other rows exist.
 *
 * The 160-character bound matches `clientName` and `scopeNodeName`: these are all
 * display strings an operator types into the same admin console.
 */
export const roleName = z.string().trim().min(1, 'name is required').max(160);

/** Prose shown beside the name in the role list (Doc 09 §3.2). */
const roleDescription = z.string().trim().max(1000);

/** `POST /iam/roles` (Doc 06 §7). */
export const createRoleSchema = z.object({
  name: roleName,
  description: roleDescription.optional(),
});

export class CreateRoleDto extends createZodDto(createRoleSchema) {}

/**
 * `PATCH /iam/roles/:id` — rename, and edit the description (Doc 06 §7).
 *
 * At least one field, so an empty body is a 400 rather than a 200 that audits a
 * change nobody made — the rule `updateClientSchema` follows.
 *
 * `is_system` is absent for the reason it is absent from the create body, and
 * `permissions` because setting those is a `PUT` with its own validation
 * (Doc 02 §6) rather than a field of the role.
 */
export const updateRoleSchema = z
  .object({
    name: roleName.optional(),
    description: roleDescription.optional(),
  })
  .refine((body) => Object.keys(body).length > 0, {
    message: 'at least one field must be provided',
  });

export class UpdateRoleDto extends createZodDto(updateRoleSchema) {}

/**
 * `PUT /iam/roles/:id/permissions` (Doc 06 §7).
 *
 * The whole set, replacing whatever is there. An **empty array is accepted** and
 * means the role maps nothing: it is the only way to clear a role's permissions,
 * and refusing it would leave "unmap the last one" as an operation with no
 * request that expresses it.
 *
 * Duplicates within one array are rejected rather than silently collapsed. The
 * primary key would collapse them anyway, so nothing is protected by the refusal
 * except the caller's understanding of what they sent — a picker that submits the
 * same id twice has a bug, and a 200 would hide it.
 */
export const setRolePermissionsSchema = z
  .object({
    permission_ids: z.array(z.uuid()).max(MAX_PERMISSIONS_PER_ROLE),
  })
  .refine(
    (body) => new Set(body.permission_ids).size === body.permission_ids.length,
    {
      path: ['permission_ids'],
      message: 'permission_ids must be unique within a request',
    },
  );

export class SetRolePermissionsDto extends createZodDto(setRolePermissionsSchema) {}

/**
 * `?page=&limit=` (Doc 06 §1).
 *
 * Spelled again rather than imported from `clients/dto/clients.dto.ts`, for the
 * reason that one gives for not importing the registry's: the surfaces are
 * independent, and a shared query DTO is the coupling that makes one endpoint's
 * pagination change break another's.
 */
export const rolesPaginationSchema = z.object({
  page: z.coerce.number().int().optional(),
  limit: z.coerce.number().int().optional(),
});

export class RolesPaginationDto extends createZodDto(rolesPaginationSchema) {}
