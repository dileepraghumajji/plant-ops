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
import type { GrantInvalidationService } from '../authz/invalidation.service';
import { runInTransactionContext } from '../common/transaction-context';
import type { DatabaseService } from '../database/database.service';
import { FakeDatabaseService, type RecordedQuery } from '../testing/app-harness';
import { RolesService } from './roles.service';

/**
 * A stub, because `remove` must never call it during the transaction.
 *
 * Its publish is registered with `afterCommit()`, and `runInTransactionContext`
 * collects those callbacks without running them — so a stub that throws would
 * still pass. `subjectsBoundToRole` is the one that would show up here, and it
 * is the method `remove` deliberately does *not* use: the cascade's subjects are
 * derived from the binding rows it already read, which is what keeps the query
 * count flat in the assertion below.
 */
const invalidation = {
  subjectsBoundToRole: () => {
    throw new Error('remove() must derive its subjects from the bindings it read');
  },
  publish: async () => undefined,
} as unknown as GrantInvalidationService;

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
 * role, its bindings, and the count of mappings the cascade will take. There is
 * no authorization read among them — since Session 23 that happens in
 * `PermissionGuard`, before the request transaction this service runs in.
 */
async function deleteRole(
  bindingCount: number,
): Promise<{ audits: RecordedQuery[]; statements: number }> {
  const database = new FakeDatabaseService();
  const audit = new AuditService(database as unknown as DatabaseService);
  const service = new RolesService(audit, invalidation);
  const roleId = randomUUID();

  database.rows.push(
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

  return {
    audits: database.queries.filter((query) => query.sql.includes('write_audit')),
    statements: database.queries.length,
  };
}

describe('RolesService.remove — the cascade’s audit cost', () => {
  it('issues one statement for the bindings however many there are', async () => {
    const small = await deleteRole(2);
    const wide = await deleteRole(500);
    const [smallBatch, smallSummary, ...smallExtra] = small.audits;
    const [wideBatch, wideSummary, ...wideExtra] = wide.audits;

    // The whole property, stated as invariance rather than as a magic number:
    // deleting a role bound at 500 subjects costs exactly what deleting one
    // bound at two costs. Session 22 hung an invalidation off this path
    // (Doc 04 §7, "role deleted → all subjects bound to that role") and it had
    // to come for free — the affected subjects are the binding rows already
    // read, not a query of their own.
    expect(wide.statements).toBe(small.statements);

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
    const { audits: statements } = await deleteRole(0);

    // An empty batch is a no-op that writes no statement, so what is left is the
    // summary alone — the shape `roles.integration.spec.ts` asserts from the
    // other side, as "without inventing binding records".
    expect(statements).toHaveLength(1);
    expect(statements[0].parameters?.[0]).toBe('role.deleted');
  });
});
