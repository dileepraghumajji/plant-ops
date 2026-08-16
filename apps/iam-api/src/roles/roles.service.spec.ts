/**
 * The one property of `RolesService.remove` that is about *cost* rather than
 * behaviour: **the cascade's audit is one statement, whatever it cascades.**
 *
 * `roles.integration.spec.ts` owns the behaviour — one `role_binding.deleted`
 * record per revoked grant, each naming the subject and the scope, all written
 * before the rows they describe are gone. That suite needs a real Postgres and
 * asserts on rows, which is exactly the wrong instrument for this: a trail of
 * 500 records looks identical whether it took 500 round-trips or one.
 *
 * So this asserts on the *statements*, against the fake the harness already
 * uses. A role bound at 500 subjects holds an open transaction — and a lockable
 * `role` row — for as long as the audit takes, so "one statement" is the
 * difference between a delete that is quick and one whose duration scales with
 * how widely the role was granted.
 */

import { markClaimsVerified, type VerifiedClaims } from '@plantops/db';
import { randomUUID } from 'node:crypto';
import type { EntityManager } from 'typeorm';
import { AuditService } from '../audit/audit.service';
import { runInTransactionContext } from '../common/transaction-context';
import type { DatabaseService } from '../database/database.service';
import { FakeDatabaseService, type RecordedQuery } from '../testing/app-harness';
import { RolesService } from './roles.service';

const claims: VerifiedClaims = markClaimsVerified({
  cid: randomUUID(),
  sub: randomUUID(),
  sty: 'user',
  sid: randomUUID(),
});

/**
 * Deletes a role bound at `bindingCount` subjects and returns the audit
 * statements it issued.
 *
 * The queued rows are what `remove` reads, in the order it reads them: the
 * administrator check, the role, its bindings, and the count of mappings the
 * cascade will take.
 */
async function auditStatementsForDelete(
  bindingCount: number,
): Promise<RecordedQuery[]> {
  const database = new FakeDatabaseService();
  const audit = new AuditService(database as unknown as DatabaseService);
  const service = new RolesService(audit);
  const roleId = randomUUID();

  database.rows.push(
    [{ platform: true, client_admin: false }],
    [
      {
        id: roleId,
        client_id: claims.cid,
        name: 'Gate Supervisor',
        description: null,
        is_system: false,
        created_at: new Date(),
        updated_at: new Date(),
      },
    ],
    Array.from({ length: bindingCount }, () => ({
      id: randomUUID(),
      user_id: randomUUID(),
      service_account_id: null,
      scope_node_id: randomUUID(),
      scope_node_path: 'acme.plant_a',
      expires_at: null,
    })),
    [{ mapped: 2 }],
  );

  const runner = database.dataSource.createQueryRunner();
  const removed = await runInTransactionContext(
    runner.manager as unknown as EntityManager,
    () => service.remove(claims, roleId),
  );
  expect(removed).toBe(true);

  return database.queries.filter((query) => query.sql.includes('write_audit'));
}

describe('RolesService.remove — the cascade’s audit cost', () => {
  it('issues one statement for the bindings however many there are', async () => {
    const [smallBatch, smallSummary, ...smallExtra] = await auditStatementsForDelete(2);
    const [wideBatch, wideSummary, ...wideExtra] = await auditStatementsForDelete(500);

    // Two statements either way: the batch of `role_binding.deleted` records,
    // and the single `role.deleted` summary that follows the delete.
    expect(smallExtra).toEqual([]);
    expect(wideExtra).toEqual([]);
    expect(smallSummary.parameters?.[0]).toBe('role.deleted');
    expect(wideSummary.parameters?.[0]).toBe('role.deleted');

    // The rows are still per-binding — the granularity Doc 10 §4 asks for is a
    // property of the records, and only the round-trip count changed.
    expect(smallBatch.parameters?.[0]).toHaveLength(2);
    expect(wideBatch.parameters?.[0]).toHaveLength(500);
  });

  it('issues no batch at all when the role had no bindings', async () => {
    const statements = await auditStatementsForDelete(0);

    // An empty batch is a no-op that writes no statement, so what is left is the
    // summary alone — the shape `roles.integration.spec.ts` asserts from the
    // other side, as "without inventing binding records".
    expect(statements).toHaveLength(1);
    expect(statements[0].parameters?.[0]).toBe('role.deleted');
  });
});
