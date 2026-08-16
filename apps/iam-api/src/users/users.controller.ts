/**
 * `/iam/users` — the client-admin user surface (Doc 06 §8).
 *
 * The third surface a tenant drives entirely for itself, after `/iam/scopes` and
 * `/iam/roles`, and everything those controllers say about the tenant never
 * being a parameter applies here unchanged: the client comes from the verified
 * token's `cid` and from nowhere else (Doc 06 §1, Doc 07 §5). There is no
 * `?clientId=`.
 *
 * ## Six routes, and why two of them are declared where they are
 *
 * `GET /iam/users/by-role/:roleId` is declared **above** `GET /iam/users/:id`,
 * and `POST /iam/users/bulk` above `POST /iam/users/:id`-shaped neighbours,
 * because Nest matches in declaration order and a literal segment placed below a
 * parameterised one is shadowed by it. `:id` carries a `ParseUUIDPipe`, so the
 * shadowing would surface as a `400` complaining that `"bulk"` is not a uuid —
 * a better failure than a wrong handler, and still not the route the caller
 * asked for. `openapi.spec.ts` scans this class in declaration order, so the
 * published document would record the mistake too.
 *
 * ## The two bulk-shaped routes answer `200`
 *
 * `POST /iam/users/bulk` is a `200` rather than the `201` its verb suggests:
 * the request creates between zero and five hundred users and the response is a
 * report about all of them, so there is no single `Location` a `201` could
 * imply. See {@link BulkUserUploadResponse}.
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
  type BulkUserUploadResponse,
  type Paginated,
  type UserByRoleDTO,
  type UserDTO,
  type UserDetailDTO,
} from '@plantops/contracts';
import type { VerifiedClaims } from '@plantops/db';
import { Claims } from '../common/claims.decorator';
import { IamException } from '../common/iam.exception';
import { RateLimit } from '../common/rate-limit.decorator';
import { BulkUploadService } from './bulk-upload.service';
import {
  BulkUserUploadDto,
  CreateUserDto,
  UpdateUserDto,
  UsersByRoleQueryDto,
  UsersQueryDto,
} from './dto/users.dto';
import { UsersService } from './users.service';

/** The ordinary admin-surface bound, matching `/iam/roles` and `/iam/scopes`. */
const USERS_RATE_LIMIT = { limit: 60, windowSeconds: 60 } as const;

/**
 * The bulk upload's own, much tighter bound.
 *
 * One request here does what up to five hundred of the ordinary ones would, and
 * it holds a write transaction open while it does — so sharing the sixty-a-minute
 * budget would let a caller inside it issue thirty thousand row-writes a minute
 * without ever being throttled. Ten an hour's worth of rosters is far more than
 * onboarding a plant needs, and a legitimate re-upload after fixing a file is
 * two or three.
 */
const BULK_UPLOAD_RATE_LIMIT = { limit: 10, windowSeconds: 60 } as const;

/** Parses a uuid path segment, refusing anything else before any query runs. */
const uuidParam = () => new ParseUUIDPipe({ version: '4' });

@Controller(`${IAM_ROUTE_PREFIX}/users`)
export class UsersController {
  constructor(
    private readonly users: UsersService,
    private readonly bulk: BulkUploadService,
  ) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RateLimit(USERS_RATE_LIMIT)
  create(
    @Claims() claims: VerifiedClaims,
    @Body() body: CreateUserDto,
  ): Promise<UserDTO> {
    return this.users.create(claims, body);
  }

  /**
   * The staff-list upload and its per-row report (Doc 06 §8, Doc 09 §3.3).
   *
   * Both formats arrive as JSON — the CSV as a string field — under this route's
   * own larger body ceiling (`common/body-parser.middleware.ts`). The `200` and
   * the partial-success semantics are argued in the header and in
   * {@link BulkUserUploadResponse}.
   */
  @Post('bulk')
  @HttpCode(HttpStatus.OK)
  @RateLimit(BULK_UPLOAD_RATE_LIMIT)
  bulkUpload(
    @Claims() claims: VerifiedClaims,
    @Body() body: BulkUserUploadDto,
  ): Promise<BulkUserUploadResponse> {
    return this.bulk.upload(claims, body);
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
   * "Users by Role" — who holds a role, and where (Doc 06 §8, Doc 09 §3.3).
   *
   * Declared above `:id`; see the header. A role belonging to another tenant is
   * invisible under RLS, so it is the same 404 a nonexistent id gets.
   */
  @Get('by-role/:roleId')
  @RateLimit(USERS_RATE_LIMIT)
  async byRole(
    @Claims() claims: VerifiedClaims,
    @Param('roleId', uuidParam()) roleId: string,
    @Query() query: UsersByRoleQueryDto,
  ): Promise<Paginated<UserByRoleDTO>> {
    const holders = await this.users.byRole(claims, roleId, query);
    if (holders === null) throw IamException.notFound('The role');
    return holders;
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
