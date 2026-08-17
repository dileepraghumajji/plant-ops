/**
 * `/iam/applications` — the platform application registry (Doc 06 §4).
 *
 * One controller for the whole of Doc 02 §2's registration sequence, because
 * that is what it is: create the application, seed its permissions, build its
 * nav tree, map the two together. Every route below the first is a sub-resource
 * of an application id, so splitting them across controllers would only spread
 * one prefix over four files.
 *
 * ## What is not here
 *
 * - **`DELETE /iam/applications/:id`.** Doc 02 §7 retires an application with
 *   `is_active = false`; see `applications.service.ts` for why a delete would
 *   cascade away data that role mappings and audit rows still refer to.
 * - **`GET /iam/applications/:id`.** Not in Doc 06 §4, and it would return
 *   exactly what the list does.
 *
 * ## Authorization
 *
 * Every route is authenticated by the app-wide `AuthGuard` and then authorized
 * by `PermissionGuard` from its own `@RequirePermission('iam.platform.…')`
 * (Doc 04 §8). None of them names a scope node, so none runs the coverage step:
 * platform authority is a binding at the platform scope root, outside every
 * customer tree, and Doc 04 §10 has it skip tenant coverage.
 *
 * ## No handler takes claims
 *
 * Nothing on this surface is tenant-scoped. Catalog rows carry no `client_id`
 * (Doc 07 §6), the authorization question is answered from the derived RLS
 * context rather than from the token, and `iam.write_audit` takes its actor from
 * that same context (Doc 10 §3). A `@Claims()` parameter here would be an unused
 * argument that looked like a tenant check.
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
  Query,
} from '@nestjs/common';
import { RequirePermission } from '@plantops/auth-kit';
import {
  IAM_ROUTE_PREFIX,
  type ApplicationDTO,
  type ManifestUpsertResponse,
  type NavCatalogResponse,
  type NavNodeCatalogDTO,
  type NavPermissionsResult,
  type Paginated,
  type PermissionDTO,
} from '@plantops/contracts';
import { IAM_PLATFORM_PERMISSIONS as P } from '../authz/iam-permissions';
import { IamException } from '../common/iam.exception';
import { RateLimit } from '../common/rate-limit.decorator';
import { ApplicationsService } from './applications.service';
import {
  CreateApplicationDto,
  PaginationDto,
  UpdateApplicationDto,
} from './dto/applications.dto';
import { ApplicationManifestDto } from './dto/manifest.dto';
import { CreateNavNodesDto, NavPermissionsDto } from './dto/nav.dto';
import { CreatePermissionsDto } from './dto/permissions.dto';
import { ManifestService } from './manifest.service';
import { NavService } from './nav.service';
import { PermissionsService } from './permissions.service';

/**
 * The ordinary admin-surface bound, matching `/iam/service-accounts`.
 *
 * Catalog writes are rare and cheap — no argon2, no key generation — so nothing
 * here needs the tighter minting limit that surface applies. The limit exists to
 * bound a bulk body being replayed, not to slow an attacker: the caller is
 * already a platform admin, and a platform admin who wants to damage the catalog
 * does not need to do it quickly.
 */
const REGISTRY_RATE_LIMIT = { limit: 60, windowSeconds: 60 } as const;

/** Parses `:id`, refusing anything that is not a v4 uuid before any query runs. */
const applicationId = () => new ParseUUIDPipe({ version: '4' });

@Controller(`${IAM_ROUTE_PREFIX}/applications`)
export class ApplicationsController {
  constructor(
    private readonly applications: ApplicationsService,
    private readonly permissions: PermissionsService,
    private readonly nav: NavService,
    private readonly manifest: ManifestService,
  ) {}

  // ── the application itself (Doc 02 §2 step 1) ─────────────────────────────

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RateLimit(REGISTRY_RATE_LIMIT)
  @RequirePermission(P.APP_CREATE)
  create(@Body() body: CreateApplicationDto): Promise<ApplicationDTO> {
    return this.applications.create(body);
  }

  @Get()
  @RateLimit(REGISTRY_RATE_LIMIT)
  @RequirePermission(P.APP_READ)
  list(@Query() query: PaginationDto): Promise<Paginated<ApplicationDTO>> {
    return this.applications.list(query);
  }

  /** Update, or the global on/off switch of Doc 02 §7. */
  @Patch(':id')
  @RateLimit(REGISTRY_RATE_LIMIT)
  @RequirePermission(P.APP_UPDATE)
  async update(
    @Param('id', applicationId()) id: string,
    @Body() body: UpdateApplicationDto,
  ): Promise<ApplicationDTO> {
    const updated = await this.applications.update(id, body);
    if (updated === null) throw IamException.notFound('The application');
    return updated;
  }

  // ── permissions (Doc 02 §2 step 2) ────────────────────────────────────────

  @Post(':id/permissions')
  @HttpCode(HttpStatus.CREATED)
  @RateLimit(REGISTRY_RATE_LIMIT)
  @RequirePermission(P.PERMISSION_CREATE)
  addPermissions(
    @Param('id', applicationId()) id: string,
    @Body() body: CreatePermissionsDto,
  ): Promise<PermissionDTO[]> {
    return this.permissions.add(id, body.permissions);
  }

  @Get(':id/permissions')
  @RateLimit(REGISTRY_RATE_LIMIT)
  @RequirePermission(P.PERMISSION_READ)
  listPermissions(
    @Param('id', applicationId()) id: string,
    @Query() query: PaginationDto,
  ): Promise<Paginated<PermissionDTO>> {
    return this.permissions.list(id, query);
  }

  // ── navigation (Doc 02 §2 steps 3–4) ──────────────────────────────────────

  @Post(':id/nav')
  @HttpCode(HttpStatus.CREATED)
  @RateLimit(REGISTRY_RATE_LIMIT)
  @RequirePermission(P.NAV_CREATE)
  addNavNodes(
    @Param('id', applicationId()) id: string,
    @Body() body: CreateNavNodesDto,
  ): Promise<NavNodeCatalogDTO[]> {
    return this.nav.add(id, body.nodes);
  }

  @Get(':id/nav')
  @RateLimit(REGISTRY_RATE_LIMIT)
  @RequirePermission(P.NAV_READ)
  navTree(@Param('id', applicationId()) id: string): Promise<NavCatalogResponse> {
    return this.nav.tree(id);
  }

  /**
   * Maps permissions onto nav nodes.
   *
   * A 200 rather than a 201: idempotent, and the interesting part of the answer
   * is how much actually changed, not a location. `NavPermissionsResult` carries
   * that.
   */
  @Post(':id/nav-permissions')
  @HttpCode(HttpStatus.OK)
  @RateLimit(REGISTRY_RATE_LIMIT)
  @RequirePermission(P.NAV_MAP)
  mapNavPermissions(
    @Param('id', applicationId()) id: string,
    @Body() body: NavPermissionsDto,
  ): Promise<NavPermissionsResult> {
    return this.nav.map(id, body.mappings);
  }

  /**
   * Removes mappings. Takes the same body as the POST — see `nav.service.ts`
   * for why this route exists although Doc 06 §4's table stops at the POST.
   */
  @Delete(':id/nav-permissions')
  @HttpCode(HttpStatus.OK)
  @RateLimit(REGISTRY_RATE_LIMIT)
  @RequirePermission(P.NAV_MAP)
  unmapNavPermissions(
    @Param('id', applicationId()) id: string,
    @Body() body: NavPermissionsDto,
  ): Promise<NavPermissionsResult> {
    return this.nav.unmap(id, body.mappings);
  }

  // ── the whole of the above, declaratively (Doc 02 §2) ─────────────────────

  /**
   * Upserts an application's permission and nav catalog from its manifest.
   *
   * A 200, not a 201. The four routes above each create something and say so;
   * this one is idempotent by definition — the same document uploaded twice
   * creates nothing the second time — and there is no single resource a
   * `Location` could point at. What the caller wants back is what moved, which
   * is `ManifestUpsertResponse.diff`.
   *
   * The body is the manifest itself rather than `{ manifest: … }`: it is a file
   * an application ships, and a wrapper would mean the file on disk and the body
   * on the wire are two different documents (`tools/upload-manifest.ts` posts
   * the file unchanged, which is the point).
   */
  @Post(':id/manifest')
  @HttpCode(HttpStatus.OK)
  @RateLimit(REGISTRY_RATE_LIMIT)
  @RequirePermission(P.APP_MANIFEST)
  upsertManifest(
    @Param('id', applicationId()) id: string,
    @Body() body: ApplicationManifestDto,
  ): Promise<ManifestUpsertResponse> {
    return this.manifest.upsert(id, body);
  }
}
