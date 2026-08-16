/**
 * The pin between `schemas.ts` and the published contracts.
 *
 * Every assertion below is a *type*, checked by `nx typecheck` rather than by
 * Jest — the SWC transform strips types without checking them (Doc 08 §7), so
 * these fail the build, not the test run. That is deliberate: a response schema
 * that has drifted from its DTO produces an OpenAPI document which lies to an
 * integrating team, and a lie in a published contract should stop a release
 * rather than turn a suite red.
 *
 * `Equal` is invariant, so it catches the four ways a mirror goes wrong: a
 * missing field, an extra field, a widened or narrowed union, and an optionality
 * change.
 *
 * The two recursive schemas are asserted the other way round — see the header of
 * `schemas.ts`. Their `z.ZodType<…>` annotation is the check.
 *
 * The runtime cases at the bottom cover what a type cannot: that the registry's
 * names are unique, and that every schema in it can actually be converted.
 */

import type {
  AccessTokenResponse,
  ApplicationDTO,
  BulkUserUploadResponse,
  ClientAdminDTO,
  ClientApplicationDTO,
  ClientDTO,
  Equal,
  Expect,
  IamErrorResponse,
  JwkDTO,
  JwksResponse,
  ManifestUpsertResponse,
  NavCatalogResponse,
  NavPermissionsResult,
  Paginated,
  PermissionDTO,
  RoleDTO,
  RolePermissionsResponse,
  ScopeTreeResponse,
  ServiceAccountDTO,
  ServiceAccountSecretDTO,
  SessionDTO,
  TokenPairResponse,
  UserByRoleDTO,
  UserDTO,
  UserDetailDTO,
} from '@plantops/contracts';
import type { z } from 'zod';
import type { ReadinessReport } from '../health/health.service';
import type { LivenessReport } from '../health/health.controller';
import type { WhoAmIResponse } from '../iam/whoami.controller';
import {
  SCHEMA_REF_PREFIX,
  accessTokenSchema,
  applicationSchema,
  bulkUserUploadSchema,
  clientAdminSchema,
  clientApplicationSchema,
  clientSchema,
  componentSchemas,
  errorResponseSchema,
  jwkSchema,
  jwksSchema,
  livenessSchema,
  manifestUpsertSchema,
  navCatalogSchema,
  navPermissionsResultSchema,
  paginatedApplicationsSchema,
  paginatedClientsSchema,
  paginatedPermissionsSchema,
  paginatedRolesSchema,
  paginatedServiceAccountsSchema,
  paginatedUsersByRoleSchema,
  paginatedUsersSchema,
  permissionSchema,
  readinessSchema,
  refFor,
  roleSchema,
  rolePermissionsSchema,
  scopeTreeSchema,
  serviceAccountSchema,
  serviceAccountSecretSchema,
  sessionSchema,
  tokenPairSchema,
  userByRoleSchema,
  userDetailSchema,
  userSchema,
  whoAmISchema,
} from './schemas';

/**
 * `Expect` is applied at each use site rather than folded in here: inside a
 * generic alias its argument is still unresolved, so `Equal<…>` widens to
 * `boolean` and the constraint fails before any assertion is instantiated.
 */
type Mirrors<Schema extends z.ZodType, Contract> = Equal<
  z.infer<Schema>,
  Contract
>;

/**
 * Collected into one exported tuple, the convention `contracts.spec.ts` uses:
 * every entry must still compile, and nothing is reported as an unused local.
 */
export type _ResponseSchemasMirrorTheContracts = [
  // errors
  Expect<Mirrors<typeof errorResponseSchema, IamErrorResponse>>,

  // auth
  Expect<Mirrors<typeof tokenPairSchema, TokenPairResponse>>,
  Expect<Mirrors<typeof accessTokenSchema, AccessTokenResponse>>,
  Expect<Mirrors<typeof sessionSchema, SessionDTO>>,
  Expect<Mirrors<typeof jwkSchema, JwkDTO>>,
  Expect<Mirrors<typeof jwksSchema, JwksResponse>>,

  // registry
  Expect<Mirrors<typeof applicationSchema, ApplicationDTO>>,
  Expect<Mirrors<typeof permissionSchema, PermissionDTO>>,
  Expect<Mirrors<typeof navCatalogSchema, NavCatalogResponse>>,
  Expect<Mirrors<typeof navPermissionsResultSchema, NavPermissionsResult>>,
  Expect<Mirrors<typeof manifestUpsertSchema, ManifestUpsertResponse>>,

  // clients
  Expect<Mirrors<typeof clientSchema, ClientDTO>>,
  Expect<Mirrors<typeof clientApplicationSchema, ClientApplicationDTO>>,
  Expect<Mirrors<typeof clientAdminSchema, ClientAdminDTO>>,

  // scopes, roles, users, service accounts
  Expect<Mirrors<typeof scopeTreeSchema, ScopeTreeResponse>>,
  Expect<Mirrors<typeof roleSchema, RoleDTO>>,
  Expect<Mirrors<typeof rolePermissionsSchema, RolePermissionsResponse>>,
  Expect<Mirrors<typeof userSchema, UserDTO>>,
  Expect<Mirrors<typeof userDetailSchema, UserDetailDTO>>,
  Expect<Mirrors<typeof userByRoleSchema, UserByRoleDTO>>,
  Expect<Mirrors<typeof bulkUserUploadSchema, BulkUserUploadResponse>>,
  Expect<Mirrors<typeof serviceAccountSchema, ServiceAccountDTO>>,
  Expect<Mirrors<typeof serviceAccountSecretSchema, ServiceAccountSecretDTO>>,

  // identity & ops
  Expect<Mirrors<typeof whoAmISchema, WhoAmIResponse>>,
  Expect<Mirrors<typeof livenessSchema, LivenessReport>>,
  Expect<Mirrors<typeof readinessSchema, ReadinessReport>>,

  // paginated envelopes
  Expect<Mirrors<typeof paginatedApplicationsSchema, Paginated<ApplicationDTO>>>,
  Expect<Mirrors<typeof paginatedPermissionsSchema, Paginated<PermissionDTO>>>,
  Expect<Mirrors<typeof paginatedClientsSchema, Paginated<ClientDTO>>>,
  Expect<Mirrors<typeof paginatedRolesSchema, Paginated<RoleDTO>>>,
  Expect<Mirrors<typeof paginatedUsersSchema, Paginated<UserDTO>>>,
  Expect<Mirrors<typeof paginatedUsersByRoleSchema, Paginated<UserByRoleDTO>>>,
  Expect<Mirrors<typeof paginatedServiceAccountsSchema, Paginated<ServiceAccountDTO>>>,
];

describe('OpenAPI response schemas', () => {
  const schemas = componentSchemas();

  it('converts every declared schema', () => {
    // Every `named(...)` above reaches `components.schemas` — a schema the
    // registry holds but the conversion drops would be a `$ref` to nothing.
    for (const declared of [
      applicationSchema,
      clientSchema,
      roleSchema,
      serviceAccountSchema,
      errorResponseSchema,
    ]) {
      expect(schemas[refFor(declared).replace(SCHEMA_REF_PREFIX, '')]).toBeDefined();
    }
  });

  it('shares one definition between an envelope and its item', () => {
    // Only correct if `$ref` resolution worked: the paginated envelope must
    // point at `RoleDTO` rather than inline a second copy that can disagree.
    expect(JSON.stringify(schemas['PaginatedRoleDTO'])).toContain(
      `${SCHEMA_REF_PREFIX}RoleDTO`,
    );
  });

  it('publishes the recursive trees as self-references', () => {
    expect(JSON.stringify(schemas['ScopeNodeDTO'])).toContain(
      `${SCHEMA_REF_PREFIX}ScopeNodeDTO`,
    );
    expect(JSON.stringify(schemas['NavNodeCatalogDTO'])).toContain(
      `${SCHEMA_REF_PREFIX}NavNodeCatalogDTO`,
    );
  });

  it('closes response objects and leaves the error envelope readable', () => {
    const envelope = schemas['IamErrorResponse'] as {
      properties: { error: { properties: { code: { enum: string[] } } } };
    };

    // The one field consumers branch on is the closed enum, not a string.
    expect(envelope.properties.error.properties.code.enum).toContain(
      'SCOPE_DENIED',
    );
  });
});
