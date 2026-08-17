/**
 * `/iam/role-bindings` — the grant surface (Doc 06 §9, Doc 09 §3.4).
 *
 * The fourth surface a tenant drives entirely for itself, after `/iam/scopes`,
 * `/iam/roles` and `/iam/users`, and everything those controllers say about the
 * tenant never being a parameter applies here unchanged: the client comes from
 * the verified token's `cid` and from nowhere else (Doc 06 §1, Doc 07 §5). There
 * is no `?clientId=`.
 *
 * ## Three routes, and no `PATCH`
 *
 * Doc 06 §9 lists bind, list and unbind. There is no update, and the omission is
 * the design: every column of a `role_binding` except `expires_at` is part of
 * the identity the unique index is built on, so "editing" a binding is binding
 * a different subject, role or node — a new grant and, usually, a revoked one.
 * Extending an expiry through a `PATCH` would be the one editable field, and it
 * would arrive as a change with no record of what the grant used to be; unbind
 * and re-bind leaves two audit rows that say exactly that (Doc 10 §4).
 *
 * ## Why `POST` is declared like `/iam/scopes`'s `PATCH`
 *
 * `@Transactional({ isolation: 'REPEATABLE READ', retries: 2 })` is Doc 04
 * §7.1's second mandatory rule, quoted: *"a binding insert that races a move on
 * the same subtree should serialize behind it (retry on serialization
 * failure)"*. This is the other side of the race `ScopesService.move` is
 * arranged around — the move rewrites the paths a binding's coverage is derived
 * from, and an insert that read the subtree at `READ COMMITTED` could anchor a
 * grant to a node whose path changed underneath it, producing coverage neither
 * request intended and nothing to detect it afterwards.
 *
 * The level has to be chosen before the transaction's first statement, and by
 * the time the service runs one has been open since the RLS context was applied
 * — so, as on `/iam/scopes`, it is metadata on the route rather than something
 * the service could ask for (`common/transaction-context.ts`). The two retries
 * are safe by the same construction: the handler's only effect outside Postgres
 * is registered with `afterCommit()`, and a discarded attempt's callbacks are
 * discarded with it.
 *
 * `DELETE` does not carry it. Removing a binding reads and deletes one row by
 * primary key and derives nothing from the tree, so a concurrent move cannot
 * make its answer wrong; the stricter snapshot would only give it a serialization
 * failure to retry.
 *
 * ## Authorization
 *
 * Authenticated by the app-wide `AuthGuard`, then authorized by
 * `PermissionGuard` from the `@RequirePermission('iam.client.binding.…')` on each
 * route below (Doc 04 §8). The guard carries its own connection and RLS context
 * rather than the request's, because it runs before the interceptor opens one
 * (`docs/adr/0001-permission-guard-connection-strategy.md`).
 *
 * `POST` additionally names its target with `scopeFrom: 'body.scope_node_id'`,
 * so an admin may only grant **where they themselves hold the permission** — a
 * coordinator bound at Plant B cannot bind anybody at Plant A. Without that, the
 * WHERE dimension would be advisory on the one surface that creates it.
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
  Post,
  Query,
} from '@nestjs/common';
import { RequirePermission } from '@plantops/auth-kit';
import {
  IAM_ROUTE_PREFIX,
  type Paginated,
  type RoleBindingDTO,
} from '@plantops/contracts';
import type { VerifiedClaims } from '@plantops/db';
import { IAM_CLIENT_PERMISSIONS as P } from '../authz/iam-permissions';
import { Claims } from '../common/claims.decorator';
import { IamException } from '../common/iam.exception';
import { RateLimit } from '../common/rate-limit.decorator';
import { Transactional } from '../common/transaction-context';
import { BindingsService } from './bindings.service';
import { CreateRoleBindingDto, RoleBindingsQueryDto } from './dto/bindings.dto';

/** The ordinary admin-surface bound, matching `/iam/roles` and `/iam/users`. */
const BINDINGS_RATE_LIMIT = { limit: 60, windowSeconds: 60 } as const;

/** Parses a uuid path segment, refusing anything else before any query runs. */
const uuidParam = () => new ParseUUIDPipe({ version: '4' });

@Controller(`${IAM_ROUTE_PREFIX}/role-bindings`)
export class BindingsController {
  constructor(private readonly bindings: BindingsService) {}

  /** Doc 09 §3.4's single action: subject × role × scope node [+ expiry]. */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RateLimit(BINDINGS_RATE_LIMIT)
  @RequirePermission(P.BINDING_CREATE, { scopeFrom: 'body.scope_node_id' })
  @Transactional({ isolation: 'REPEATABLE READ', retries: 2 })
  create(
    @Claims() claims: VerifiedClaims,
    @Body() body: CreateRoleBindingDto,
  ): Promise<RoleBindingDTO> {
    return this.bindings.create(claims, body);
  }

  /** The bindings list, filterable by user, role and scope (Doc 06 §9). */
  @Get()
  @RateLimit(BINDINGS_RATE_LIMIT)
  @RequirePermission(P.BINDING_READ)
  list(
    @Claims() claims: VerifiedClaims,
    @Query() query: RoleBindingsQueryDto,
  ): Promise<Paginated<RoleBindingDTO>> {
    return this.bindings.list(claims, query);
  }

  /**
   * Unbind (Doc 06 §9).
   *
   * A binding belonging to another tenant is invisible under RLS, so it is the
   * same 404 a nonexistent id gets — the response cannot be used to discover
   * that a grant exists elsewhere (Doc 06 §2).
   */
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RateLimit(BINDINGS_RATE_LIMIT)
  @RequirePermission(P.BINDING_DELETE)
  async remove(
    @Claims() claims: VerifiedClaims,
    @Param('id', uuidParam()) id: string,
  ): Promise<void> {
    const removed = await this.bindings.remove(claims, id);
    if (!removed) throw IamException.notFound('The role binding');
  }
}
