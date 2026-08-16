/**
 * Request bodies and query parameters for the resolution endpoints (Doc 06 §11).
 *
 * Same conventions as every other surface: the field names are the spec's, and
 * every schema is a `z.object`, which **strips** unknown keys.
 *
 * What is *not* here is the point: none of these bodies names a subject. Doc 06
 * §1 makes the tenant and the subject come from the JWT and from nowhere else,
 * and on this surface the temptation to break that is at its strongest — a
 * `subjectId` field would turn `/permissions/resolve` into "read anybody's
 * grants" with no permission behind it, and it would look like a feature. The
 * bearer is the subject, full stop; resolving *another* subject's grants is an
 * administrative question that Doc 06 §9's binding list already answers.
 */

import { z } from 'zod';
import { createZodDto } from '../../common/validation.pipe';

/**
 * `GET /iam/permissions/resolve?applicationId=` (Doc 06 §11).
 *
 * Camel-cased, unlike the snake_case query parameters of the admin surfaces,
 * because Doc 06 §11 spells it `?applicationId=` — the resolution endpoints are
 * the contract consumed by other teams' modules, so their spelling is the
 * spec's rather than this codebase's house style.
 *
 * No pagination. The grant set is "a single cacheable unit" (Doc 06 §11), and a
 * page of it would be neither cacheable nor usable: a consumer cannot answer
 * "may I" from half an answer.
 */
export const resolveQuerySchema = z.object({
  applicationId: z.uuid().optional(),
});

export class ResolveQueryDto extends createZodDto(resolveQuerySchema) {}

/**
 * `POST /iam/permissions/check` (Doc 06 §11).
 *
 * A `POST` for a question that reads nothing, because both operands belong in a
 * body: a permission key is a dotted string that would have to be percent-encoded
 * into a query, and — the reason that decides it — a `GET` would put the
 * permission being tested into every access log and proxy cache between the
 * consumer and here.
 *
 * The permission is a bounded string rather than the `permissionKey` regex the
 * registry validates with. This endpoint *tests* a key rather than creating one,
 * and a key that no application ever registered is a legitimate question with
 * the answer `false` — rejecting it as malformed would tell a caller that their
 * key is not merely unheld but unknown, which the registry's own catalog does
 * not hide but this deny-by-default surface has no business volunteering. The
 * bound is there so the check cannot be used to push megabytes through the
 * resolver.
 */
export const permissionCheckSchema = z.object({
  permission: z.string().trim().min(1, 'permission is required').max(160),
  scopeNodeId: z.uuid(),
});

export class PermissionCheckDto extends createZodDto(permissionCheckSchema) {}

/**
 * `POST /iam/introspect` (Doc 06 §11).
 *
 * The bound is generous — a compact JWS with seven claims is a few hundred bytes
 * and the ceiling is the ordinary 64 kB body limit anyway (Doc 06 §1) — and it
 * exists so that an unbounded string never reaches the verifier's base64
 * decoding. There is no format check beyond that: deciding whether the thing is
 * a token is exactly what the endpoint does, and a malformed one is
 * `{ active: false }`, never a 400. A caller that could tell "not a token" from
 * "not a valid token" would learn something about the tokens this issuer signs.
 */
export const introspectSchema = z.object({
  token: z.string().trim().min(1, 'token is required').max(8192),
});

export class IntrospectDto extends createZodDto(introspectSchema) {}
