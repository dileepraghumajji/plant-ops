/**
 * `GET /iam/navigation` — the menu the caller may see (Doc 05 §4, Doc 06 §11).
 *
 * ## One route, two requests
 *
 * With `?applicationId=` it answers one application's pruned tree; without it,
 * the cross-application shell — "top-level a node per enabled application, each
 * expandable — for a unified shell" (Doc 05 §4). One route rather than two
 * because they answer the same question at two zoom levels and return the same
 * type; `NavigationResponse.application` says which was asked, being the
 * application for the first and `null` for the second.
 *
 * ## There is no permission on it, and there must not be
 *
 * `require-permission.decorator.ts` names this route among the handful that
 * legitimately opt out: "endpoints that answer a question **about the bearer
 * themselves** — their own sessions, their own grants, their own navigation. A
 * subject needs no permission to be told what they can do, and inventing one
 * would mean a subject with no grants could not discover that they have no
 * grants."
 *
 * Nothing is given away by that. The response is a function of the caller's own
 * resolved grants: a subject who holds nothing gets `tree: []`, and every node
 * they do see is one they were granted the permission for. The deny-by-default of
 * Doc 05 §3 rule 1 is what makes the endpoint safe to leave ungated — an unmapped
 * menu is hidden, so a catalog misconfiguration cannot turn this into a listing
 * of screens the caller may not reach.
 *
 * `@NoPermissionRequired` is class-level and carries its reason, which is the
 * whole point of that decorator over a bare marker: the guard denies a route
 * that declares nothing, so the exemption has to be a sentence somebody wrote
 * rather than a decorator somebody forgot.
 *
 * ## Why it sits in its own controller rather than beside the resolve endpoints
 *
 * `AuthzController` answers with grants; this answers with a *catalog projection*
 * of them, and it needs `NavigationService` — which needs the nav-catalog cache
 * that `registry`'s writers bump. Folding it into `authz/` would make the
 * authorization core depend on the navigation cache, and `authz.module.ts` is the
 * one module in this application that imports nothing above itself.
 *
 * ## Rate limiting
 *
 * The resolution surface's bound (Doc 06 §11), not the admin surface's. This is
 * called by a shell on entry into an application and by every deep link that
 * re-renders the sidebar, and Doc 05 §7 has the console render the answer
 * directly rather than caching menu constants — so the caller is a browser or a
 * module process, not an operator driving a form.
 */

import { Controller, Get, Query } from '@nestjs/common';
import { NoPermissionRequired } from '@plantops/auth-kit';
import { IAM_ROUTE_PREFIX, type NavigationResponse } from '@plantops/contracts';
import type { VerifiedClaims } from '@plantops/db';
import { subjectRefOf } from '../authz/resolver.service';
import { Claims } from '../common/claims.decorator';
import { RateLimit } from '../common/rate-limit.decorator';
import { entityManager } from '../common/transaction-context';
import { NavigationQueryDto } from './dto/navigation.dto';
import { NavigationService } from './navigation.service';

/** Matching the resolution endpoints', for the reason in the header. */
const NAVIGATION_RATE_LIMIT = { limit: 600, windowSeconds: 60 } as const;

@Controller(IAM_ROUTE_PREFIX)
@NoPermissionRequired(
  'The menu is a projection of the bearer’s own grants (Doc 05 §3). Gating it ' +
    'would require a permission in order to discover which screens one’s ' +
    'permissions open, and a subject holding nothing would be unable to learn ' +
    'that their menu is empty. Deny-by-default pruning is what keeps it safe: ' +
    'an unmapped node is hidden, never public.',
)
export class NavigationController {
  constructor(private readonly navigation: NavigationService) {}

  /**
   * The caller's menu (Doc 05 §4).
   *
   * `entityManager()` — the request transaction — is passed explicitly, for the
   * reason `authz.controller.ts` gives: the resolver takes its executor as a
   * parameter (`docs/adr/0001-permission-guard-connection-strategy.md`) rather
   * than reaching for the ambient one, so that `PermissionGuard` can call it
   * before a request transaction exists. Inside a request that changes nothing.
   *
   * An `applicationId` naming something the caller may not see is an empty tree
   * rather than a 404 — see `navigation.service.ts` for why this route must not
   * become an existence oracle over the platform catalog.
   */
  @Get('navigation')
  @RateLimit(NAVIGATION_RATE_LIMIT)
  tree(
    @Claims() claims: VerifiedClaims,
    @Query() query: NavigationQueryDto,
  ): Promise<NavigationResponse> {
    return this.navigation.navigationFor(
      entityManager(),
      subjectRefOf(claims),
      query.applicationId,
    );
  }
}
