/**
 * What kind of deployment this is (roadmap Session 44, Doc 11 §6.5).
 *
 * One unauthenticated GET, and it exists for one caller: the login screen.
 *
 * The console is origin-agnostic by design (Session 40) — one build, no
 * hostname, no per-deployment value baked in — so it cannot know at build time
 * whether the person in front of it should be asked for an organisation. It has
 * to ask, and it has to ask *before* anyone has a credential, which is what
 * makes this public.
 *
 * ## Why publishing it is not a leak
 *
 * `mode` is a property of the deployment that a single request already reveals:
 * a login form with no organisation field is the same fact, and so is a
 * `client_slug` that is refused. In `saas` mode the tenant fields are null and
 * nothing is disclosed at all.
 *
 * In `single_tenant` mode the slug and name belong to the one organisation the
 * installation serves — on their own hostname, in front of their own login
 * page. Withholding their own name from their own sign-in screen would buy
 * obscurity from nobody and cost the page the one thing that makes it
 * recognisably theirs.
 *
 * ## What it is not
 *
 * Not a permission boundary, not authentication, and not a source of authority.
 * Nothing downstream trusts what this returns: the tenant a request operates in
 * still comes from verified claims (`libs/db/src/rls-context.ts`), and hiding
 * platform routes in the console on the strength of this is UX (Doc 09 §4) — the
 * API refuses them on permissions either way.
 */

import { Controller, Get } from '@nestjs/common';
import { Public } from '@plantops/auth-kit';
import type { DeploymentMode } from '@plantops/config';
import { SkipTransaction } from '../common/transaction-context';
import { DeploymentModeService } from './deployment-mode';

/** The shape the login screen branches on. */
export interface DeploymentDescription {
  mode: DeploymentMode;
  /** The pinned tenant's slug, or `null` in `saas` mode. */
  client_slug: string | null;
  /** The pinned tenant's display name, or `null` in `saas` mode. */
  client_name: string | null;
}

@Controller('iam/deployment')
@Public()
@SkipTransaction()
export class DeploymentController {
  constructor(private readonly deployment: DeploymentModeService) {}

  @Get()
  describe(): DeploymentDescription {
    const client = this.deployment.client;
    return {
      mode: this.deployment.mode,
      client_slug: client?.slug ?? null,
      client_name: client?.name ?? null,
    };
  }
}
