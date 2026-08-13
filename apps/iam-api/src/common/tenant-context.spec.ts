/**
 * The per-request transaction wrapper.
 *
 * These assertions are about *shape* — that a transaction is opened, that it
 * commits on success and rolls back on failure, that the handler sees the
 * transaction's manager and not the pool. Whether the RLS context the wrapper
 * applies is actually honoured by Postgres is a different question, and a fake
 * database cannot answer it: see `rls-context.integration.spec.ts`.
 */

import { Controller, Get } from '@nestjs/common';
import { Public } from '@plantops/auth-kit';
import { IamException } from './iam.exception';
import {
  afterCommit,
  entityManager,
  hasTransactionContext,
} from './transaction-context';
import { type Harness, createHarness } from '../testing/app-harness';

/**
 * `@Public()` on the read/fail routes so the transaction shape can be asserted
 * without a token in play; the authenticated case gets its own route below,
 * because "an authenticated request applies the RLS context" is a different
 * claim from "a transaction is opened".
 */
@Controller('__txn')
@Public()
class TxnController {
  @Get('read')
  async read(): Promise<{ inTransaction: boolean }> {
    await entityManager().query('select 1');
    return { inTransaction: hasTransactionContext() };
  }

  @Get('fail')
  async fail(): Promise<never> {
    await entityManager().query('insert into thing values (1)');
    throw IamException.conflict('nope');
  }

  @Get('after-commit')
  async deferred(): Promise<{ ok: true }> {
    await entityManager().query('select 1');
    afterCommit(() => {
      published.push('published');
    });
    return { ok: true };
  }

  @Get('after-commit-fails')
  async deferredFailure(): Promise<{ ok: true }> {
    await entityManager().query('select 1');
    afterCommit(() => {
      throw new Error('cache unreachable');
    });
    return { ok: true };
  }
}

/** What a post-commit callback did, and when relative to the commit. */
const published: string[] = [];

/** Authenticated, so the interceptor has claims to build an RLS context from. */
@Controller('__ctx-txn')
class AuthenticatedTxnController {
  @Get()
  async read(): Promise<{ ok: true }> {
    await entityManager().query('select 1');
    return { ok: true };
  }
}

describe('TenantContextInterceptor', () => {
  let harness: Harness;

  beforeAll(async () => {
    harness = await createHarness({
      controllers: [TxnController, AuthenticatedTxnController],
    });
  });

  afterAll(async () => {
    await harness.close();
  });

  beforeEach(() => {
    harness.database.events.length = 0;
    harness.database.queries.length = 0;
    published.length = 0;
  });

  it('runs the handler inside a transaction and commits it', async () => {
    const response = await harness.get('/__txn/read');

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ inTransaction: true });
    expect(harness.database.events).toEqual(['begin', 'commit', 'release']);
  });

  it('rolls back when the handler throws, and still releases the connection', async () => {
    const response = await harness.get('/__txn/fail');

    expect(response.status).toBe(409);
    expect(harness.database.events).toEqual(['begin', 'rollback', 'release']);
    // A leaked query runner is invisible until the pool is exhausted, which is
    // why `release` is asserted on both paths.
  });

  it('applies no RLS context for an unauthenticated request', async () => {
    await harness.get('/__txn/read');

    // Not "sets an empty tenant" — sets nothing at all. Every tenant-scoped
    // policy then evaluates against an unset `app.current_client_id` and
    // matches no rows, which is the correct inert state for a public route.
    const applied = harness.database.queries.filter((query) =>
      query.sql.includes('set_config'),
    );
    expect(applied).toEqual([]);
  });

  it('applies the token`s tenant as the RLS context for an authenticated one', async () => {
    const token = harness.tokenFor();

    const response = await harness.get('/__ctx-txn', { headers: token.headers });

    expect(response.status).toBe(200);
    // The claim under test is provenance: the tenant Postgres is told about
    // came from `cid` on a verified token, and from nothing else (Doc 07 §5).
    const applied = harness.database.queries.filter((query) =>
      query.sql.includes('set_config'),
    );
    expect(applied[0]?.parameters).toEqual(['app.current_client_id', token.claims.cid]);
    expect(applied[1]?.parameters).toEqual(['app.current_user_id', token.claims.sub]);
  });

  it('runs post-commit callbacks only after the transaction commits', async () => {
    const response = await harness.get('/__txn/after-commit');

    expect(response.status).toBe(200);
    // Ordering, not merely occurrence: publishing before COMMIT is how a
    // rollback leaves the outside world believing a change that never landed
    // (Doc 04 §7.1 makes the same demand of scope moves).
    expect(harness.database.events).toEqual(['begin', 'commit', 'release']);
    expect(published).toEqual(['published']);
  });

  it('does not run post-commit callbacks when the transaction rolls back', async () => {
    await harness.get('/__txn/fail');

    expect(harness.database.events).toEqual(['begin', 'rollback', 'release']);
    expect(published).toEqual([]);
  });

  it('answers the request even when a post-commit callback throws', async () => {
    // The write is already committed by the time these run, so a failed cache
    // publish must not be reported to the caller as a failed request.
    const response = await harness.get('/__txn/after-commit-fails');

    expect(response.status).toBe(200);
    expect(harness.database.events).toEqual(['begin', 'commit', 'release']);
  });

  it('gives the handler the transaction manager, never the pool', async () => {
    await harness.get('/__txn/read');

    // The query reached the query runner's manager — the only executor whose
    // `set_config(..., true)` context is in scope (Doc 07 §5).
    expect(harness.database.queries).toEqual([
      { sql: 'select 1', parameters: undefined },
    ]);
  });
});
