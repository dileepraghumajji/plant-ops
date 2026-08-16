/**
 * Request bodies and query parameters for `/iam/role-bindings` (Doc 06 §9).
 *
 * Same conventions as `roles/dto/*`, `scopes/dto/*` and `users/dto/*`: the field
 * names are the spec's, and every schema is a `z.object`, which **strips**
 * unknown keys.
 *
 * The stripping is doing more work here than on any other client-tier surface.
 * A `role_binding` row is the only thing in this system that grants anything, so
 * a tolerated key in the create body is not an untidy payload — a `client_id`
 * would place a grant in another tenant, and there is no second constraint
 * behind that one except RLS's `with check`, which would answer with a 500-shaped
 * policy violation rather than a refusal that names the problem. Neither field
 * exists below, and `bindings.dto.spec.ts` asserts that they are dropped rather
 * than merely ignored.
 *
 * ## What this file decides, and what it deliberately leaves to the service
 *
 * Everything answerable from the body alone is here: that exactly one subject is
 * named, that the four ids are uuids, and that an expiry is a future instant.
 * Every one of those is a `400`, because no row could make the request valid.
 *
 * Everything answerable only from rows is `BindingsService`'s: whether the role,
 * the node and the subject are the caller's own (Doc 02 §6), and whether the
 * grant already exists. Those are `409`s. The split is the same one
 * `createScopeNodeSchema` makes about `parent_id`, and it is what keeps the two
 * failure classes distinguishable to a caller.
 */

import { z } from 'zod';
import { createZodDto } from '../../common/validation.pipe';

/**
 * An ISO-8601 instant carrying an offset (Doc 06 §1's JSON everywhere).
 *
 * `offset: true` accepts both `Z` and `+05:30` and refuses a bare local time.
 * That matters for a column of type `timestamptz`: a naive string would be read
 * against the *server's* zone, so a grant an operator in Hyderabad meant to
 * expire at midnight would expire at some other moment nobody chose.
 */
const instant = z.iso.datetime({ offset: true });

/**
 * `POST /iam/role-bindings` (Doc 06 §9, Doc 09 §3.4).
 *
 * The subject XOR is a `superRefine` over one object rather than a
 * `z.discriminatedUnion`, for the mechanical reason `bulkUserUploadSchema`
 * gives: `createZodDto` produces a *class*, and TypeScript cannot extend a
 * constructor whose return type is a union. One object with two optional fields
 * and an explicit cross-field rule expresses the same contract, produces better
 * messages, and publishes a single named request schema rather than an `anyOf`
 * that a generated client turns into two types nobody asked for.
 *
 * Both halves of the XOR are reported at the path of the field the caller can
 * act on, so a body naming neither subject complains about `user_id` — the
 * ordinary case — while one naming both complains about the pair.
 */
export const createRoleBindingSchema = z
  .object({
    user_id: z.uuid().optional(),
    service_account_id: z.uuid().optional(),
    role_id: z.uuid(),
    scope_node_id: z.uuid(),
    expires_at: instant.optional(),
  })
  .superRefine((body, ctx) => {
    const named = [body.user_id, body.service_account_id].filter(
      (id) => id !== undefined,
    ).length;

    if (named === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['user_id'],
        message:
          'exactly one of user_id or service_account_id is required — a binding ' +
          'grants access to one subject',
      });
    }
    if (named === 2) {
      ctx.addIssue({
        code: 'custom',
        path: ['service_account_id'],
        message:
          'user_id and service_account_id are mutually exclusive — bind the ' +
          'person or the machine identity, not both in one grant',
      });
    }

    // A grant that lapsed before it was written grants nothing from the instant
    // it exists. Refused here rather than in the service because it needs no
    // rows: the body alone says the request cannot have been meant.
    if (body.expires_at !== undefined && Date.parse(body.expires_at) <= Date.now()) {
      ctx.addIssue({
        code: 'custom',
        path: ['expires_at'],
        message: 'expires_at must be in the future; a grant cannot be created expired',
      });
    }
  });

export class CreateRoleBindingDto extends createZodDto(createRoleBindingSchema) {}

/**
 * `?page=&limit=&user_id=&service_account_id=&role_id=&scope_node_id=`
 * (Doc 06 §1, §9).
 *
 * Doc 06 §9's "filter by user, role, scope". There is no `expired` filter and no
 * `include_expired`: a lapsed binding is listed and flagged, never hidden
 * (Doc 01 §4.5), and a flag that could hide it would make the one screen an
 * operator audits access on disagree with the table underneath it.
 *
 * Spelled out rather than derived from another surface's query schema, for the
 * reason `usersQuerySchema` gives: a shared query DTO is the coupling that makes
 * one endpoint's pagination change break another's.
 */
export const roleBindingsQuerySchema = z.object({
  page: z.coerce.number().int().optional(),
  limit: z.coerce.number().int().optional(),
  user_id: z.uuid().optional(),
  service_account_id: z.uuid().optional(),
  role_id: z.uuid().optional(),
  scope_node_id: z.uuid().optional(),
});

export class RoleBindingsQueryDto extends createZodDto(roleBindingsQuerySchema) {}
