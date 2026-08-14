/**
 * `/iam/service-accounts` — the machine-identity admin surface (Doc 06 §10).
 *
 * Four routes, and the shape of each is decided by one fact: the secret is
 * shown once (Doc 03 §7). So create and rotate are the only ones that return a
 * `ServiceAccountSecretDTO`, and there is deliberately no `GET /:id` — a detail
 * route would return everything the list already does and would be the obvious
 * place for somebody to later "just add" the secret back.
 *
 * Every route is authenticated (the app-wide `AuthGuard`) and additionally
 * checked inside the service, which is where the interim
 * platform-admin-or-client-admin rule lives and why it is not a guard: a guard
 * runs before `TenantContextInterceptor` opens the transaction, so it has no RLS
 * context to check anything against. See `service-accounts.service.ts`.
 *
 * ## Deletion is not here, and that is the spec
 *
 * Doc 06 §10 lists create, list, rotate and PATCH — no DELETE. Revoking is the
 * off switch, and it keeps the row: `role_binding` references it, `audit_trail`
 * names it, and an account that vanishes takes the explanation of everything it
 * ever did with it.
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
  Req,
} from '@nestjs/common';
import {
  IAM_ROUTE_PREFIX,
  type Paginated,
  type ServiceAccountDTO,
  type ServiceAccountSecretDTO,
} from '@plantops/contracts';
import type { Request } from 'express';
import { IamException } from '../common/iam.exception';
import { RateLimit } from '../common/rate-limit.decorator';
import { verifiedClaimsOf } from '../common/verified-claims';
import {
  CreateServiceAccountDto,
  PaginationDto,
  UpdateServiceAccountDto,
} from './service-accounts.dto';
import { ServiceAccountsService } from './service-accounts.service';

/**
 * Creating and rotating each cost one argon2id hash — tens of milliseconds of
 * memory-hard work — so the two mutating routes are held well below the blanket
 * limit. Twenty a minute is far more accounts than any tenant provisions by
 * hand, and it fails open: this is a capacity control, not a credential-guessing
 * one, and the caller is already authenticated and already authorized.
 */
const MINTING_RATE_LIMIT = { limit: 20, windowSeconds: 60 } as const;

/** Reads and status changes are cheap; this is the ordinary admin-surface bound. */
const ADMIN_RATE_LIMIT = { limit: 60, windowSeconds: 60 } as const;

@Controller(`${IAM_ROUTE_PREFIX}/service-accounts`)
export class ServiceAccountsController {
  constructor(private readonly accounts: ServiceAccountsService) {}

  /** Creates an account. The response carries the secret; nothing else ever will. */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RateLimit(MINTING_RATE_LIMIT)
  create(
    @Req() request: Request,
    @Body() body: CreateServiceAccountDto,
  ): Promise<ServiceAccountSecretDTO> {
    return this.accounts.create(claimsOf(request), { name: body.name });
  }

  @Get()
  @RateLimit(ADMIN_RATE_LIMIT)
  list(
    @Req() request: Request,
    @Query() query: PaginationDto,
  ): Promise<Paginated<ServiceAccountDTO>> {
    return this.accounts.list(claimsOf(request), query);
  }

  /**
   * Issues a new secret and invalidates the old one immediately.
   *
   * A 404 for an id that is not the caller's — including one from another
   * tenant, which RLS makes invisible rather than forbidden — so the response
   * cannot be used to discover that an account exists elsewhere (Doc 06 §2).
   */
  @Post(':id/rotate')
  @HttpCode(HttpStatus.OK)
  @RateLimit(MINTING_RATE_LIMIT)
  async rotate(
    @Req() request: Request,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ): Promise<ServiceAccountSecretDTO> {
    const rotated = await this.accounts.rotate(claimsOf(request), id);
    if (rotated === null) throw IamException.notFound('The service account');
    return rotated;
  }

  /** Revokes or reactivates. Idempotent — the same status twice is one event. */
  @Patch(':id')
  @RateLimit(ADMIN_RATE_LIMIT)
  async update(
    @Req() request: Request,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() body: UpdateServiceAccountDto,
  ): Promise<ServiceAccountDTO> {
    const updated = await this.accounts.setStatus(claimsOf(request), id, body.status);
    if (updated === null) throw IamException.notFound('The service account');
    return updated;
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
