/**
 * `/iam/users` — the client-admin user surface (Doc 06 §8).
 *
 * The third surface a tenant drives entirely for itself, after `/iam/scopes` and
 * `/iam/roles`, and everything those controllers say about the tenant never
 * being a parameter applies here unchanged: the client comes from the verified
 * token's `cid` and from nowhere else (Doc 06 §1, Doc 07 §5). There is no
 * `?clientId=`.
 *
 * ## Four routes now, six by the end of Session 19
 *
 * Doc 06 §8's table also lists `POST /iam/users/bulk` and
 * `GET /iam/users/by-role/:roleId`, which are Session 19's. When they arrive,
 * `by-role` has to be declared **above** `:id` — Nest matches in declaration
 * order, and a route added below it would be shadowed by the parameterised one.
 * Today `:id` is a `ParseUUIDPipe`, so the shadowing would surface as a 400
 * rather than as a wrong handler, which is a better failure than most but still
 * not the route the caller asked for.
 *
 * ## `PATCH` is one route for two kinds of change
 *
 * "update, lock, unlock, disable", as Doc 06 §8 spells it, and as Doc 09 §3.3's
 * detail screen saves it. What separates a profile edit from a state transition
 * is decided in `UsersService`, not here — a controller that branched on the
 * body would be a second copy of a rule that has to hold whoever calls it.
 *
 * ## Why the detail shape comes back from `PATCH`
 *
 * `POST` answers with {@link UserDTO} and everything else with
 * {@link UserDetailDTO}. Not an inconsistency: a freshly created user has no
 * bindings and could only ever carry an empty array, while the screen that
 * issues a `PATCH` is the detail screen, and re-rendering it after a save should
 * not cost a second round-trip. A lock that revoked the sessions of somebody
 * whose grants are on screen is exactly the moment to send the grants back.
 *
 * ## Authorization
 *
 * Authenticated by the app-wide `AuthGuard`, then checked inside the service —
 * not as a guard, because a guard runs before the transaction that carries the
 * RLS context exists (`common/administrator.ts`). Interim until Session 23
 * replaces it with `@RequirePermission('iam.client.user.*')`, whose guard
 * carries its own connection and RLS context rather than the request's
 * (`docs/adr/0001-permission-guard-connection-strategy.md`) — the routes, status
 * codes and envelopes below are unaffected by the swap.
 */

import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  IAM_ROUTE_PREFIX,
  type Paginated,
  type UserDTO,
  type UserDetailDTO,
} from '@plantops/contracts';
import type { VerifiedClaims } from '@plantops/db';
import { Claims } from '../common/claims.decorator';
import { IamException } from '../common/iam.exception';
import { RateLimit } from '../common/rate-limit.decorator';
import { CreateUserDto, UpdateUserDto, UsersQueryDto } from './dto/users.dto';
import { UsersService } from './users.service';

/** The ordinary admin-surface bound, matching `/iam/roles` and `/iam/scopes`. */
const USERS_RATE_LIMIT = { limit: 60, windowSeconds: 60 } as const;

/** Parses a uuid path segment, refusing anything else before any query runs. */
const uuidParam = () => new ParseUUIDPipe({ version: '4' });

@Controller(`${IAM_ROUTE_PREFIX}/users`)
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RateLimit(USERS_RATE_LIMIT)
  create(
    @Claims() claims: VerifiedClaims,
    @Body() body: CreateUserDto,
  ): Promise<UserDTO> {
    return this.users.create(claims, body);
  }

  /** List, search and the `status=locked` filter of Doc 09 §3.3. */
  @Get()
  @RateLimit(USERS_RATE_LIMIT)
  list(
    @Claims() claims: VerifiedClaims,
    @Query() query: UsersQueryDto,
  ): Promise<Paginated<UserDTO>> {
    return this.users.list(claims, query);
  }

  /**
   * The profile and the bindings behind it (Doc 09 §3.3).
   *
   * A user belonging to another tenant is invisible under RLS, so it is the same
   * 404 a nonexistent id gets — the response cannot be used to discover that an
   * address exists elsewhere (Doc 06 §2).
   */
  @Get(':id')
  @RateLimit(USERS_RATE_LIMIT)
  async detail(
    @Claims() claims: VerifiedClaims,
    @Param('id', uuidParam()) id: string,
  ): Promise<UserDetailDTO> {
    const user = await this.users.detail(claims, id);
    if (user === null) throw IamException.notFound('The user');
    return user;
  }

  /** Update, lock, unlock or disable (Doc 06 §8, Doc 03 §8). */
  @Patch(':id')
  @RateLimit(USERS_RATE_LIMIT)
  async update(
    @Claims() claims: VerifiedClaims,
    @Param('id', uuidParam()) id: string,
    @Body() body: UpdateUserDto,
  ): Promise<UserDetailDTO> {
    const updated = await this.users.update(claims, id, body);
    if (updated === null) throw IamException.notFound('The user');
    return updated;
  }
}
