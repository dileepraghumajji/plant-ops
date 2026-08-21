/**
 * `/iam/clients` — tenant provisioning (Doc 06 §5).
 *
 * One controller for the whole of Doc 02 §3's sequence, for the reason
 * `applications.controller.ts` gives about Doc 02 §2: create the tenant, enable
 * its applications, seed its first administrator. Every route below the first is
 * a sub-resource of a client id, so splitting them would spread one prefix over
 * three files.
 *
 * ## What is not here
 *
 * - **`DELETE /iam/clients/:id`.** Doc 01 §3.4 suspends tenants and never
 *   deletes them; `PATCH` with `status = 'suspended'` is the off switch. See
 *   `clients.service.ts`.
 * - **`DELETE /iam/clients/:id/applications/:appId`.** Doc 02 §7 disables with
 *   `enabled = false` so that mappings survive; `PATCH` is the toggle.
 * - **`GET /iam/clients/:id`.** Not in Doc 06 §5, and it would return exactly
 *   what the list does.
 *
 * ## Authorization
 *
 * Every route is authenticated by the app-wide `AuthGuard` and then authorized
 * by `PermissionGuard` from its own `@RequirePermission('iam.platform.…')`
 * (Doc 04 §8). None of them names a scope node, so none runs the coverage step:
 * platform authority is a binding at the platform scope root, outside every
 * customer tree, and Doc 04 §10 has it skip tenant coverage.
 *
 * The `:id` in the path is a *target*, not an authority: what may be done with
 * it is decided by a permission held at the platform root, never by the token's
 * `cid`.
 *
 * ## No handler takes claims
 *
 * These routes are *about* tenants without being *scoped to* one. The tenant is
 * the `:id` path segment, which is a target rather than an authority: what the
 * caller may do with it is decided by the derived platform flag in the RLS
 * context, never by the token's `cid`. A `@Claims()` parameter here would be an
 * unused argument that looked like a tenant check.
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
import { RequirePermission } from '@plantops/auth-kit';
import {
  IAM_ROUTE_PREFIX,
  type ClientAdminDTO,
  type ClientApplicationDTO,
  type ClientDTO,
  type Paginated,
} from '@plantops/contracts';
import { IAM_PLATFORM_PERMISSIONS as P } from '../authz/iam-permissions';
import { IamException } from '../common/iam.exception';
import { RateLimit } from '../common/rate-limit.decorator';
import { DeploymentModeService } from '../config/deployment-mode';
import { ClientAdminService } from './client-admin.service';
import { ClientApplicationsService } from './client-applications.service';
import { ClientsService } from './clients.service';
import {
  CreateClientAdminDto,
  CreateClientDto,
  EnableApplicationsDto,
  PaginationDto,
  UpdateClientApplicationDto,
  UpdateClientDto,
} from './dto/clients.dto';

/**
 * The ordinary admin-surface bound, matching `/iam/applications`.
 *
 * `POST /iam/clients/:id/admins` is the one route here that does argon2id work,
 * and it is bounded by the same limit rather than a tighter one: it is
 * authenticated, platform-only, and hashes exactly once per call — nothing like
 * the unauthenticated login path that needs its own fail-closed budget.
 */
const CLIENTS_RATE_LIMIT = { limit: 60, windowSeconds: 60 } as const;

/** Parses a uuid path segment, refusing anything else before any query runs. */
const uuidParam = () => new ParseUUIDPipe({ version: '4' });

@Controller(`${IAM_ROUTE_PREFIX}/clients`)
export class ClientsController {
  constructor(
    private readonly clients: ClientsService,
    private readonly applications: ClientApplicationsService,
    private readonly admins: ClientAdminService,
    private readonly deployment: DeploymentModeService,
  ) {}

  // ── the tenant itself (Doc 02 §3 step 1) ──────────────────────────────────

  /**
   * In a single-tenant deployment, only the organisation this deployment is for
   * — and the reason is coherence rather than licensing (Doc 11 §6.5).
   *
   * The process serves one client, named in configuration. Any *other* client
   * row would be a tenant no request this process serves can ever reach:
   * nothing would log in to it, nothing would resolve to it, and it would sit
   * in the database accumulating the appearance of being real.
   *
   * The pinned one is allowed through, and that is not a loophole — it is the
   * call the installer makes. A single-tenant installation creates its
   * organisation the same way every other organisation in this system is
   * created, through this endpoint, with the platform credential; there is no
   * second path that writes a `client` row. A repeat attempt meets the ordinary
   * unique-slug 409 from the database, as it always did.
   *
   * The permission check still runs first and still means what it always did.
   * This is a mode the deployment is in, not an authorization decision, and
   * mixing the two would make a 403 and this 409 indistinguishable to whoever
   * has to act on them.
   */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RateLimit(CLIENTS_RATE_LIMIT)
  @RequirePermission(P.CLIENT_CREATE)
  create(@Body() body: CreateClientDto): Promise<ClientDTO> {
    const pinned = this.deployment.pinnedSlug;
    if (pinned !== undefined && body.slug !== pinned) {
      throw IamException.conflict(
        `This deployment serves a single organisation ("${pinned}") and cannot ` +
          `hold another. A client with the slug "${body.slug}" would be ` +
          'unreachable by every request this process serves.',
      );
    }
    return this.clients.create(body);
  }

  @Get()
  @RateLimit(CLIENTS_RATE_LIMIT)
  @RequirePermission(P.CLIENT_READ)
  list(@Query() query: PaginationDto): Promise<Paginated<ClientDTO>> {
    return this.clients.list(query);
  }

  /** Update, or the suspend / reactivate switch of Doc 06 §5. */
  @Patch(':id')
  @RateLimit(CLIENTS_RATE_LIMIT)
  @RequirePermission(P.CLIENT_UPDATE)
  async update(
    @Param('id', uuidParam()) id: string,
    @Body() body: UpdateClientDto,
  ): Promise<ClientDTO> {
    const updated = await this.clients.update(id, body);
    if (updated === null) throw IamException.notFound('The client');
    return updated;
  }

  // ── application enablement (Doc 02 §3 step 2) ─────────────────────────────

  @Post(':id/applications')
  @HttpCode(HttpStatus.CREATED)
  @RateLimit(CLIENTS_RATE_LIMIT)
  @RequirePermission(P.CLIENT_APP_ENABLE)
  enableApplications(
    @Param('id', uuidParam()) id: string,
    @Body() body: EnableApplicationsDto,
  ): Promise<ClientApplicationDTO[]> {
    return this.applications.enable(id, body.applications);
  }

  /** Beyond Doc 06 §5's table — see `client-applications.service.ts`. */
  @Get(':id/applications')
  @RateLimit(CLIENTS_RATE_LIMIT)
  @RequirePermission(P.CLIENT_APP_READ)
  listApplications(@Param('id', uuidParam()) id: string): Promise<ClientApplicationDTO[]> {
    return this.applications.list(id);
  }

  @Patch(':id/applications/:appId')
  @RateLimit(CLIENTS_RATE_LIMIT)
  @RequirePermission(P.CLIENT_APP_UPDATE)
  async updateApplication(
    @Param('id', uuidParam()) id: string,
    @Param('appId', uuidParam()) applicationId: string,
    @Body() body: UpdateClientApplicationDto,
  ): Promise<ClientApplicationDTO> {
    const updated = await this.applications.update(id, applicationId, body);
    // The client exists — the service 404s otherwise — so this is specifically
    // "that application is not enabled for this client". `POST` is how it
    // becomes enabled; a PATCH that silently created the row would make the
    // toggle able to grant, which is not what a toggle is.
    if (updated === null) {
      throw IamException.notFound('The application, for this client,');
    }
    return updated;
  }

  // ── the first administrator (Doc 02 §3 step 3) ────────────────────────────

  @Post(':id/admins')
  @HttpCode(HttpStatus.CREATED)
  @RateLimit(CLIENTS_RATE_LIMIT)
  @RequirePermission(P.CLIENT_ADMIN_CREATE)
  createAdmin(
    @Param('id', uuidParam()) id: string,
    @Body() body: CreateClientAdminDto,
  ): Promise<ClientAdminDTO> {
    return this.admins.create(id, body);
  }
}
