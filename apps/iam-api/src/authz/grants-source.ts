/**
 * The IAM's own answer to `auth-kit`'s {@link GrantsSource} — the connection
 * half of `docs/adr/0001-permission-guard-connection-strategy.md`.
 *
 * `PermissionGuard` asks one question ("what does this subject hold, and what is
 * the path of the node they named?"). Everything peculiar about *how* the IAM
 * answers it lives here, because the guard runs in a place where the ordinary
 * way of reaching the database does not exist yet.
 *
 * ## The three-line summary of the ADR
 *
 * Nest runs guards **before** interceptors, so at guard time
 * `TenantContextInterceptor` has not opened the request transaction — which
 * means `entityManager()` throws, and a query on a bare pooled connection would
 * run with no RLS context and match nothing (Doc 07 §5). So this service brings
 * its own `QueryRunner`, applies `applyRlsContext` from the verified claims,
 * asks its questions and commits, releasing in a `finally`. That is
 * `AuditService.recordDenial`'s shape, already in this codebase for the same
 * reason: work that has to precede or survive the request transaction.
 *
 * It does **not** open the request transaction. A guard has no "after" phase, so
 * a transaction opened here would have to be closed somewhere else, and a
 * request refused between the guard and the interceptor would leak the runner
 * (option B of the ADR — a defect, not a trade-off).
 *
 * ## A cache hit costs no connection at all
 *
 * The probe below runs before any `createQueryRunner()`, so the common case —
 * a subject whose grants are cached and a route that names no scope node — is
 * one Redis `MGET` and nothing else. That is what makes the guard affordable on
 * every request, and it is the property `authorization.integration.spec.ts`
 * asserts by counting queries rather than by timing anything.
 *
 * When the probe misses, or when a node's path is wanted, the resolve is
 * delegated to {@link ResolverService.grantsFor} rather than reimplemented. It
 * re-reads the cache, which is one redundant `MGET` on a path that is already
 * paying for a database round-trip — the alternative is a second copy of Doc 04
 * §7's version-stamping rule (write with the version observed *before* the
 * resolve, never one read after it), and that rule is subtle enough that two
 * copies of it is the wrong trade.
 *
 * ## Why the claims parameter is the branded type
 *
 * `auth-kit` cannot import `@plantops/db` (Doc 08 §2), so its port is declared
 * over the four-field {@link SubjectClaims}. Here the parameter narrows to
 * `VerifiedClaims`, the branded type `applyRlsContext` accepts — and it is safe
 * to narrow because there is exactly one producer: `RequestClaimsSource` reads
 * the value `RequestClaimsSink` stored on the request, and that sink is the only
 * caller of `markClaimsVerified` in the application. Nothing else can reach this
 * method, and nothing else could construct an argument for it.
 */

import { Injectable } from '@nestjs/common';
import type { AuthorizationSnapshot, GrantsSource } from '@plantops/auth-kit';
import { SubjectType } from '@plantops/contracts';
import { applyRlsContext, type VerifiedClaims } from '@plantops/db';
import { DatabaseService } from '../database/database.service';
import { GrantsCacheService } from './grants-cache.service';
import { ResolverService, type SubjectRef } from './resolver.service';

/**
 * The guard runs **before** the validation pipe — Nest orders pipes after
 * guards — so a scope target read out of the request is whatever the caller
 * sent, not a parsed uuid. Anything that is not one names no node, and is
 * refused as a scope denial rather than reaching `id = $1::uuid` and coming back
 * as a 500. A route whose own `ParseUUIDPipe` would have said 400 is one the
 * caller has already been refused by, for a reason that is at least as true.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Injectable()
export class IamGrantsSource implements GrantsSource {
  constructor(
    private readonly database: DatabaseService,
    private readonly resolver: ResolverService,
    private readonly cache: GrantsCacheService,
  ) {}

  async authorize(
    claims: VerifiedClaims,
    scopeNodeId?: string,
  ): Promise<AuthorizationSnapshot> {
    const subject = subjectRefOf(claims);

    // The Redis-only fast path. Deliberately not attempted when a node's path is
    // wanted: that always needs Postgres, so probing first would only add a
    // round-trip to a request already opening a connection.
    if (scopeNodeId === undefined) {
      const cached = await this.cache.read(subject);
      if (cached.grants !== null) return { grants: cached.grants };
    }

    const runner = this.database.dataSource.createQueryRunner();
    try {
      await runner.connect();
      await runner.startTransaction();
      try {
        // Transaction-local, so it exists for these two reads and is gone when
        // the connection returns to the pool — and it is derived from the
        // verified token, never from anything the request carries (Doc 07 §5).
        await applyRlsContext(runner.manager, claims);

        const grants = await this.resolver.grantsFor(runner.manager, subject);
        const targetPath =
          scopeNodeId === undefined || !UUID.test(scopeNodeId)
            ? undefined
            : await this.resolver.scopePathOf(runner.manager, subject.clientId, scopeNodeId);

        await runner.commitTransaction();
        return {
          grants,
          ...(scopeNodeId === undefined ? {} : { targetPath: targetPath ?? null }),
        };
      } catch (error) {
        if (runner.isTransactionActive) {
          await runner.rollbackTransaction().catch(() => undefined);
        }
        throw error;
      }
    } finally {
      // Before the handler's own transaction is opened by the interceptor, so
      // the two connections are sequential and never nested.
      await runner.release();
    }
  }
}

/**
 * Claims → the subject the resolution engine is keyed on.
 *
 * Every field comes from the token: the tenant from `cid`, which Doc 07 §5 makes
 * the only trustworthy source of one, and the subject from `sub` interpreted
 * through `sty`. There is no parameter here a caller could influence.
 */
function subjectRefOf(claims: VerifiedClaims): SubjectRef {
  return {
    clientId: claims.cid,
    type: claims.sty === SubjectType.USER ? SubjectType.USER : SubjectType.SERVICE,
    id: claims.sub,
  };
}
