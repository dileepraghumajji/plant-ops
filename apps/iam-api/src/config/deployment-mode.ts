/**
 * How many tenants this process serves, and which one (roadmap Session 44,
 * Doc 11 §6.5, §8 gap 4).
 *
 * ## What single-tenant mode is, and what it is not
 *
 * A dedicated or self-hosted installation serves exactly one client. Its users
 * type an email and a password; the tenant is not theirs to choose, and asking
 * them for a slug they will type identically every time is a field that exists
 * only to be got wrong.
 *
 * Nothing beneath that changes, and the "nothing" is the point. The slug is
 * still the tenant half of the credential (Doc 03 §3). It is still resolved to
 * a client row. `app.current_client_id` is still set per request from verified
 * claims, `force row level security` still applies, and `rls-isolation.e2e.ts`
 * still passes unmodified. The single difference is **who supplies the slug**:
 * the deployment, from configuration, at boot — instead of the browser, per
 * request.
 *
 * That is why this file resolves a client *id* rather than trusting a name at
 * request time, and why `single-tenant.middleware.ts` refuses a request whose
 * `client_slug` disagrees with the pinned one instead of quietly overwriting
 * it. Doc 11 §3 is explicit that a second code path is a path nobody tests; the
 * design here adds no authorization path at all, it removes one input.
 *
 * ## Resolved at boot, loudly
 *
 * `onModuleInit` looks the slug up and refuses to start if it names nothing.
 * The alternative — resolve lazily, on the first login — is a deployment that
 * comes up healthy, passes its readiness probe, and answers 401 to every user
 * for a reason visible nowhere.
 *
 * The lookup goes through `iam.deployment_lookup_client` (migration 0018),
 * a `security definer` function, because at boot there is no RLS context and
 * `client` reads as empty without one. See that migration for why it is a
 * function rather than an elevation performed here.
 */

import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import type { DeploymentMode, EnvConfig } from '@plantops/config';
import { IAM_SCHEMA } from '@plantops/db';
import { DatabaseService } from '../database/database.service';
import { ENV } from './env.token';

/**
 * A misconfigured deployment mode, reported at boot.
 *
 * Its own type so `main.ts` can print the operator's problem instead of a
 * stack through Nest's module initializer — the same treatment
 * `RlsStartupCheckError` and `KeyConfigurationError` get, and for the same
 * reason: nobody debugging this needs to know which lifecycle hook it happened
 * in.
 */
export class DeploymentModeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DeploymentModeError';
  }
}

/** The pinned tenant of a `single_tenant` deployment. */
export interface PinnedClient {
  id: string;
  slug: string;
  name: string;
}

interface LookupRow {
  client_id: string;
  client_name: string;
  client_status: string;
}

@Injectable()
export class DeploymentModeService implements OnApplicationBootstrap {
  private readonly logger = new Logger(DeploymentModeService.name);
  private pinned: PinnedClient | undefined;

  constructor(
    @Inject(ENV) private readonly env: EnvConfig,
    private readonly database: DatabaseService,
  ) {}

  get mode(): DeploymentMode {
    return this.env.DEPLOYMENT_MODE;
  }

  get isSingleTenant(): boolean {
    return this.env.DEPLOYMENT_MODE === 'single_tenant';
  }

  /**
   * The pinned tenant, or `undefined` in `saas` mode.
   *
   * Reading this before `onModuleInit` has run is a programming error rather
   * than a state to handle: Nest initializes providers before the HTTP server
   * listens, so nothing that serves a request can observe the unresolved case.
   */
  get client(): PinnedClient | undefined {
    return this.pinned;
  }

  /**
   * `onApplicationBootstrap`, not `onModuleInit`, and the difference is not
   * cosmetic.
   *
   * Nest runs `onModuleInit` module by module in registration order, and
   * `ConfigModule` is `@Global()` and registered first — so at that point
   * `DatabaseService` has not opened its pool and the lookup fails with
   * "Driver not Connected". `onApplicationBootstrap` runs after every module's
   * init and still before the HTTP server accepts a connection, which is
   * exactly the window this check wants: everything it needs is up, and nothing
   * can have been served yet.
   */
  async onApplicationBootstrap(): Promise<void> {
    if (!this.isSingleTenant) return;

    // Non-null by construction: `envSchema` refuses `single_tenant` without it.
    const slug = this.env.SINGLE_TENANT_CLIENT_SLUG as string;

    let rows: LookupRow[];
    try {
      rows = (await this.database.dataSource.query(
        `select client_id, client_name, client_status
           from "${IAM_SCHEMA}".deployment_lookup_client($1)`,
        [slug],
      )) as LookupRow[];
    } catch (cause) {
      throw new DeploymentModeError(
        `DEPLOYMENT_MODE=single_tenant, but the pinned client could not be looked ` +
          `up: ${cause instanceof Error ? cause.message : String(cause)}\n\n` +
          'If the message names a missing function, this database has not had ' +
          'migration 0018 applied — migrations run before the application starts ' +
          '(docs/ops-runbook.md §3, deploy/README.md §5).',
      );
    }

    const found = rows[0];
    if (found === undefined) {
      throw new DeploymentModeError(
        `DEPLOYMENT_MODE=single_tenant names SINGLE_TENANT_CLIENT_SLUG="${slug}", ` +
          'but no client with that slug exists in this database.\n\n' +
          'On a new installation the client is created by the installer ' +
          '(deploy/bootstrap.sh) — check that PLANTOPS_CLIENT_SLUG in .env and ' +
          'SINGLE_TENANT_CLIENT_SLUG name the same tenant. Starting anyway would ' +
          'mean every login answers 401 for a reason visible nowhere.',
      );
    }

    // A suspended tenant is a decision somebody made, and it is not this
    // check's business to override it — every login will be refused by the
    // login path itself, with the reason. Starting is right; starting
    // *silently* is not.
    if (found.client_status !== 'active') {
      this.logger.warn(
        `The pinned client "${slug}" is ${found.client_status}. Every login to ` +
          'this deployment will be refused until it is active again.',
      );
    }

    this.pinned = { id: found.client_id, slug, name: found.client_name };
    this.logger.log(
      `Single-tenant deployment pinned to "${found.client_name}" (${slug}).`,
    );
  }
}
