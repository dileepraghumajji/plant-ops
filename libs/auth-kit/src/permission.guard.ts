/**
 * The guard that enforces `@RequirePermission` (Doc 04 §8, Doc 08 §4).
 *
 * `AuthGuard` establishes **who** is calling. This one establishes **whether
 * they may** — the WHO × WHAT × WHERE question of Doc 04 §1, asked once per
 * request, before the handler and before the transaction that would carry out
 * whatever it was going to do.
 *
 * Four steps, and each one is a line of Doc 04 §8's contract:
 *
 * 1. Read the route's requirement. No requirement and no explicit opt-out is a
 *    refusal — see {@link RequirePermission} for why the direction is that way
 *    round.
 * 2. Load the subject's resolved grants, through {@link GrantsSource}.
 * 3. Confirm the permission is held, and — where the route names a scope node —
 *    that the subject's grants cover it.
 * 4. Refuse with `PERMISSION_DENIED` or `SCOPE_DENIED`, and audit the attempt.
 *
 * Steps 2 and 3 are {@link ScopeResolver.decide}, which is where the rule lives
 * and where it is unit-tested. What is left here is the framework adapter: read
 * metadata, read the request, translate an outcome into an exception. That
 * split is deliberate — a guard is the one place a test has to build an
 * `ExecutionContext` to reach, and authorization logic should not be behind
 * that.
 *
 * ## Which connection step 2 runs on
 *
 * Not this file's decision, and deliberately not this file's problem.
 * `docs/adr/0001-permission-guard-connection-strategy.md` settles it: a guard
 * runs *before* the per-request transaction exists (Nest runs guards ahead of
 * interceptors), so on a grants-cache miss the IAM's {@link GrantsSource} opens
 * its own `QueryRunner`, applies the RLS context from the verified claims,
 * resolves on it, and commits and releases in a `finally`. It does **not** open,
 * reuse or leave open the request transaction: a guard has no "after" phase in
 * which to close one, so `TenantContextInterceptor` stays its sole owner.
 *
 * `auth-kit` may depend on `@plantops/contracts` and nothing else (Doc 08 §2),
 * so it could not name a `DataSource` here in any case — which is why the port
 * exists and why a future module can satisfy it with a cached HTTP call instead.
 *
 * ## Every denial is audited, and a failure to audit is not a failure to deny
 *
 * Doc 04 §8 step 5 and Doc 10 §3: the attempt is recorded with the permission
 * that was wanted and the target that was named. The IAM binds
 * {@link DENIAL_AUDITOR} to `AuditService.recordDenial`, which commits on its
 * own connection precisely because the request it accompanies is about to be
 * rolled back by its own 403 — and which never throws, because turning a lost
 * audit row into a 500 would tell a caller which requests were refused for which
 * reason.
 *
 * The auditor is optional: a downstream module has no `audit_trail` table and
 * records nothing. Binding it is the IAM's business.
 *
 * ## The two refusals say different things, and neither says whether the target
 * exists
 *
 * `PERMISSION_DENIED` means the subject does not hold it anywhere;
 * `SCOPE_DENIED` means they hold it, but not over the node they named. A node
 * belonging to another tenant produces `SCOPE_DENIED` too — indistinguishable
 * from one they simply do not cover, because RLS makes it so and Doc 06 §2
 * requires that a denial never reveal cross-tenant existence.
 */

import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  Optional,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { IamErrorCode, type PermissionKey } from '@plantops/contracts';
import { IS_PUBLIC_METADATA } from './auth.guard';
import {
  NO_PERMISSION_METADATA,
  REQUIRE_PERMISSION_METADATA,
  readScopeTarget,
  type PermissionRequirement,
} from './require-permission.decorator';
import {
  AuthorizationOutcome,
  ScopeResolver,
  type SubjectClaims,
} from './scope-resolver';

/** The two 403 codes of Doc 06 §2, and no others. */
export type DenialErrorCode =
  | typeof IamErrorCode.PERMISSION_DENIED
  | typeof IamErrorCode.SCOPE_DENIED;

/**
 * A 403 that knows which of Doc 06 §2's two codes it is.
 *
 * `ForbiddenException` alone would come back as `PERMISSION_DENIED`, because
 * that is the less specific of the two and the only one a bare status can imply
 * (`http-exception.filter.ts`). The distinction is worth carrying: a client that
 * sees `SCOPE_DENIED` can tell its user *where* they lack access, which is the
 * one actionable thing about a refusal.
 *
 * `IamErrorCode` is a `@plantops/contracts` export, so naming it here crosses no
 * boundary — the code table is part of the published contract, not of the IAM.
 */
export class AuthorizationDeniedException extends ForbiddenException {
  constructor(
    readonly code: DenialErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'AuthorizationDeniedException';
  }

  /** The subject does not hold the permission at all. */
  static permission(): AuthorizationDeniedException {
    return new AuthorizationDeniedException(
      IamErrorCode.PERMISSION_DENIED,
      'You do not have permission to perform this action',
    );
  }

  /** They hold it, but not over the node they named. */
  static scope(): AuthorizationDeniedException {
    return new AuthorizationDeniedException(
      IamErrorCode.SCOPE_DENIED,
      'You do not have permission at the requested scope',
    );
  }
}

/** How the guard reads back the claims `AuthGuard` verified. */
export interface VerifiedClaimsSource {
  claimsOf(request: unknown): SubjectClaims | undefined;
}

/** Records a refused attempt (Doc 10 §3). Must not throw. */
export interface DenialAuditor {
  recordDenial(
    claims: SubjectClaims,
    outcome: Exclude<AuthorizationOutcome, 'allowed'>,
    /**
     * The keys the refusal was about — one on all but the routes that admit
     * either tier's key, and never empty. `AuthorizationDecision` in
     * `scope-resolver.ts` says which keys a given outcome names.
     */
    permissions: readonly PermissionKey[],
    scopeNodeId?: string,
  ): Promise<void>;
}

export const VERIFIED_CLAIMS_SOURCE = Symbol('auth-kit:VerifiedClaimsSource');
export const DENIAL_AUDITOR = Symbol('auth-kit:DenialAuditor');

@Injectable()
export class PermissionGuard implements CanActivate {
  private readonly logger = new Logger(PermissionGuard.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly resolver: ScopeResolver,
    @Inject(VERIFIED_CLAIMS_SOURCE) private readonly claims: VerifiedClaimsSource,
    @Optional()
    @Inject(DENIAL_AUDITOR)
    private readonly auditor: DenialAuditor | null = null,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;

    const targets = [context.getHandler(), context.getClass()];

    // A `@Public()` route has no subject, so there are no grants to check. It
    // is also the one case where stepping aside cannot widen anything: the
    // request reaches the handler with no RLS context, and every tenant policy
    // matches nothing (`tenant-context.interceptor.ts`).
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_METADATA, targets)) {
      return true;
    }

    const requirement = this.reflector.getAllAndOverride<PermissionRequirement>(
      REQUIRE_PERMISSION_METADATA,
      targets,
    );

    if (requirement === undefined) {
      const exemption = this.reflector.getAllAndOverride<string>(
        NO_PERMISSION_METADATA,
        targets,
      );
      if (exemption !== undefined) return true;

      // Deny-by-default, and loudly. Reaching this is a wiring mistake rather
      // than a caller's, and it must not be silent: the alternative reading —
      // let an undeclared route through — is the one that produces a working,
      // ungated endpoint nobody notices (`require-permission.decorator.ts`).
      this.logger.error(
        `${context.getClass().name}.${context.getHandler().name} declares neither ` +
          '@RequirePermission() nor @NoPermissionRequired(); refusing the request',
      );
      throw AuthorizationDeniedException.permission();
    }

    const request = context.switchToHttp().getRequest<unknown>();
    const claims = this.claims.claimsOf(request);
    // Unreachable through `AuthGuard`, which refuses an unauthenticated request
    // on a non-`@Public()` route. It is the backstop for a route that ever loses
    // that guard, and refusing is the only safe reading of "no subject".
    if (claims === undefined) throw AuthorizationDeniedException.permission();

    const scopeNodeId =
      requirement.scopeFrom === undefined
        ? undefined
        : readScopeTarget(request, requirement.scopeFrom);

    const decision = await this.resolver.decide(claims, requirement, scopeNodeId);
    if (decision.outcome === AuthorizationOutcome.ALLOWED) return true;

    // Best-effort and awaited: the row commits on its own connection, so it
    // survives the rollback this 403 is about to cause, and the auditor's own
    // contract is that it never throws (Doc 10 §3).
    await this.auditor?.recordDenial(
      claims,
      decision.outcome,
      decision.permissions,
      decision.scopeNodeId,
    );

    throw decision.outcome === AuthorizationOutcome.PERMISSION_DENIED
      ? AuthorizationDeniedException.permission()
      : AuthorizationDeniedException.scope();
  }
}
