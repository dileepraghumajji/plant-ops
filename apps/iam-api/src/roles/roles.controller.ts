/**
 * `/iam/roles` — the client-admin role surface (Doc 06 §7).
 *
 * The second surface a tenant drives entirely for itself, after `/iam/scopes`,
 * and everything that controller's header says about the tenant never being a
 * parameter applies here unchanged: the client comes from the verified token's
 * `cid` and from nowhere else (Doc 06 §1, Doc 07 §5). There is no `?clientId=`.
 *
 * ## Six routes, and why the permission mapping is a `PUT`
 *
 * Doc 06 §7's table names it: `PUT /roles/:id/permissions` — *set* the role's
 * permissions. Not `POST` (which would add) and not `PATCH` (which would
 * partially amend), because the thing being sent is the picker's whole state and
 * a replacement is the only reading under which submitting the same body twice
 * means the same thing both times.
 *
 * ## No `@Transactional`
 *
 * Unlike `/iam/scopes`'s `PATCH`, nothing here needs an isolation level above the
 * default. The one multi-statement write — the permission diff — touches rows
 * keyed by `(role_id, permission_id)` and is validated against the catalog and
 * the tenant's enablement, neither of which a concurrent request to this
 * controller can move. Two admins racing the same role's picker still produce one
 * of the two submitted sets, which is what a `PUT` promises; a stricter level
 * would not make one of them win differently, it would only make one of them
 * fail.
 *
 * ## Authorization
 *
 * Authenticated by the app-wide `AuthGuard`, then authorized by
 * `PermissionGuard` from the `@RequirePermission('iam.client.role.…')` on each
 * route below (Doc 04 §8). The guard carries its own connection and RLS context
 * rather than the request's, because it runs before the interceptor opens one
 * (`docs/adr/0001-permission-guard-connection-strategy.md`).
 *
 * Renaming and setting a role's permissions carry different keys, because they
 * are different powers: one is cosmetic, the other changes what every subject
 * bound to the role may do (`authz/iam-permissions.ts`).
 */

import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { RequirePermission } from '@plantops/auth-kit';
import {
  IAM_ROUTE_PREFIX,
  type Paginated,
  type RoleDTO,
  type RolePermissionsResponse,
} from '@plantops/contracts';
import type { VerifiedClaims } from '@plantops/db';
import { IAM_CLIENT_PERMISSIONS as P } from '../authz/iam-permissions';
import { Claims } from '../common/claims.decorator';
import { IamException } from '../common/iam.exception';
import { RateLimit } from '../common/rate-limit.decorator';
import {
  CreateRoleDto,
  RolesPaginationDto,
  SetRolePermissionsDto,
  UpdateRoleDto,
} from './dto/roles.dto';
import { RolesService } from './roles.service';

/** The ordinary admin-surface bound, matching `/iam/scopes` and `/iam/clients`. */
const ROLES_RATE_LIMIT = { limit: 60, windowSeconds: 60 } as const;

/** Parses a uuid path segment, refusing anything else before any query runs. */
const uuidParam = () => new ParseUUIDPipe({ version: '4' });

@Controller(`${IAM_ROUTE_PREFIX}/roles`)
export class RolesController {
  constructor(private readonly roles: RolesService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RateLimit(ROLES_RATE_LIMIT)
  @RequirePermission(P.ROLE_CREATE)
  create(
    @Claims() claims: VerifiedClaims,
    @Body() body: CreateRoleDto,
  ): Promise<RoleDTO> {
    return this.roles.create(claims, body);
  }

  @Get()
  @RateLimit(ROLES_RATE_LIMIT)
  @RequirePermission(P.ROLE_READ)
  list(
    @Claims() claims: VerifiedClaims,
    @Query() query: RolesPaginationDto,
  ): Promise<Paginated<RoleDTO>> {
    return this.roles.list(claims, query);
  }

  @Patch(':id')
  @RateLimit(ROLES_RATE_LIMIT)
  @RequirePermission(P.ROLE_UPDATE)
  async update(
    @Claims() claims: VerifiedClaims,
    @Param('id', uuidParam()) id: string,
    @Body() body: UpdateRoleDto,
  ): Promise<RoleDTO> {
    const updated = await this.roles.update(claims, id, body);
    if (updated === null) throw IamException.notFound('The role');
    return updated;
  }

  /**
   * Deletes the role and cascades its bindings (Doc 06 §7).
   *
   * A role belonging to another tenant is invisible under RLS, so it is the same
   * 404 a nonexistent id gets — the response cannot be used to discover that a
   * role exists elsewhere (Doc 06 §2). A system role of this tenant is the 409
   * the service raises, which says which of the two refused.
   */
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RateLimit(ROLES_RATE_LIMIT)
  @RequirePermission(P.ROLE_DELETE)
  async remove(
    @Claims() claims: VerifiedClaims,
    @Param('id', uuidParam()) id: string,
  ): Promise<void> {
    const removed = await this.roles.remove(claims, id);
    if (!removed) throw IamException.notFound('The role');
  }

  @Get(':id/permissions')
  @RateLimit(ROLES_RATE_LIMIT)
  @RequirePermission(P.ROLE_PERMISSION_READ)
  async permissions(
    @Claims() claims: VerifiedClaims,
    @Param('id', uuidParam()) id: string,
  ): Promise<RolePermissionsResponse> {
    const mapping = await this.roles.permissions(claims, id);
    if (mapping === null) throw IamException.notFound('The role');
    return mapping;
  }

  /** Replaces the role's permissions, validated against enabled apps (Doc 02 §6). */
  @Put(':id/permissions')
  @RateLimit(ROLES_RATE_LIMIT)
  @RequirePermission(P.ROLE_PERMISSION_SET)
  async setPermissions(
    @Claims() claims: VerifiedClaims,
    @Param('id', uuidParam()) id: string,
    @Body() body: SetRolePermissionsDto,
  ): Promise<RolePermissionsResponse> {
    const mapping = await this.roles.setPermissions(claims, id, body.permission_ids);
    if (mapping === null) throw IamException.notFound('The role');
    return mapping;
  }
}
