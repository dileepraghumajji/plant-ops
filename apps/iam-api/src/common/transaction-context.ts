/**
 * The transaction the current request is running in.
 *
 * Held in an `AsyncLocalStorage` rather than passed down as a parameter or
 * injected request-scoped. The reason is Doc 07 §5: the RLS context is set
 * with `set_config(..., true)` — **transaction-local** — so a service that
 * quietly uses the global `DataSource` instead of the request's transaction
 * runs with *no* tenant context on a pooled connection. RLS then filters that
 * query against an empty `app.current_client_id` and returns nothing, or, on a
 * table someone later exempts, returns everything.
 *
 * Making the manager ambient means a service never has to thread it through,
 * so there is no ergonomic reason to reach for the wrong one. `entityManager()`
 * throws rather than falling back to the data source, because a silent
 * fallback is precisely the bug above.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { SetMetadata } from '@nestjs/common';
import type { EntityManager } from 'typeorm';

/** What the request's transaction carries besides its manager. */
interface TransactionScope {
  manager: EntityManager;
  /** Work deferred until the transaction has actually committed. */
  afterCommit: Array<() => void | Promise<void>>;
}

const storage = new AsyncLocalStorage<TransactionScope>();

/** Runs `work` with `manager` as the ambient transaction. */
export function runInTransactionContext<T>(
  manager: EntityManager,
  work: (scope: TransactionScope) => Promise<T>,
): Promise<T> {
  const scope: TransactionScope = { manager, afterCommit: [] };
  return storage.run(scope, () => work(scope));
}

/**
 * Defers `callback` until this request's transaction commits.
 *
 * For anything that publishes a change to the world outside Postgres — a
 * revoked `sid` reaching the cache (Doc 03 §6), and from Session 22 the
 * `perms.invalidated` fan-out after a scope move (Doc 04 §7.1). Running such a
 * publish inline is a correctness bug in both directions: a rollback leaves the
 * outside world believing a change that never happened, and a reader racing the
 * commit repopulates its cache from pre-change state.
 *
 * Callbacks run after `COMMIT` returns, outside the transaction and outside the
 * response — the client has its answer by then. A callback that throws is
 * logged by the interceptor and otherwise ignored: the committed row is the
 * record of truth, and a failed cache publish must not turn a successful
 * request into an error.
 */
export function afterCommit(callback: () => void | Promise<void>): void {
  const scope = storage.getStore();
  if (scope === undefined) {
    throw new Error(
      'afterCommit() was called outside a request transaction; there is no ' +
        'commit to wait for, and running the callback now would publish a ' +
        'change that may never be written.',
    );
  }
  scope.afterCommit.push(callback);
}

/**
 * The current request's transactional `EntityManager`.
 *
 * @throws when called outside a request, or from a handler that opted out of
 * the transaction wrapper — both of which mean the query would have run
 * without an RLS context.
 */
export function entityManager(): EntityManager {
  const manager = storage.getStore()?.manager;
  if (manager === undefined) {
    throw new Error(
      'No transaction in scope. Database work must run inside the per-request ' +
        'transaction so the RLS context applies (Doc 07 §5); a handler marked ' +
        '@SkipTransaction() must not touch tenant tables.',
    );
  }
  return manager;
}

/** True when a transaction is in scope. For diagnostics, not for branching. */
export function hasTransactionContext(): boolean {
  return storage.getStore() !== undefined;
}

export const SKIP_TRANSACTION_METADATA = 'iam:skip-transaction';

/**
 * Opts a handler out of the per-request transaction.
 *
 * For routes that must answer without the database: `/health`, and `/ready`,
 * which asks whether the database is reachable and cannot do that from inside
 * a transaction on it.
 */
export const SkipTransaction = () => SetMetadata(SKIP_TRANSACTION_METADATA, true);

export const TRANSACTION_OPTIONS_METADATA = 'iam:transaction-options';

/**
 * The isolation levels a handler may ask for.
 *
 * Narrower than TypeORM's own union on purpose: `READ UNCOMMITTED` is not
 * offered, because in PostgreSQL it is a synonym for `READ COMMITTED` and
 * writing it would state an intention the database cannot honour.
 */
export type TransactionIsolation =
  | 'READ COMMITTED'
  | 'REPEATABLE READ'
  | 'SERIALIZABLE';

export interface TransactionOptions {
  /** Defaults to the connection's own level — `READ COMMITTED`. */
  isolation?: TransactionIsolation;
  /**
   * Extra attempts after a serialization failure (SQLSTATE 40001) or a
   * deadlock (40P01). Zero — the default — means the error surfaces.
   */
  retries?: number;
}

/**
 * Declares how this handler's request transaction is opened (Doc 04 §7.1).
 *
 * The isolation level has to be chosen *before* the transaction starts, and by
 * the time a service runs, `TenantContextInterceptor` has already opened one and
 * applied the RLS context inside it — Postgres refuses `set transaction
 * isolation level` after the first statement. So the level is metadata on the
 * route, read by the interceptor, rather than an argument a service could pass.
 *
 * Retrying likewise cannot live in a service: a serialization failure aborts the
 * whole transaction block, so every statement after it fails too. The only thing
 * that can retry is whatever owns the transaction, which is the interceptor —
 * it discards the runner and re-runs the handler from the top on a fresh one.
 *
 * ```ts
 * ⁣@Patch(':id')
 * ⁣@Transactional({ isolation: 'REPEATABLE READ', retries: 2 })
 * move(…) { … }
 * ```
 *
 * **Only for handlers whose effects are all inside the transaction.** A retried
 * handler runs twice, so anything it does outside Postgres would happen twice as
 * well. Work registered with {@link afterCommit} is safe by construction: the
 * failed attempt's callbacks are discarded with its scope and never run.
 */
export const Transactional = (options: TransactionOptions) =>
  SetMetadata(TRANSACTION_OPTIONS_METADATA, options);
