/**
 * Query parameters for `GET /iam/audit` and its export (Doc 06 §12).
 *
 * Same conventions as every other query DTO on this surface: snake_case field
 * names matching the columns they filter, `z.coerce` where a query string has to
 * become a number, and `z.object`, which **strips** unknown keys.
 *
 * ## `action` and `target_type` are validated against the catalog
 *
 * Both are open `text` columns (migration 0005) and both are typed as plain
 * strings on the read shape, because rows outlive the catalog that wrote them
 * (`contracts/audit.ts`). The *filter* is narrower on purpose: a caller may only
 * ask for values this system's writers can produce.
 *
 * That asymmetry is the useful direction. A filter is a question, and a question
 * naming an action no writer has ever emitted has exactly one honest answer —
 * "you have misspelled `user.diabled`" — which a 400 gives immediately and an
 * empty page gives never. The published document lists the catalog as an enum,
 * so a console builds its filter dropdown from the API rather than from a copy.
 *
 * The cost is that an action retired in some later version stops being
 * *filterable* while remaining readable and exportable. That is the right way
 * round: the trail keeps everything, and the query surface tracks the vocabulary
 * the system currently speaks.
 *
 * ## Dates are instants, not days
 *
 * `from` and `to` are ISO-8601 datetimes with an offset, half-open
 * (`contracts/audit.ts`). A bare `2026-08-18` is refused, deliberately: a date
 * with no zone is ambiguous by up to a day at each boundary, and an audit query
 * whose range depends on the reader's timezone is one whose answer nobody else
 * can reproduce. A console sends the instant it means.
 */

import { AUDIT_ACTOR_TYPE_VALUES } from '@plantops/contracts';
import { z } from 'zod';
import { createZodDto } from '../../common/validation.pipe';
import { AUDIT_ACTION_VALUES, AUDIT_TARGET_TYPES } from '../audit-actions';

/**
 * The filters of Doc 06 §12 and Doc 10 §1.4, each of them optional and all of
 * them composable.
 *
 * Spelled out rather than shared with the export schema below, for the reason
 * `users/dto/users.dto.ts` gives about `usersByRoleQuerySchema`: a shared query
 * DTO is the coupling that makes one endpoint's pagination change break
 * another's. Here it would also publish one schema under two operations, which
 * is a claim about the export that is not true — it takes no page.
 */
const filters = {
  actor_id: z.uuid().optional(),
  actor_type: z.enum(AUDIT_ACTOR_TYPE_VALUES).optional(),
  action: z.enum(AUDIT_ACTION_VALUES).optional(),
  target_type: z.enum(AUDIT_TARGET_TYPES).optional(),
  target_id: z.uuid().optional(),
  client_id: z.uuid().optional(),
  /** Inclusive lower bound on `created_at`. */
  from: z.iso.datetime({ offset: true }).optional(),
  /** Exclusive upper bound on `created_at`. */
  to: z.iso.datetime({ offset: true }).optional(),
};

/** `?page=&limit=&actor_id=&actor_type=&action=&target_*=&client_id=&from=&to=`. */
export const auditQuerySchema = z.object({
  page: z.coerce.number().int().optional(),
  limit: z.coerce.number().int().optional(),
  ...filters,
});

export class AuditQueryDto extends createZodDto(auditQuerySchema) {}

/**
 * The same filters, without the page.
 *
 * An export is of the whole filter or it is refused (`audit-export.service.ts`),
 * so `page` and `limit` would be parameters that quietly did nothing — and a
 * `?limit=25` silently ignored on a compliance export is exactly the kind of
 * "it looked like it worked" this endpoint must not have.
 */
export const auditExportQuerySchema = z.object(filters);

export class AuditExportQueryDto extends createZodDto(auditExportQuerySchema) {}
