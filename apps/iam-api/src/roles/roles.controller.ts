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
 * Authenticated by the app-wide `AuthGuard`, then checked inside the service —
 * not as a guard, because a guard runs before the transaction that carries the
 * RLS context exists (`common/administrator.ts`). Interim until Session 23
 * replaces it with `@RequirePermission('iam.client.role.*')`.
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
  Req,
} from '@nestjs/common';
import {
  IAM_ROUTE_PREFIX,
  type Paginated,
  type RoleDTO,
  type RolePermissionsResponse,
} from '@plantops/contracts';
import type { Request } from 'express';
import { IamException } from '../common/iam.exception';
import { RateLimit } from '../common/rate-limit.decorator';
import { verifiedClaimsOf } from '../common/verified-claims';
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
  create(@Req() request: Request, @Body() body: CreateRoleDto): Promise<RoleDTO> {
    return this.roles.create(claimsOf(request), body);
  }

  @Get()
  @RateLimit(ROLES_RATE_LIMIT)
  list(
    @Req() request: Request,
    @Query() query: RolesPaginationDto,
  ): Promise<Paginated<RoleDTO>> {
    return this.roles.list(claimsOf(request), query);
  }

  @Patch(':id')
  @RateLimit(ROLES_RATE_LIMIT)
  async update(
    @Req() request: Request,
    @Param('id', uuidParam()) id: string,
    @Body() body: UpdateRoleDto,
  ): Promise<RoleDTO> {
    const updated = await this.roles.update(claimsOf(request), id, body);
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
  async remove(
    @Req() request: Request,
    @Param('id', uuidParam()) id: string,
  ): Promise<void> {
    const removed = await this.roles.remove(claimsOf(request), id);
    if (!removed) throw IamException.notFound('The role');
  }

  @Get(':id/permissions')
  @RateLimit(ROLES_RATE_LIMIT)
  async permissions(
    @Req() request: Request,
    @Param('id', uuidParam()) id: string,
  ): Promise<RolePermissionsResponse> {
    const mapping = await this.roles.permissions(claimsOf(request), id);
    if (mapping === null) throw IamException.notFound('The role');
    return mapping;
  }

  /** Replaces the role's permissions, validated against enabled apps (Doc 02 §6). */
  @Put(':id/permissions')
  @RateLimit(ROLES_RATE_LIMIT)
  async setPermissions(
    @Req() request: Request,
    @Param('id', uuidParam()) id: string,
    @Body() body: SetRolePermissionsDto,
  ): Promise<RolePermissionsResponse> {
    const mapping = await this.roles.setPermissions(
      claimsOf(request),
      id,
      body.permission_ids,
    );
    if (mapping === null) throw IamException.notFound('The role');
    return mapping;
  }
}

/**
 * The verified claims for this request.
 *
 * The guard has already refused anything without them, so reaching the throw is
 * a wiring bug — a route that lost its guard — and it fails closed rather than
 * running the handler with no subject.
 */
function claimsOf(request: Request) {
  const claims = verifiedClaimsOf(request);
  if (!claims) throw IamException.authRequired();
  return claims;
}
