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
import { IamException } from './iam.exception';
import { entityManager, hasTransactionContext } from './transaction-context';
import { type Harness, createHarness } from '../testing/app-harness';

@Controller('__txn')
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
}

describe('TenantContextInterceptor', () => {
  let harness: Harness;

  beforeAll(async () => {
    harness = await createHarness({ controllers: [TxnController] });
  });

  afterAll(async () => {
    await harness.close();
  });

  beforeEach(() => {
    harness.database.events.length = 0;
    harness.database.queries.length = 0;
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
    // matches no rows, which is the correct inert state before Session 8.
    const applied = harness.database.queries.filter((query) =>
      query.sql.includes('set_config'),
    );
    expect(applied).toEqual([]);
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
