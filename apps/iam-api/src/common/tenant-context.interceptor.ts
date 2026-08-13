/**
 * One transaction per request, with the RLS context inside it (Doc 07 §5).
 *
 * This is the interceptor the whole database design depends on. Three things
 * have to be true together, and each one is load-bearing:
 *
 * 1. **There is a transaction.** `applyRlsContext` sets its variables with
 *    `set_config(..., true)`, which is transaction-local. Run outside one and
 *    the setting becomes session-local — pinned to a pooled connection and
 *    handed to whichever tenant's request gets that connection next. That is
 *    not a subtle leak; it is one tenant reading another's rows.
 * 2. **The context is set before any handler code runs**, so no query can
 *    reach a table ahead of the policy that filters it.
 * 3. **The handler uses this transaction's `EntityManager`**, which
 *    `runInTransactionContext` makes ambient — see `transaction-context.ts`.
 *
 * ## Unauthenticated requests
 *
 * A `@Public()` route — login, the JWKS, the probes — still gets a transaction,
 * and still gets no RLS context. The result is that every tenant-scoped policy
 * evaluates against an unset `app.current_client_id` and matches nothing.
 * Opening the transaction anyway is the point: it means the *only* difference
 * between an authenticated and an unauthenticated request is which rows the
 * database is willing to return, rather than whether the mechanism ran at all.
 *
 * Login reaches its own data through the migration-0012 definer functions
 * precisely because this leaves it, correctly, able to read nothing.
 *
 * ## Post-commit work
 *
 * Callbacks registered with `afterCommit()` run here, after `COMMIT` returns.
 * That ordering is required wherever a change is published outside Postgres —
 * a revoked `sid` reaching the cache today (Doc 03 §6), the grant invalidation
 * fan-out in Session 22 (Doc 04 §7.1).
 */

import {
  type CallHandler,
  type ExecutionContext,
  Injectable,
  Logger,
  type NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { applyRlsContext } from '@plantops/db';
import { type Observable, defaultIfEmpty, firstValueFrom, from } from 'rxjs';
import { DatabaseService } from '../database/database.service';
import {
  SKIP_TRANSACTION_METADATA,
  runInTransactionContext,
} from './transaction-context';
import { verifiedClaimsOf } from './verified-claims';

@Injectable()
export class TenantContextInterceptor implements NestInterceptor {
  private readonly logger = new Logger(TenantContextInterceptor.name);

  constructor(
    private readonly database: DatabaseService,
    private readonly reflector: Reflector,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const skip = this.reflector.getAllAndOverride<boolean>(
      SKIP_TRANSACTION_METADATA,
      [context.getHandler(), context.getClass()],
    );
    if (skip || context.getType() !== 'http') return next.handle();

    return from(this.runInTransaction(context, next));
  }

  private async runInTransaction(
    context: ExecutionContext,
    next: CallHandler,
  ): Promise<unknown> {
    const runner = this.database.dataSource.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();

    try {
      const claims = verifiedClaimsOf(context.switchToHttp().getRequest());
      if (claims) await applyRlsContext(runner.manager, claims);

      let deferred: Array<() => void | Promise<void>> = [];
      const result = await runInTransactionContext(runner.manager, async (scope) => {
        // `defaultIfEmpty` covers handlers that return nothing — a 204 route
        // completes its observable without emitting, and `firstValueFrom`
        // rejects on an empty one, which would roll back a successful write.
        const value = await firstValueFrom(
          next.handle().pipe(defaultIfEmpty(undefined)),
        );
        deferred = scope.afterCommit;
        return value;
      });

      await runner.commitTransaction();
      // Only now: everything registered here publishes a fact to the world
      // outside Postgres, and until COMMIT returns there is no such fact.
      await this.runAfterCommit(deferred);
      return result;
    } catch (error) {
      // Rollback is best-effort: if the transaction is already aborted (or the
      // connection is gone) the rollback throws too, and letting *that* error
      // propagate would replace the real cause with a meaningless one.
      if (runner.isTransactionActive) {
        await runner.rollbackTransaction().catch(() => undefined);
      }
      throw error;
    } finally {
      await runner.release();
    }
  }

  /**
   * Runs the deferred callbacks, and never lets one fail the request.
   *
   * The write is already committed by the time these run, so throwing here
   * would answer an error for a request that succeeded — and would do it for a
   * cache publish, which is recoverable by design (every consumer of these
   * caches has a database fallback). Each failure is logged loudly instead,
   * because a silent one is how a stale cache becomes permanent.
   */
  private async runAfterCommit(
    callbacks: Array<() => void | Promise<void>>,
  ): Promise<void> {
    for (const callback of callbacks) {
      try {
        await callback();
      } catch (error) {
        this.logger.error(
          `A post-commit callback failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  }
}
