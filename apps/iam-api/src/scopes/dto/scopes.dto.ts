/**
 * Request bodies for `/iam/scopes` (Doc 06 §6).
 *
 * Same conventions as `clients/dto/*`: the field names are the spec's, and every
 * schema is a `z.object`, which **strips** unknown keys. These bodies reach
 * inserts on a tenant table, so a tolerated `client_id` or `path` in a create
 * body would be a mass-assignment hole with a tenant boundary — and, in `path`'s
 * case, with the coverage rules of the entire authorization model — on the other
 * side of it.
 *
 * Note what is *not* accepted anywhere below: `path`. It is derived from the
 * node's own id and its parent's path (Doc 01 §3.5) and never supplied. A caller
 * who could write it could hang their own node under another tenant's subtree,
 * which is the one input that would turn RLS's per-row tenant check into a
 * per-row tenant check over a lie.
 */

import { SCOPE_NODE_KIND_VALUES } from '@plantops/contracts';
import { z } from 'zod';
import { createZodDto } from '../../common/validation.pipe';

/**
 * The display name (Doc 01 §3.5).
 *
 * Trimmed and length-bounded, and otherwise unconstrained — `"Plant B"`,
 * `"Gate-3"`, a name in Telugu or one containing a dot are all fine, because a
 * name never reaches `path`. The 160-character bound matches `clientName`; the
 * non-blank rule restates migration 0003's `scope_node_name_not_blank`, so a
 * blank name is a 400 that says so rather than a 500 from a check violation.
 */
export const scopeNodeName = z.string().trim().min(1, 'name is required').max(160);

/** Free-form per-node data (Doc 01 §3.5), opaque to the IAM. */
const metadata = z.record(z.string(), z.unknown());

/**
 * `POST /iam/scopes` (Doc 06 §6).
 *
 * `parent_id` is optional in the schema and all but required in practice — the
 * service accepts its absence only when the tenant has no root yet. Expressed
 * that way round because "does this client already have a root?" is a question
 * about rows, which a schema cannot ask.
 */
export const createScopeNodeSchema = z.object({
  parent_id: z.uuid().optional(),
  kind: z.enum(SCOPE_NODE_KIND_VALUES),
  name: scopeNodeName,
  metadata: metadata.optional(),
});

export class CreateScopeNodeDto extends createZodDto(createScopeNodeSchema) {}

/**
 * `PATCH /iam/scopes/:id` — rename and/or move (Doc 06 §6).
 *
 * At least one field, so an empty body is a 400 rather than a 200 that audits a
 * change nobody made — the rule `updateClientSchema` follows.
 *
 * `kind` and `metadata` are absent — Doc 06 §6 defines this as "rename / move",
 * and Doc 10 §4 gives the scope tree no action to record any other edit under.
 * See {@link UpdateScopeNodeRequest}.
 *
 * `parent_id` is `z.uuid()`, so `null` does not parse: a node cannot be detached
 * into a second root.
 */
export const updateScopeNodeSchema = z
  .object({
    name: scopeNodeName.optional(),
    parent_id: z.uuid().optional(),
  })
  .refine((body) => Object.keys(body).length > 0, {
    message: 'at least one field must be provided',
  });

export class UpdateScopeNodeDto extends createZodDto(updateScopeNodeSchema) {}
