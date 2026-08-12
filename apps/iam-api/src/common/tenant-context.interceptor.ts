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
 * A request with no verified claims still gets a transaction, and still gets
 * no RLS context. The result is that every tenant-scoped policy evaluates
 * against an unset `app.current_client_id` and matches nothing. Opening the
 * transaction anyway is the point: it means the *only* difference between an
 * authenticated and an unauthenticated request is which rows the database is
 * willing to return, rather than whether the mechanism ran at all.
 *
 * Until Session 8 provides tokens, that is every request — the wrapper is
 * live but inert, exactly as the roadmap describes.
 */

import {
  type CallHandler,
  type ExecutionContext,
  Injectable,
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

      const result = await runInTransactionContext(runner.manager, () =>
        // `defaultIfEmpty` covers handlers that return nothing — a 204 route
        // completes its observable without emitting, and `firstValueFrom`
        // rejects on an empty one, which would roll back a successful write.
        firstValueFrom(next.handle().pipe(defaultIfEmpty(undefined))),
      );

      await runner.commitTransaction();
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
}
