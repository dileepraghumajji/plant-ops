/**
 * `/iam/scopes` — the client-admin org tree (Doc 06 §6).
 *
 * The first surface in the system that a tenant drives entirely for itself
 * (Doc 02 §4): the platform creates the client, its first admin and the root
 * node (Session 15), and everything below that root is built here.
 *
 * ## Four routes, and the tenant is never one of the parameters
 *
 * Unlike `/iam/clients`, which is *about* tenants and names one in its path,
 * every route here is *scoped to* the caller's tenant, which comes from the
 * verified token's `cid` and from nowhere else (Doc 06 §1, Doc 07 §5). There is
 * no `?clientId=` and there will not be one: it would be a parameter that looks
 * like it selects a tenant while RLS quietly ignores it.
 *
 * ## Why `PATCH` is declared differently from its neighbours
 *
 * `@Transactional({ isolation: 'REPEATABLE READ', retries: 2 })` is the whole of
 * Doc 04 §7.1's isolation and retry requirement, and it sits on the route
 * because that is the only place it *can* sit — the level has to be chosen
 * before the transaction's first statement, and by the time the service runs,
 * one has been open since the RLS context was applied. `ScopesService.move`
 * supplies the other three steps: capture before, one statement, publish after
 * commit.
 *
 * It covers renames too, which do not need it. That costs a slightly stricter
 * snapshot on a single-column update and buys the alternative's absence: two
 * routes for one row's edit, differing only in a level of isolation that a
 * caller cannot see and would have to choose correctly.
 *
 * ## Authorization
 *
 * Authenticated by the app-wide `AuthGuard`, then authorized by
 * `PermissionGuard` from the `@RequirePermission('iam.client.scope.…')` on each
 * route below (Doc 04 §8). The guard carries its own connection and RLS context
 * rather than the request's, because it runs before the interceptor opens one
 * (`docs/adr/0001-permission-guard-connection-strategy.md`).
 *
 * `PATCH` and `DELETE` name the node itself with `scopeFrom: 'params.id'`, so an
 * admin restructures only the part of the tree they hold over. `POST` names the
 * parent and tolerates its absence: a tenant's first root is created with its
 * first administrator (`clients/client-admin.service.ts`), because a tenant with
 * no tree has nowhere to bind one.
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
} from '@nestjs/common';
import { RequirePermission } from '@plantops/auth-kit';
import {
  IAM_ROUTE_PREFIX,
  type ScopeNodeDTO,
  type ScopeTreeResponse,
} from '@plantops/contracts';
import type { VerifiedClaims } from '@plantops/db';
import { IAM_CLIENT_PERMISSIONS as P } from '../authz/iam-permissions';
import { Claims } from '../common/claims.decorator';
import { IamException } from '../common/iam.exception';
import { RateLimit } from '../common/rate-limit.decorator';
import { Transactional } from '../common/transaction-context';
import { CreateScopeNodeDto, UpdateScopeNodeDto } from './dto/scopes.dto';
import { ScopesService } from './scopes.service';

/** The ordinary admin-surface bound, matching `/iam/clients`. */
const SCOPES_RATE_LIMIT = { limit: 60, windowSeconds: 60 } as const;

/**
 * Tighter, because a move is the one call here whose cost is unbounded by the
 * request: it rewrites a whole subtree and holds a `REPEATABLE READ` snapshot
 * while it does. Ten a minute is far more reorganisation than an org chart ever
 * sees, and a client hammering this endpoint is a bug rather than a workload.
 */
const MOVE_RATE_LIMIT = { limit: 10, windowSeconds: 60 } as const;

/** Parses a uuid path segment, refusing anything else before any query runs. */
const uuidParam = () => new ParseUUIDPipe({ version: '4' });

@Controller(`${IAM_ROUTE_PREFIX}/scopes`)
export class ScopesController {
  constructor(private readonly scopes: ScopesService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RateLimit(SCOPES_RATE_LIMIT)
  @RequirePermission(P.SCOPE_CREATE, {
    scopeFrom: 'body.parent_id',
    scopeOptional: true,
  })
  create(
    @Claims() claims: VerifiedClaims,
    @Body() body: CreateScopeNodeDto,
  ): Promise<ScopeNodeDTO> {
    return this.scopes.create(claims, body);
  }

  @Get()
  @RateLimit(SCOPES_RATE_LIMIT)
  @RequirePermission(P.SCOPE_READ)
  tree(@Claims() claims: VerifiedClaims): Promise<ScopeTreeResponse> {
    return this.scopes.tree(claims);
  }

  /** Rename and/or move. See the header for why the isolation lives here. */
  @Patch(':id')
  @RateLimit(MOVE_RATE_LIMIT)
  @RequirePermission(P.SCOPE_UPDATE, { scopeFrom: 'params.id' })
  @Transactional({ isolation: 'REPEATABLE READ', retries: 2 })
  async update(
    @Claims() claims: VerifiedClaims,
    @Param('id', uuidParam()) id: string,
    @Body() body: UpdateScopeNodeDto,
  ): Promise<ScopeNodeDTO> {
    const updated = await this.scopes.update(claims, id, body);
    if (updated === null) throw IamException.notFound('The scope node');
    return updated;
  }

  /**
   * Removes a leaf with nothing anchored to it (Doc 06 §6).
   *
   * A node from another tenant is invisible under RLS, so it is the same 404 a
   * nonexistent id gets — the response cannot be used to discover that a node
   * exists elsewhere (Doc 06 §2). A node that exists here but is still in use is
   * the 409 the service raises, which says which of the two guards refused.
   */
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RateLimit(SCOPES_RATE_LIMIT)
  @RequirePermission(P.SCOPE_DELETE, { scopeFrom: 'params.id' })
  async remove(
    @Claims() claims: VerifiedClaims,
    @Param('id', uuidParam()) id: string,
  ): Promise<void> {
    const removed = await this.scopes.remove(claims, id);
    if (!removed) throw IamException.notFound('The scope node');
  }
}
