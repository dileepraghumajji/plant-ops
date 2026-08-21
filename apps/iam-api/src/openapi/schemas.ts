/**
 * Response schemas, in zod, for the generated OpenAPI document.
 *
 * ## Why these exist at all, given `@plantops/contracts`
 *
 * Request bodies need no schema here: every one of them is already a
 * `createZodDto` class, and `openapi.ts` reads the live `zodSchema` off it. A
 * request body in the document therefore *cannot* drift from the validator,
 * because it is the validator.
 *
 * Responses have no such runtime artefact. `ApplicationDTO` and friends are
 * TypeScript interfaces — erased before anything can read them — so a generator
 * has nothing to convert. The usual answers are both bad: hand-write the
 * response schemas into the document (stale by the second published change), or
 * decorate the DTOs with a second validation vocabulary, which is exactly what
 * `validation.pipe.ts` refused `class-validator` for.
 *
 * So the schemas are written once, here, and **pinned to the published
 * interfaces by exact type equality** in `schemas.spec.ts`:
 *
 * ```ts
 * type _Application = Expect<Equal<z.infer<typeof applicationSchema>, ApplicationDTO>>;
 * ```
 *
 * `Equal` is invariant — it distinguishes a missing field, an extra field, a
 * widened union, and an optionality change. A change to `ApplicationDTO` that is
 * not mirrored here fails `nx typecheck`, which is a build failure and not a
 * test that somebody remembers to write. That is the whole mechanism, and it is
 * why nothing below carries a comment restating what the contract already says:
 * the contract is the documentation, and this file is a machine-checked copy of
 * its shape.
 *
 * ## The three recursive schemas
 *
 * `navNodeCatalogSchema`, `navNodeSchema` and `scopeNodeSchema` describe trees,
 * so they need `z.lazy` and an explicit `z.ZodType<…>` annotation — `z.lazy`
 * cannot infer a type that refers to itself. That annotation makes their `Equal`
 * assertion weaker than the rest (it asserts what the annotation already
 * declared), so for those three the real check is the annotation itself: it fails
 * to compile if the object literal cannot produce the interface.
 */

import {
  AUDIT_ACTOR_TYPE_VALUES,
  BULK_USER_ROW_STATUS_VALUES,
  CLIENT_STATUS_VALUES,
  NAV_NODE_KIND_VALUES,
  SCOPE_NODE_KIND_VALUES,
  SERVICE_ACCOUNT_STATUS_VALUES,
  USER_STATUS_VALUES,
  type NavNodeCatalogDTO,
  type NavNodeDTO,
  type ScopeNodeDTO,
} from '@plantops/contracts';
import { type ZodType, z } from 'zod';

/**
 * Every schema the document names.
 *
 * A registry rather than a bag of exports because `z.toJSONSchema(registry)`
 * emits one `components.schemas` entry per member and `$ref`s between them —
 * so `Paginated<RoleDTO>` points at `RoleDTO` instead of inlining a second
 * copy of it, and the two cannot disagree.
 */
export const openApiSchemas = z.registry<{ id: string }>();

/**
 * Request schemas, kept in a second registry for one reason: **`io`**.
 *
 * A request body is converted as an *input* — defaulted fields are optional,
 * because the caller may omit them, and unknown keys are not forbidden, because
 * the pipe strips them rather than rejecting them. A response is converted as
 * an *output* — the same defaulted field is always present, and the object is
 * closed. Converting both under one setting would publish a lie about one of
 * them, and `z.toJSONSchema` takes `io` per call, not per schema.
 */
export const openApiRequestSchemas = z.registry<{ id: string }>();

/** Where a registered schema lives in the document. */
export const SCHEMA_REF_PREFIX = '#/components/schemas/';

/** Registers a response schema under the name the document will publish it as. */
function named<T extends ZodType>(id: string, schema: T): T {
  openApiSchemas.add(schema, { id });
  return schema;
}

/**
 * Adds a request DTO's live schema under its class's name.
 *
 * Requests are registered rather than declared, because there is nothing to
 * declare: the schema already exists on the `createZodDto` class, and copying
 * it would reintroduce exactly the drift the response mirrors above exist to
 * prevent.
 */
export function registerRequestSchema(id: string, schema: ZodType): void {
  openApiRequestSchemas.add(schema, { id });
}

/**
 * `$ref` to a registered schema.
 *
 * Throws rather than inlining an unregistered one: a schema the document
 * mentions but does not name is a schema no generated client gets a type for,
 * and quietly inlining it would hide that.
 */
export function refFor(schema: ZodType): string {
  const id =
    openApiSchemas.get(schema)?.id ?? openApiRequestSchemas.get(schema)?.id;
  if (id === undefined) {
    throw new Error(
      'An OpenAPI schema was referenced before it was registered. Declare it ' +
        'with `named(...)` in openapi/schemas.ts, or register it with ' +
        '`registerRequestSchema` if it belongs to a DTO class.',
    );
  }
  return `${SCHEMA_REF_PREFIX}${id}`;
}

/**
 * Both registries → `components.schemas`.
 *
 * `$schema` and `$id` are dropped: both are artefacts of converting a schema in
 * isolation, and OpenAPI supplies the dialect for the document as a whole.
 */
export function componentSchemas(): Record<string, unknown> {
  return {
    ...convert(openApiSchemas, 'output'),
    ...convert(openApiRequestSchemas, 'input'),
  };
}

function convert(
  registry: typeof openApiSchemas,
  io: 'input' | 'output',
): Record<string, unknown> {
  const { schemas } = z.toJSONSchema(registry, {
    target: 'draft-2020-12',
    io,
    uri: (id) => `${SCHEMA_REF_PREFIX}${id}`,
  });

  return Object.fromEntries(
    Object.entries(schemas).map(([id, schema]) => {
      const rest = { ...schema };
      delete rest.$schema;
      delete rest.$id;
      return [id, rest];
    }),
  );
}

/** An ISO-8601 timestamp. Every DTO's `created_at` / `updated_at`. */
const timestamp = z.iso.datetime({ offset: true });

/** The free-form `config` / `metadata` columns (Doc 01 §3.1, §3.4). */
const jsonObject = z.record(z.string(), z.unknown());

/**
 * The `{ data, page, limit, total }` envelope of Doc 06 §1.
 *
 * A function rather than four hand-written wrappers, so the envelope is
 * described once and every list endpoint is provably the same shape.
 */
function paginated<T extends ZodType>(id: string, item: T) {
  return named(
    id,
    z.object({
      data: z.array(item),
      page: z.number().int(),
      limit: z.number().int(),
      total: z.number().int(),
    }),
  );
}

// ── errors (Doc 06 §2) ──────────────────────────────────────────────────────

export const errorDetailSchema = named(
  'IamErrorDetail',
  z.object({ field: z.string(), message: z.string() }),
);

/**
 * The single response shape every failure takes.
 *
 * `code` is spelled as the closed enum rather than as a string: it is the value
 * consumers branch on, and a generated client that types it as `string` gives
 * an integrating team no help at all with the one field that matters.
 */
export const errorResponseSchema = named(
  'IamErrorResponse',
  z.object({
    error: z.object({
      code: z.enum([
        'VALIDATION_FAILED',
        'AUTH_REQUIRED',
        'INVALID_CREDENTIALS',
        'PERMISSION_DENIED',
        'SCOPE_DENIED',
        'NOT_FOUND',
        'CONFLICT',
        'ACCOUNT_LOCKED',
        'RATE_LIMITED',
        'INTERNAL_ERROR',
      ]),
      message: z.string(),
      requestId: z.string(),
      details: z.array(errorDetailSchema).optional(),
    }),
  }),
);

// ── auth (Doc 06 §3) ────────────────────────────────────────────────────────

export const tokenPairSchema = named(
  'TokenPairResponse',
  z.object({
    access_token: z.string(),
    refresh_token: z.string(),
    expires_in: z.number().int(),
  }),
);

export const accessTokenSchema = named(
  'AccessTokenResponse',
  z.object({ access_token: z.string(), expires_in: z.number().int() }),
);

export const sessionSchema = named(
  'SessionDTO',
  z.object({
    id: z.uuid(),
    device_label: z.string().nullable(),
    issued_at: timestamp,
    expires_at: timestamp,
    revoked_at: timestamp.nullable(),
    current: z.boolean(),
  }),
);

export const jwkSchema = named(
  'JwkDTO',
  z.object({
    kty: z.string(),
    use: z.string().optional(),
    alg: z.string().optional(),
    kid: z.string(),
    n: z.string().optional(),
    e: z.string().optional(),
    crv: z.string().optional(),
    x: z.string().optional(),
    y: z.string().optional(),
  }),
);

export const jwksSchema = named(
  'JwksResponse',
  z.object({ keys: z.array(jwkSchema) }),
);

// ── registry (Doc 06 §4) ────────────────────────────────────────────────────

export const applicationSchema = named(
  'ApplicationDTO',
  z.object({
    id: z.uuid(),
    key: z.string(),
    name: z.string(),
    description: z.string().nullable(),
    is_active: z.boolean(),
    config: jsonObject,
    created_at: timestamp,
    updated_at: timestamp,
  }),
);

export const permissionSchema = named(
  'PermissionDTO',
  z.object({
    id: z.uuid(),
    application_id: z.uuid(),
    key: z.string(),
    name: z.string(),
    description: z.string().nullable(),
    is_active: z.boolean(),
    created_at: timestamp,
    updated_at: timestamp,
  }),
);

export const navNodeCatalogSchema: ZodType<NavNodeCatalogDTO> = named(
  'NavNodeCatalogDTO',
  z.lazy(() =>
    z.object({
      id: z.uuid(),
      application_id: z.uuid(),
      parent_id: z.uuid().nullable(),
      kind: z.enum(NAV_NODE_KIND_VALUES),
      key: z.string(),
      label: z.string(),
      route: z.string().nullable(),
      icon: z.string().nullable(),
      sort_order: z.number().int(),
      is_active: z.boolean(),
      is_public: z.boolean(),
      requires: z.array(z.string()),
      created_at: timestamp,
      updated_at: timestamp,
      children: z.array(navNodeCatalogSchema),
    }),
  ),
);

export const navCatalogSchema = named(
  'NavCatalogResponse',
  z.object({
    application_id: z.uuid(),
    tree: z.array(navNodeCatalogSchema),
  }),
);

export const navPermissionsResultSchema = named(
  'NavPermissionsResult',
  z.object({ changed: z.number().int(), unchanged: z.number().int() }),
);

const manifestEntityDiffSchema = named(
  'ManifestEntityDiff',
  z.object({
    created: z.array(z.string()),
    updated: z.array(z.string()),
    deactivated: z.array(z.string()),
  }),
);

const manifestMappingChangeSchema = named(
  'ManifestMappingChange',
  z.object({ nav_key: z.string(), permission_keys: z.array(z.string()) }),
);

const manifestMappingDiffSchema = named(
  'ManifestMappingDiff',
  z.object({
    mapped: z.array(manifestMappingChangeSchema),
    unmapped: z.array(manifestMappingChangeSchema),
  }),
);

const manifestApplicationDiffSchema = named(
  'ManifestApplicationDiff',
  z.object({ key: z.string(), changed: z.array(z.string()) }),
);

const manifestDiffSchema = named(
  'ManifestDiff',
  z.object({
    application: manifestApplicationDiffSchema,
    permissions: manifestEntityDiffSchema,
    nav: manifestEntityDiffSchema,
    menu_permissions: manifestMappingDiffSchema,
  }),
);

export const manifestUpsertSchema = named(
  'ManifestUpsertResponse',
  z.object({
    application_id: z.uuid(),
    dry_run: z.boolean(),
    changed: z.boolean(),
    diff: manifestDiffSchema,
  }),
);

// ── clients (Doc 06 §5) ─────────────────────────────────────────────────────

export const clientSchema = named(
  'ClientDTO',
  z.object({
    id: z.uuid(),
    name: z.string(),
    slug: z.string(),
    status: z.enum(CLIENT_STATUS_VALUES),
    config: jsonObject,
    enabled_application_count: z.number().int(),
    created_at: timestamp,
    updated_at: timestamp,
  }),
);

export const clientApplicationSchema = named(
  'ClientApplicationDTO',
  z.object({
    client_id: z.uuid(),
    application_id: z.uuid(),
    application_key: z.string(),
    application_name: z.string(),
    enabled: z.boolean(),
    config: jsonObject,
    created_at: timestamp,
    updated_at: timestamp,
  }),
);

export const clientAdminSchema = named(
  'ClientAdminDTO',
  z.object({
    client_id: z.uuid(),
    user_id: z.uuid(),
    email: z.string(),
    full_name: z.string(),
    role_id: z.uuid(),
    role_name: z.string(),
    scope_node_id: z.uuid(),
    scope_node_name: z.string(),
    scope_node_path: z.string(),
    role_binding_id: z.uuid(),
    created_at: timestamp,
  }),
);

// ── scopes (Doc 06 §6) ──────────────────────────────────────────────────────

export const scopeNodeSchema: ZodType<ScopeNodeDTO> = named(
  'ScopeNodeDTO',
  z.lazy(() =>
    z.object({
      id: z.uuid(),
      client_id: z.uuid(),
      parent_id: z.uuid().nullable(),
      kind: z.enum(SCOPE_NODE_KIND_VALUES),
      name: z.string(),
      path: z.string(),
      depth: z.number().int(),
      metadata: jsonObject,
      created_at: timestamp,
      updated_at: timestamp,
      children: z.array(scopeNodeSchema),
    }),
  ),
);

export const scopeTreeSchema = named(
  'ScopeTreeResponse',
  z.object({ client_id: z.uuid(), tree: z.array(scopeNodeSchema) }),
);

// ── roles (Doc 06 §7) ───────────────────────────────────────────────────────

export const roleSchema = named(
  'RoleDTO',
  z.object({
    id: z.uuid(),
    client_id: z.uuid(),
    name: z.string(),
    description: z.string().nullable(),
    is_system: z.boolean(),
    permission_count: z.number().int(),
    bound_subject_count: z.number().int(),
    created_at: timestamp,
    updated_at: timestamp,
  }),
);

const rolePermissionSchema = named(
  'RolePermissionDTO',
  z.object({
    id: z.uuid(),
    key: z.string(),
    name: z.string(),
    description: z.string().nullable(),
    is_active: z.boolean(),
    application_id: z.uuid(),
    application_key: z.string(),
    application_name: z.string(),
    application_enabled: z.boolean(),
  }),
);

export const rolePermissionsSchema = named(
  'RolePermissionsResponse',
  z.object({ role_id: z.uuid(), permissions: z.array(rolePermissionSchema) }),
);

export const permissionCatalogSchema = named(
  'PermissionCatalogResponse',
  z.object({ client_id: z.uuid(), permissions: z.array(rolePermissionSchema) }),
);

// ── users (Doc 06 §8) ───────────────────────────────────────────────────────

export const userSchema = named(
  'UserDTO',
  z.object({
    id: z.uuid(),
    client_id: z.uuid(),
    email: z.string(),
    full_name: z.string(),
    phone: z.string().nullable(),
    status: z.enum(USER_STATUS_VALUES),
    is_client_admin: z.boolean(),
    created_at: timestamp,
    updated_at: timestamp,
  }),
);

const userBindingSchema = named(
  'UserBindingDTO',
  z.object({
    id: z.uuid(),
    role_id: z.uuid(),
    role_name: z.string(),
    scope_node_id: z.uuid(),
    scope_node_name: z.string(),
    scope_node_path: z.string(),
    expires_at: timestamp.nullable(),
    expired: z.boolean(),
    created_at: timestamp,
  }),
);

export const userDetailSchema = named(
  'UserDetailDTO',
  userSchema.extend({ bindings: z.array(userBindingSchema) }),
);

const bulkUserRowResultSchema = named(
  'BulkUserRowResult',
  z.object({
    row: z.number().int(),
    email: z.string().nullable(),
    status: z.enum(BULK_USER_ROW_STATUS_VALUES),
    reason: z.string().optional(),
    user_id: z.uuid().nullable(),
  }),
);

export const bulkUserUploadSchema = named(
  'BulkUserUploadResponse',
  z.object({
    total: z.number().int(),
    created: z.number().int(),
    skipped: z.number().int(),
    errored: z.number().int(),
    results: z.array(bulkUserRowResultSchema),
  }),
);

const roleScopeGrantSchema = named(
  'RoleScopeGrantDTO',
  z.object({
    binding_id: z.uuid(),
    scope_node_id: z.uuid(),
    scope_node_name: z.string(),
    scope_node_path: z.string(),
    expires_at: timestamp.nullable(),
    expired: z.boolean(),
  }),
);

export const userByRoleSchema = named(
  'UserByRoleDTO',
  userSchema.extend({ scopes: z.array(roleScopeGrantSchema) }),
);

// ── role bindings (Doc 06 §9) ───────────────────────────────────────────────

export const roleBindingSchema = named(
  'RoleBindingDTO',
  z.object({
    id: z.uuid(),
    client_id: z.uuid(),
    // Spelled out rather than imported, like `whoAmISchema`'s `subjectType`
    // below: `SubjectType` has no `*_VALUES` companion in the contracts, and the
    // `Equal` pin in `schemas.spec.ts` is what stops this drifting from it.
    subject_type: z.enum(['user', 'service']),
    subject_id: z.uuid(),
    subject_name: z.string(),
    subject_email: z.string().nullable(),
    role_id: z.uuid(),
    role_name: z.string(),
    scope_node_id: z.uuid(),
    scope_node_name: z.string(),
    scope_node_path: z.string(),
    expires_at: timestamp.nullable(),
    expired: z.boolean(),
    created_at: timestamp,
  }),
);

// ── service accounts (Doc 06 §10) ───────────────────────────────────────────

export const serviceAccountSchema = named(
  'ServiceAccountDTO',
  z.object({
    id: z.uuid(),
    client_id: z.uuid().nullable(),
    name: z.string(),
    account_key: z.string(),
    status: z.enum(SERVICE_ACCOUNT_STATUS_VALUES),
    created_at: timestamp,
    updated_at: timestamp,
  }),
);

/**
 * The **only** response that carries a credential, and only ever at creation
 * and rotation — Doc 06 §10's "shown once". Kept a distinct schema from
 * {@link serviceAccountSchema} for that reason: an integrating team reading the
 * document should see exactly two operations that return a secret.
 */
export const serviceAccountSecretSchema = named(
  'ServiceAccountSecretDTO',
  serviceAccountSchema.extend({ account_secret: z.string() }),
);

// ── resolution (Doc 06 §11) ─────────────────────────────────────────────────

/**
 * The resolved grant set.
 *
 * `scopes` is an open record because its keys *are* the data: permission keys
 * are created at runtime through the registry and the IAM must never enumerate
 * them in code (Doc 02 §8, and `PermissionKey`'s own comment). A generated
 * client therefore gets `Record<string, string[]>`, which is the honest shape.
 */
export const resolvedGrantsSchema = named(
  'ResolvedGrants',
  z.object({
    permissions: z.array(z.string()),
    scopes: z.record(z.string(), z.array(z.string())),
  }),
);

export const permissionCheckSchema = named(
  'PermissionCheckResponse',
  z.object({ allowed: z.boolean() }),
);

/**
 * Introspection's two-branch answer.
 *
 * A discriminated union rather than one object with optional fields, mirroring
 * {@link IntrospectResponse}: an inactive token carries **no** identity, and a
 * shape in which `sub` were merely absent would let a consumer read it without
 * checking `active` first. The document publishes it as a `oneOf` with a
 * discriminator, so a generated client gets the same narrowing.
 */
export const introspectSchema = named(
  'IntrospectResponse',
  z.discriminatedUnion('active', [
    z.object({ active: z.literal(false) }),
    z.object({
      active: z.literal(true),
      sub: z.uuid(),
      // Spelled out for the reason `roleBindingSchema.subject_type` gives.
      sty: z.enum(['user', 'service']),
      cid: z.uuid(),
      sid: z.uuid(),
    }),
  ]),
);

// ── navigation (Doc 05 §4, Doc 06 §11) ──────────────────────────────────────

/**
 * A node of the *pruned* tree — the third recursive schema here, and the only
 * one whose recursion carries no gates.
 *
 * `route` and `icon` are `.nullable().optional()` because {@link NavNodeDTO}
 * declares them `route?: string | null`: a pure container has no route, and the
 * contract lets a producer either omit the field or send `null`. `NavigationService`
 * always sends `null`, and the schema still publishes both because a consumer
 * reading the document must handle what the type permits, not what today's
 * implementation happens to emit.
 *
 * Nothing here reports `requires`, `is_public` or `is_active`. That is deliberate
 * and is stated in `navigation/prune.ts`: this is the answer to "what may I see",
 * and shipping the gates would let a client enumerate the permissions it does not
 * hold from the items it cannot see.
 */
export const navNodeSchema: ZodType<NavNodeDTO> = named(
  'NavNodeDTO',
  z.lazy(() =>
    z.object({
      id: z.uuid(),
      kind: z.enum(NAV_NODE_KIND_VALUES),
      key: z.string(),
      label: z.string(),
      route: z.string().nullable().optional(),
      icon: z.string().nullable().optional(),
      children: z.array(navNodeSchema),
    }),
  ),
);

export const applicationSummarySchema = named(
  'ApplicationSummaryDTO',
  z.object({ id: z.uuid(), key: z.string(), name: z.string() }),
);

/**
 * `application` is nullable because `null` is a real answer twice over: it is the
 * cross-application shell, whose top level *is* the applications (Doc 05 §4), and
 * it is an `?applicationId=` the caller may not see — collapsed into an empty
 * answer rather than a 404 (`navigation.service.ts`).
 */
export const navigationSchema = named(
  'NavigationResponse',
  z.object({
    application: applicationSummarySchema.nullable(),
    tree: z.array(navNodeSchema),
  }),
);

// ── audit (Doc 06 §12, Doc 10 §2) ───────────────────────────────────────────

/**
 * `action` and `target_type` are open strings rather than enums, and the reason
 * is in `contracts/audit.ts`: rows outlive the catalog that wrote them, so a
 * union here would be a claim the append-only table cannot keep. The `?action=`
 * *filter* is an enum, and appears in the document as one — that asymmetry is
 * the intended one (`audit/dto/audit.dto.ts`).
 */
export const auditRecordSchema = named(
  'AuditRecordDTO',
  z.object({
    id: z.uuid(),
    client_id: z.uuid().nullable(),
    actor_type: z.enum(AUDIT_ACTOR_TYPE_VALUES),
    actor_id: z.uuid().nullable(),
    action: z.string(),
    target_type: z.string().nullable(),
    target_id: z.uuid().nullable(),
    payload: jsonObject,
    created_at: timestamp,
  }),
);

// ── identity & ops (Doc 06 §11, §13) ────────────────────────────────────────

export const whoAmISchema = named(
  'WhoAmIResponse',
  z.object({
    subjectId: z.uuid(),
    subjectType: z.enum(['user', 'service']),
    sessionId: z.uuid(),
    clientId: z.uuid().nullable(),
    userId: z.uuid().nullable(),
    isPlatformAdmin: z.boolean(),
  }),
);

export const livenessSchema = named(
  'LivenessReport',
  z.object({
    status: z.literal('ok'),
    version: z.string(),
    uptimeSeconds: z.number().int(),
  }),
);

export const readinessSchema = named(
  'ReadinessReport',
  z.object({
    status: z.enum(['ready', 'not_ready']),
    checks: z.object({
      postgres: z.enum(['up', 'down']),
      redis: z.enum(['up', 'down']),
    }),
  }),
);

// ── paginated envelopes ─────────────────────────────────────────────────────

export const paginatedApplicationsSchema = paginated(
  'PaginatedApplicationDTO',
  applicationSchema,
);
export const paginatedPermissionsSchema = paginated(
  'PaginatedPermissionDTO',
  permissionSchema,
);
export const paginatedClientsSchema = paginated('PaginatedClientDTO', clientSchema);
export const paginatedRolesSchema = paginated('PaginatedRoleDTO', roleSchema);
export const paginatedUsersSchema = paginated('PaginatedUserDTO', userSchema);
export const paginatedUsersByRoleSchema = paginated(
  'PaginatedUserByRoleDTO',
  userByRoleSchema,
);
export const paginatedRoleBindingsSchema = paginated(
  'PaginatedRoleBindingDTO',
  roleBindingSchema,
);
export const paginatedServiceAccountsSchema = paginated(
  'PaginatedServiceAccountDTO',
  serviceAccountSchema,
);
export const paginatedAuditSchema = paginated('PaginatedAuditRecordDTO', auditRecordSchema);
