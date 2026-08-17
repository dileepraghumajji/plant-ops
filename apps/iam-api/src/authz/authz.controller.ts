/**
 * The resolution endpoints — the contract every future PlantOps module depends
 * on (Doc 06 §11).
 *
 * Unlike every other controller in this application, nothing here is an
 * administrative surface. There is no `@RequirePermission(...)` and there will
 * not be one: the three routes below answer questions *about the bearer*, so
 * holding the token is the whole of the authorization. A permission gate on
 * "what may I do" would need a permission to find out whether you have any
 * permissions.
 *
 * That is also why these are the only routes `PermissionGuard` must never gate —
 * it would call this same resolver to decide, and the recursion is not
 * hypothetical. The class-level `@NoPermissionRequired()` below is how that is
 * stated to the guard, which otherwise denies a route that declares nothing
 * (`require-permission.decorator.ts`).
 *
 * ## Three routes and three shapes
 *
 * - `GET /permissions/resolve` returns the whole grant set, unpaginated, because
 *   it is a single cacheable unit (Doc 06 §11) — see `dto/authz.dto.ts`.
 * - `POST /permissions/check` is a `POST` for a read, so the permission being
 *   tested stays out of access logs and proxy caches.
 * - `POST /introspect` is the token endpoint of the three, and the only one whose
 *   subject is not the caller.
 *
 * The two `POST`s answer `200`, not `201`: neither creates anything, and a
 * `check` that answered `201` would be reporting the creation of an opinion.
 *
 * ## No `@Transactional`
 *
 * Nothing here writes, and nothing needs an isolation level above the default.
 * A resolve that races a scope move is Doc 04 §7.1's *reader*, and the ordering
 * that protects it lives in the move (rewrite, commit, then invalidate) rather
 * than in a stricter snapshot here — a `REPEATABLE READ` reader would still be
 * reading whichever side of the move it started before, and would additionally
 * be able to fail with a serialization error on a question that has no write
 * to retry.
 *
 * ## Rate limiting is looser here than anywhere else
 *
 * Sixty a minute is right for a surface an operator drives from a screen. These
 * are called by *processes*: Doc 06 §11 has a module resolve once per subject
 * and cache the result, and a fleet behind one service-account credential shares
 * a single `sub` bucket (`common/throttler.guard.ts`). The bound is therefore
 * per-process capacity protection rather than a security control, and it fails
 * open with the blanket default.
 */

import { Body, Controller, Get, HttpCode, HttpStatus, Post, Query } from '@nestjs/common';
import { NoPermissionRequired } from '@plantops/auth-kit';
import {
  IAM_ROUTE_PREFIX,
  type IntrospectResponse,
  type PermissionCheckResponse,
  type ResolvedGrants,
} from '@plantops/contracts';
import type { VerifiedClaims } from '@plantops/db';
import { Claims } from '../common/claims.decorator';
import { RateLimit } from '../common/rate-limit.decorator';
import { entityManager } from '../common/transaction-context';
import { IntrospectDto, PermissionCheckDto, ResolveQueryDto } from './dto/authz.dto';
import { IntrospectService } from './introspect.service';
import { ResolverService, type SubjectRef } from './resolver.service';

/** Ten a second sustained — a machine's budget, not an operator's. */
const RESOLUTION_RATE_LIMIT = { limit: 600, windowSeconds: 60 } as const;

/**
 * The bearer, as the resolver names subjects.
 *
 * Built from the verified claims only. The three fields are `cid`, `sty` and
 * `sub`, and there is no path by which a request body could contribute to any
 * of them — which is the same guarantee `applyRlsContext` makes about the RLS
 * context these queries run under (Doc 07 §5).
 */
function subjectOf(claims: VerifiedClaims): SubjectRef {
  return { clientId: claims.cid, type: claims.sty, id: claims.sub };
}

@Controller(IAM_ROUTE_PREFIX)
@NoPermissionRequired(
  'These three answer questions about the bearer themselves (Doc 06 §11). ' +
    'Gating them would require a permission in order to discover which ' +
    'permissions one holds, and the guard resolves through this very service.',
)
export class AuthzController {
  constructor(
    private readonly resolver: ResolverService,
    private readonly introspection: IntrospectService,
  ) {}

  /**
   * The bearer's complete grant set, minimized and cached (Doc 04 §4.1, §6).
   *
   * `entityManager()` — the request transaction — is passed explicitly, because
   * `resolve()` deliberately does not reach for it
   * (`docs/adr/0001-permission-guard-connection-strategy.md`). Inside a request
   * that changes nothing: the query runs on the same transaction and under the
   * same RLS context it would have found ambiently.
   */
  @Get('permissions/resolve')
  @RateLimit(RESOLUTION_RATE_LIMIT)
  resolve(
    @Claims() claims: VerifiedClaims,
    @Query() query: ResolveQueryDto,
  ): Promise<ResolvedGrants> {
    return this.resolver.grantsFor(entityManager(), subjectOf(claims), {
      applicationId: query.applicationId,
    });
  }

  /**
   * One permission at one node (Doc 04 §4.2).
   *
   * Always a `200` with a boolean, never a `403`: this endpoint *reports* an
   * authorization decision rather than enforcing one, and a caller asking
   * "may I" has not yet done anything to be refused for. A node that is not the
   * caller's tenant's answers `false` for the same reason it is not a 404 — see
   * `ResolverService.check`.
   */
  @Post('permissions/check')
  @HttpCode(HttpStatus.OK)
  @RateLimit(RESOLUTION_RATE_LIMIT)
  async check(
    @Claims() claims: VerifiedClaims,
    @Body() body: PermissionCheckDto,
  ): Promise<PermissionCheckResponse> {
    const allowed = await this.resolver.check(
      entityManager(),
      subjectOf(claims),
      body.permission,
      body.scopeNodeId,
    );

    return { allowed };
  }

  /**
   * Verifies a token on the caller's behalf (Doc 06 §11).
   *
   * The caller's own claims are not used: the subject of this call is the token
   * in the body, and the bearer's only role is to be authenticated at all. See
   * `introspect.service.ts` for why the two are not required to belong to the
   * same tenant.
   */
  @Post('introspect')
  @HttpCode(HttpStatus.OK)
  @RateLimit(RESOLUTION_RATE_LIMIT)
  introspect(@Body() body: IntrospectDto): Promise<IntrospectResponse> {
    return this.introspection.introspect(body.token);
  }
}
