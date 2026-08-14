/**
 * Request bodies and query parameters for `/iam/service-accounts` (Doc 06 §10).
 *
 * As in `auth.dto.ts`, the field names are the spec's and every schema is a
 * `z.object`, which **strips** unknown keys rather than tolerating them. That
 * matters more here than on most surfaces: the create body reaches an `insert`,
 * and a tolerated `client_id`, `key` or `status` in it is the mass-assignment
 * hole — the tenant comes from the verified `cid` and the key is generated, so
 * neither is a thing a caller may name.
 */

import { SERVICE_ACCOUNT_STATUS_VALUES } from '@plantops/contracts';
import { z } from 'zod';
import { createZodDto } from '../common/validation.pipe';

/**
 * `POST /iam/service-accounts`.
 *
 * The name is the whole body. It is what an operator will read in the account
 * list six months from now — "Gatepass module", not a uuid — so it is required
 * and bounded, and nothing else about the account is caller-decided.
 */
export const createServiceAccountSchema = z.object({
  name: z.string().trim().min(1, 'name is required').max(120),
});

export class CreateServiceAccountDto extends createZodDto(createServiceAccountSchema) {}

/**
 * `PATCH /iam/service-accounts/:id` — revoke, or reactivate (Doc 06 §10).
 *
 * A closed enum rather than a boolean `revoked` flag, because the two states are
 * the column's own vocabulary (Doc 01 §3.7) and a caller sending the status it
 * wants is a request that reads the same as the row it produces.
 */
export const updateServiceAccountSchema = z.object({
  status: z.enum(SERVICE_ACCOUNT_STATUS_VALUES),
});

export class UpdateServiceAccountDto extends createZodDto(updateServiceAccountSchema) {}

/**
 * `?page=&limit=` (Doc 06 §1).
 *
 * Coerced, because query parameters arrive as strings — and left *unbounded*
 * here on purpose: `normalizePagination` clamps both values to the contract's
 * limits, so a `limit=10000` is quietly served as 100 rather than refused. A 400
 * would be defensible; matching the shared helper is better, since every list
 * endpoint from Session 13 onwards will use the same one and they should not
 * disagree about what an out-of-range page means.
 */
export const paginationSchema = z.object({
  page: z.coerce.number().int().optional(),
  limit: z.coerce.number().int().optional(),
});

export class PaginationDto extends createZodDto(paginationSchema) {}
