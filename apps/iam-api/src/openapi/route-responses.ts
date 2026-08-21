/**
 * What each handler returns, for the generated document.
 *
 * ## Why a map rather than a decorator on every handler
 *
 * The obvious shape is `@ApiOkResponse(...)` above each route, and it is the
 * shape `@nestjs/swagger` expects. It is rejected here for the reason
 * `validation.pipe.ts` rejected `class-validator`: it puts a second, parallel
 * description of the API into the controllers, where it sits next to the real
 * one and drifts from it silently. A controller should say what it *does*; the
 * document is a projection of that, not a second copy maintained by hand.
 *
 * The objection to a central map is drift of the other kind — a route added
 * with no entry here. That is closed by the type, not by discipline:
 * {@link ControllerResponses} is an exhaustive `Record` over the controller's
 * own method names, so a new handler fails `nx typecheck` until it is described.
 * `openapi.spec.ts` closes the remaining half, that every controller the
 * application registers appears below at all.
 *
 * ## Statuses are declared, not inferred
 *
 * The status could be read from `@HttpCode`, and the generator does read it —
 * but it is repeated here so the two must agree (`openapi.spec.ts` asserts it).
 * A `@HttpCode(204)` added to a handler that still returns a body is exactly the
 * kind of change that produces a document nobody notices is wrong.
 */

import type { Type } from '@nestjs/common';
import type { ZodType } from 'zod';
import { AuditController } from '../audit/audit.controller';
import { AuthController } from '../auth/auth.controller';
import { JwksController } from '../auth/jwks.controller';
import { AuthzController } from '../authz/authz.controller';
import { BindingsController } from '../bindings/bindings.controller';
import { ClientsController } from '../clients/clients.controller';
import { DeploymentController } from '../config/deployment.controller';
import { HealthController } from '../health/health.controller';
import { WhoAmIController } from '../iam/whoami.controller';
import { NavigationController } from '../navigation/navigation.controller';
import { ApplicationsController } from '../registry/applications.controller';
import { RolesController } from '../roles/roles.controller';
import { ScopesController } from '../scopes/scopes.controller';
import { ServiceAccountsController } from '../service-accounts/service-accounts.controller';
import { UsersController } from '../users/users.controller';
import {
  accessTokenSchema,
  applicationSchema,
  bulkUserUploadSchema,
  clientAdminSchema,
  clientApplicationSchema,
  clientSchema,
  introspectSchema,
  jwksSchema,
  deploymentSchema,
  livenessSchema,
  manifestUpsertSchema,
  navCatalogSchema,
  navNodeCatalogSchema,
  navPermissionsResultSchema,
  navigationSchema,
  paginatedApplicationsSchema,
  paginatedAuditSchema,
  paginatedClientsSchema,
  paginatedPermissionsSchema,
  paginatedRoleBindingsSchema,
  paginatedRolesSchema,
  paginatedServiceAccountsSchema,
  paginatedUsersByRoleSchema,
  paginatedUsersSchema,
  permissionCheckSchema,
  permissionSchema,
  readinessSchema,
  resolvedGrantsSchema,
  roleBindingSchema,
  roleSchema,
  permissionCatalogSchema,
  rolePermissionsSchema,
  scopeNodeSchema,
  scopeTreeSchema,
  serviceAccountSchema,
  serviceAccountSecretSchema,
  sessionSchema,
  tokenPairSchema,
  userDetailSchema,
  userSchema,
  whoAmISchema,
} from './schemas';

/** One documented response. `schema` absent means no body. */
export interface ResponseBody {
  readonly status: number;
  readonly description: string;
  readonly schema?: ZodType;
  /** The handler returns an array of `schema`. */
  readonly array?: true;
  /**
   * The media type of the body, where it is not `application/json`.
   *
   * One route: the CSV of Doc 10 §7. Stated here rather than read off the
   * handler's `@Header('content-type', …)`, for the reason the header of this
   * file gives about statuses — the two are declared separately so that they
   * must agree, and `openapi.spec.ts` asserts they do.
   */
  readonly mediaType?: string;
}

/** One handler's success response, plus what else it is documented to do. */
export interface ResponseSpec extends ResponseBody {
  /**
   * Further **non-error** responses. Exactly one route needs this today:
   * `/ready` answers 503 with the same report it answers 200 with, which is the
   * point of a readiness probe (Doc 06 §13).
   */
  readonly also?: readonly ResponseBody[];
  /**
   * Envelope statuses beyond the universal ones (`openapi.ts`).
   *
   * Listed per route rather than blanket-applied, because a document that
   * claims every route can return every code tells an integrating team nothing
   * about which failures are worth handling.
   */
  readonly errors?: readonly number[];
  /**
   * `false` for the ops endpoints of Doc 06 §13, which are outside the error
   * envelope entirely — they answer with a report and a status code.
   */
  readonly envelope?: false;
}

/** The method names of a controller — its routes, and nothing else. */
type HandlerName<T> = {
  [K in keyof T]: T[K] extends (...args: never[]) => unknown ? K : never;
}[keyof T];

/** Exhaustive over the controller's handlers: a new route will not compile. */
export type ControllerResponses<T> = Readonly<
  Record<HandlerName<T>, ResponseSpec>
>;

const ok = (schema: ZodType, description = 'Success'): ResponseBody => ({
  status: 200,
  description,
  schema,
});
const okList = (schema: ZodType, description = 'Success'): ResponseBody => ({
  status: 200,
  description,
  schema,
  array: true,
});
const created = (schema: ZodType, description = 'Created'): ResponseBody => ({
  status: 201,
  description,
  schema,
});
const createdList = (schema: ZodType, description = 'Created'): ResponseBody => ({
  status: 201,
  description,
  schema,
  array: true,
});
const noContent = (description: string): ResponseBody => ({
  status: 204,
  description,
});

/** `<success>` plus the envelope statuses that route genuinely produces. */
const failing = (
  success: ResponseBody,
  ...errors: readonly number[]
): ResponseSpec => ({ ...success, errors });

/**
 * The two shapes the admin surfaces repeat.
 *
 * `403` because `PermissionGuard` refuses there — with `PERMISSION_DENIED` on
 * the platform and client tiers alike, and `SCOPE_DENIED` on the routes that
 * name a scope node; `404` because every by-id route can miss inside the
 * caller's tenant; `409` where a natural key can collide.
 */
const DENIED_OR_MISSING = [403, 404] as const;
const DENIED_MISSING_OR_DUPLICATE = [403, 404, 409] as const;

/** Pairs a controller with its responses, inferring the handler names from it. */
function routes<T>(
  controller: Type<T>,
  responses: ControllerResponses<T>,
): readonly [Type<unknown>, Readonly<Record<string, ResponseSpec>>] {
  return [
    controller as Type<unknown>,
    responses as Readonly<Record<string, ResponseSpec>>,
  ];
}

export const ROUTE_RESPONSES: ReadonlyMap<
  Type<unknown>,
  Readonly<Record<string, ResponseSpec>>
> = new Map([
  routes(AuthController, {
    // 401 is declared rather than inherited: these routes are `@Public()`, so
    // the generator adds no 401 of its own, and yet a rejected credential is
    // the single most important failure on the surface.
    login: failing(ok(tokenPairSchema, 'An access/refresh token pair'), 401, 423),
    refresh: failing(ok(tokenPairSchema, 'A rotated token pair'), 401),
    requestPasswordReset: {
      status: 202,
      // The 202 *is* the contract: Doc 03 §7 answers identically whether or not
      // the address matched, so there is nothing a body could carry without
      // leaking the thing the identical answer exists to hide.
      description: 'Accepted, whether or not the address matched an account',
    },
    completePasswordReset: failing(noContent('The password was changed'), 401),
    serviceToken: failing(ok(accessTokenSchema, 'A service-account token'), 401),
    logout: noContent('The current session was revoked'),
    sessionList: okList(sessionSchema, 'The subject’s sessions'),
    revokeSession: failing(noContent('The session was revoked'), 404),
  }),

  routes(JwksController, {
    // `application/jwk-set+json`, which is what the handler's own
    // `@Header` already answers with (RFC 7517 §8.5.1). Declared here since
    // Session 25, when the media-type cross-check in `openapi.spec.ts` found
    // the document claiming plain JSON for it — the body is unchanged and every
    // client that read it still does; the document simply stopped understating
    // what it is.
    jwks: {
      ...ok(jwksSchema, 'The public keys tokens are verified against'),
      mediaType: 'application/jwk-set+json',
    },
  }),

  routes(DeploymentController, {
    // Enveloped like every other `/iam` route, unlike the two probes. It is
    // read before anyone has a credential, but it is still part of the API
    // surface rather than an orchestrator's probe — so a caller that meets a
    // 429 or a 500 here should get the same `{ error: { code, … } }` it gets
    // everywhere else, and the login screen has one error shape to handle.
    describe: ok(deploymentSchema, 'What kind of deployment this is'),
  }),

  routes(HealthController, {
    // Outside the envelope: Doc 06 §13. A probe reads status codes.
    live: { ...ok(livenessSchema, 'The process is alive'), envelope: false },
    ready: {
      ...ok(readinessSchema, 'Every dependency answered'),
      also: [
        {
          status: 503,
          description: 'At least one dependency did not; the report names it',
          schema: readinessSchema,
        },
      ],
      envelope: false,
    },
  }),

  routes(WhoAmIController, {
    whoami: ok(whoAmISchema, 'The caller, as the database sees them'),
  }),

  routes(ApplicationsController, {
    create: failing(created(applicationSchema), 403, 409),
    list: failing(ok(paginatedApplicationsSchema), 403),
    update: failing(ok(applicationSchema), ...DENIED_MISSING_OR_DUPLICATE),
    addPermissions: failing(
      createdList(permissionSchema),
      ...DENIED_MISSING_OR_DUPLICATE,
    ),
    listPermissions: failing(ok(paginatedPermissionsSchema), ...DENIED_OR_MISSING),
    addNavNodes: failing(
      createdList(navNodeCatalogSchema),
      ...DENIED_MISSING_OR_DUPLICATE,
    ),
    navTree: failing(ok(navCatalogSchema), ...DENIED_OR_MISSING),
    mapNavPermissions: failing(
      ok(navPermissionsResultSchema, 'What the call changed'),
      ...DENIED_OR_MISSING,
    ),
    unmapNavPermissions: failing(
      ok(navPermissionsResultSchema, 'What the call changed'),
      ...DENIED_OR_MISSING,
    ),
    upsertManifest: failing(
      ok(
        manifestUpsertSchema,
        'The diff the upsert applied — or, with `?dryRun=true`, the diff it would apply',
      ),
      ...DENIED_MISSING_OR_DUPLICATE,
    ),
  }),

  routes(ClientsController, {
    create: failing(created(clientSchema), 403, 409),
    list: failing(ok(paginatedClientsSchema), 403),
    update: failing(ok(clientSchema), ...DENIED_MISSING_OR_DUPLICATE),
    enableApplications: failing(
      createdList(clientApplicationSchema),
      ...DENIED_MISSING_OR_DUPLICATE,
    ),
    listApplications: failing(okList(clientApplicationSchema), ...DENIED_OR_MISSING),
    updateApplication: failing(ok(clientApplicationSchema), ...DENIED_OR_MISSING),
    createAdmin: failing(
      created(clientAdminSchema, 'The tenant’s first administrator'),
      ...DENIED_MISSING_OR_DUPLICATE,
    ),
  }),

  routes(ScopesController, {
    create: failing(created(scopeNodeSchema), ...DENIED_MISSING_OR_DUPLICATE),
    tree: failing(ok(scopeTreeSchema), 403),
    update: failing(ok(scopeNodeSchema), ...DENIED_MISSING_OR_DUPLICATE),
    remove: failing(
      noContent('The node was deleted'),
      ...DENIED_MISSING_OR_DUPLICATE,
    ),
  }),

  routes(RolesController, {
    create: failing(created(roleSchema), ...DENIED_MISSING_OR_DUPLICATE),
    list: failing(ok(paginatedRolesSchema), 403),
    update: failing(ok(roleSchema), ...DENIED_MISSING_OR_DUPLICATE),
    remove: failing(
      noContent('The role and its bindings were deleted'),
      ...DENIED_MISSING_OR_DUPLICATE,
    ),
    permissionCatalog: failing(
      ok(
        permissionCatalogSchema,
        'Everything a role of this tenant may be given (Doc 09 §3.2)',
      ),
      403,
    ),
    permissions: failing(ok(rolePermissionsSchema), ...DENIED_OR_MISSING),
    setPermissions: failing(
      ok(rolePermissionsSchema, 'The role’s new permission set'),
      ...DENIED_MISSING_OR_DUPLICATE,
    ),
  }),

  routes(UsersController, {
    create: failing(created(userSchema), ...DENIED_MISSING_OR_DUPLICATE),
    // A 200 and not a 201: the request produces a report about up to five
    // hundred users, so there is no single created resource to point at
    // (`BulkUserUploadResponse`). No 409 either — a duplicate address is a
    // `skipped` row of that report rather than a refusal of the request. The
    // 400 the universal list already carries is the document-level refusal:
    // malformed CSV, a header missing a column, too many rows.
    bulkUpload: failing(
      ok(bulkUserUploadSchema, 'The per-row result report'),
      403,
    ),
    list: failing(ok(paginatedUsersSchema), 403),
    byRole: failing(
      ok(paginatedUsersByRoleSchema, 'The role’s holders, with their scopes'),
      ...DENIED_OR_MISSING,
    ),
    detail: failing(
      ok(userDetailSchema, 'The user, with the grants they hold'),
      ...DENIED_OR_MISSING,
    ),
    // 409 covers three refusals here, not just the duplicate address: a
    // `disabled → active` reactivation and a caller changing their own status
    // are both conflicts with the state the rows are in (Doc 03 §8).
    update: failing(
      ok(userDetailSchema, 'The updated user, with the grants they hold'),
      ...DENIED_MISSING_OR_DUPLICATE,
    ),
  }),

  routes(BindingsController, {
    // 409 covers every Doc 02 §6 refusal as well as the duplicate grant: a role,
    // node or subject from another tenant is a cross-tenant violation, which
    // §2's table files next to the duplicate key rather than as a 404 — the
    // response must not distinguish "not yours" from "not real". The 400 the
    // universal list already carries is the subject XOR and a past `expires_at`.
    create: failing(
      created(roleBindingSchema, 'The grant, with the names behind its ids'),
      403,
      409,
    ),
    list: failing(ok(paginatedRoleBindingsSchema), 403),
    remove: failing(noContent('The grant was revoked'), ...DENIED_OR_MISSING),
  }),

  routes(AuthzController, {
    // No 403 on any of the three, and the omission is the contract: these
    // routes answer questions *about the bearer*, so holding a token is the
    // whole of the authorization (`authz.controller.ts`). A scope node that is
    // not the caller's own comes back as `allowed: false`, and a token that
    // fails verification as `active: false` — neither is a denial, and neither
    // may become one, or the endpoints turn into cross-tenant existence
    // oracles (Doc 06 §2). The universal 400 covers a malformed
    // `?applicationId=`, permission or node id.
    resolve: ok(resolvedGrantsSchema, 'The bearer’s complete grant set'),
    check: ok(permissionCheckSchema, 'Whether the bearer holds it there'),
    introspect: ok(introspectSchema, 'The token’s liveness and subject'),
  }),

  routes(NavigationController, {
    // No 403 and no 404, for the same reason `AuthzController` has neither: the
    // menu is a projection of the bearer's own grants (Doc 05 §3), so there is
    // nothing to be refused for, and an `?applicationId=` the caller may not see
    // comes back as an empty tree rather than a miss — a 404 there would make an
    // ungated route an existence oracle over the platform catalog (Doc 06 §2).
    // The universal 400 covers a malformed `?applicationId=`.
    tree: ok(navigationSchema, 'The bearer’s pruned menu'),
  }),

  routes(AuditController, {
    // 403 and nothing else beyond the universal list. There is no 404 because
    // there is nothing to miss — a filter that matches nothing is an empty page,
    // and for a client admin naming another tenant's `client_id` that emptiness
    // is the answer Doc 06 §2 requires (`audit-query.service.ts`). No 409
    // because nothing here writes a row a key could collide with.
    list: failing(ok(paginatedAuditSchema, 'One page of the audit trail'), 403),
    // The 400 the universal list already carries is this route's real refusal:
    // a filter matching more than the export cap is refused with the count
    // rather than truncated (`audit-export.service.ts`).
    export: failing(
      {
        status: 200,
        description: 'The filtered trail as CSV; the export is itself audited',
        mediaType: 'text/csv',
      },
      403,
    ),
  }),

  routes(ServiceAccountsController, {
    create: failing(
      created(serviceAccountSecretSchema, 'The account; secret shown once'),
      ...DENIED_MISSING_OR_DUPLICATE,
    ),
    list: failing(ok(paginatedServiceAccountsSchema), 403),
    rotate: failing(
      ok(serviceAccountSecretSchema, 'The account; new secret shown once'),
      ...DENIED_OR_MISSING,
    ),
    update: failing(ok(serviceAccountSchema), ...DENIED_OR_MISSING),
  }),
]);
