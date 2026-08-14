/**
 * The two properties `AuditService` exists to make structural (Doc 10 §3).
 *
 * **Same transaction as the change.** `record` must use the ambient request
 * transaction and nothing else, so that a rollback takes the audit row with it
 * and a commit cannot leave one behind. The claim is about *which connection*
 * the write went down, which is what these tests assert — that the ambient
 * manager saw the write and the pool saw nothing, and that with no transaction
 * in scope the call fails rather than quietly reaching for the data source.
 * (Whether Postgres then really discards the row is `audit.integration.spec.ts`,
 * which needs a real database to prove.)
 *
 * **The other direction, for denials.** `recordDenial` must do the opposite —
 * its own connection, its own commit — because the request it accompanies is
 * about to be rolled back by the 403 it produced. Same assertion, inverted.
 */

import { Logger } from '@nestjs/common';
import { markClaimsVerified, type VerifiedClaims } from '@plantops/db';
import type { EntityManager } from 'typeorm';
import { randomUUID } from 'node:crypto';
import { runInTransactionContext } from '../common/transaction-context';
import type { DatabaseService } from '../database/database.service';
import { AUDIT_ACTIONS } from './audit-actions';
import { AuditService } from './audit.service';
import { REDACTED } from './redact';

interface RecordedQuery {
  sql: string;
  parameters?: unknown[];
}

class RecordingManager {
  readonly queries: RecordedQuery[] = [];
  /** Set to make every query reject, standing in for a database that is gone. */
  failing = false;

  query = (sql: string, parameters?: unknown[]): Promise<unknown[]> => {
    this.queries.push({ sql, parameters });
    if (this.failing) return Promise.reject(new Error('connection lost'));
    return Promise.resolve([]);
  };
}

/**
 * Just enough `DataSource` for the denial path, which is the only one that
 * opens a connection of its own. `record` must never touch any of it — several
 * tests below assert exactly that.
 */
class FakeDataSource {
  readonly pool = new RecordingManager();
  readonly events: string[] = [];

  query = this.pool.query;

  createQueryRunner = () => {
    let active = false;
    return {
      manager: this.pool as unknown as EntityManager,
      get isTransactionActive() {
        return active;
      },
      connect: async () => this.events.push('connect'),
      startTransaction: async () => {
        active = true;
        this.events.push('begin');
      },
      commitTransaction: async () => {
        active = false;
        this.events.push('commit');
      },
      rollbackTransaction: async () => {
        active = false;
        this.events.push('rollback');
      },
      release: async () => this.events.push('release'),
    };
  };
}

const auditWrites = (queries: readonly RecordedQuery[]) =>
  queries.filter((query) => query.sql.includes('write_audit'));

/** The payload as it reached Postgres — the redaction boundary's actual output. */
const payloadOf = (query: RecordedQuery) =>
  JSON.parse(query.parameters?.[3] as string) as Record<string, unknown>;

describe('AuditService', () => {
  let dataSource: FakeDataSource;
  let service: AuditService;
  let ambient: RecordingManager;

  const claims: VerifiedClaims = markClaimsVerified({
    cid: randomUUID(),
    sub: randomUUID(),
    sty: 'user',
    sid: randomUUID(),
  });

  beforeEach(() => {
    dataSource = new FakeDataSource();
    ambient = new RecordingManager();
    service = new AuditService({ dataSource } as unknown as DatabaseService);
  });

  const inTransaction = (work: () => Promise<unknown>) =>
    runInTransactionContext(ambient as unknown as EntityManager, work);

  describe('record', () => {
    it('writes on the caller’s transaction and never on the pool', async () => {
      const sessionId = randomUUID();

      await inTransaction(() =>
        service.record(AUDIT_ACTIONS.SESSION_REVOKED, {
          type: 'session',
          id: sessionId,
        }),
      );

      const writes = auditWrites(ambient.queries);
      expect(writes).toHaveLength(1);
      expect(writes[0].parameters).toEqual([
        'auth.session.revoked',
        'session',
        sessionId,
        '{}',
      ]);

      // The whole point: nothing went down a connection that survives the
      // rollback the caller may be about to cause.
      expect(dataSource.pool.queries).toHaveLength(0);
      expect(dataSource.events).toEqual([]);
    });

    it('throws outside a transaction rather than falling back to the pool', async () => {
      await expect(
        service.record(AUDIT_ACTIONS.LOGOUT, { type: 'session', id: randomUUID() }),
      ).rejects.toThrow(/No transaction in scope/);

      expect(dataSource.pool.queries).toHaveLength(0);
    });

    it('redacts the payload on the way through', async () => {
      await inTransaction(() =>
        service.record(
          AUDIT_ACTIONS.SERVICE_ACCOUNT_CREATED,
          { type: 'service_account', id: randomUUID() },
          {
            name: 'gatepass-bot',
            account_key: 'sa_TWlkbmlnaHRHYXRlMDE',
            key_hash: '$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHQ$aGFzaA',
            nested: { leaked: 'Zm9vYmFyYmF6cXV1eGNvcmdlZ3JhdWx0Z2FycGx5' },
          },
        ),
      );

      expect(payloadOf(auditWrites(ambient.queries)[0])).toEqual({
        name: 'gatepass-bot',
        account_key: 'sa_TWlkbmlnaHRHYXRlMDE',
        key_hash: REDACTED,
        nested: { leaked: REDACTED },
      });
    });

    it('passes a null target id through rather than inventing one', async () => {
      await inTransaction(() =>
        service.record(AUDIT_ACTIONS.USER_BULK_UPLOADED, {
          type: 'user',
          id: null,
        }),
      );

      expect(auditWrites(ambient.queries)[0].parameters?.[2]).toBeNull();
    });

    it('propagates a write failure, so the change cannot commit without it', async () => {
      ambient.failing = true;

      await expect(
        inTransaction(() =>
          service.record(AUDIT_ACTIONS.LOGOUT, { type: 'session', id: randomUUID() }),
        ),
      ).rejects.toThrow('connection lost');
    });
  });

  describe('recordDenial', () => {
    it('commits on its own connection, not the caller’s transaction', async () => {
      const targetId = randomUUID();

      await inTransaction(() =>
        service.recordDenial(
          claims,
          AUDIT_ACTIONS.PERMISSION_DENIED,
          { type: 'nav_node', id: targetId },
          { permission: 'gatepass.dc.approve' },
        ),
      );

      // Its own transaction, opened and committed — so the 403 rolling the
      // request back cannot take the record with it.
      expect(dataSource.events).toEqual(['connect', 'begin', 'commit', 'release']);

      const writes = auditWrites(dataSource.pool.queries);
      expect(writes).toHaveLength(1);
      expect(writes[0].parameters?.[0]).toBe('authz.permission_denied');
      // The attempted permission is the whole point of the record (Doc 10 §4),
      // and a dotted permission key must survive redaction.
      expect(payloadOf(writes[0])).toEqual({ permission: 'gatepass.dc.approve' });

      // Nothing on the caller's transaction.
      expect(ambient.queries).toHaveLength(0);
    });

    it('applies the RLS context first, so the row names the subject', async () => {
      await service.recordDenial(claims, AUDIT_ACTIONS.SCOPE_DENIED, {
        type: 'scope_node',
        id: randomUUID(),
      });

      // `write_audit` derives actor and tenant from the session context
      // (migration 0010); without this the row would be attributed to nobody.
      const settings = dataSource.pool.queries.filter((query) =>
        query.sql.includes('set_config'),
      );
      expect(settings.length).toBeGreaterThan(0);
      expect(settings.flatMap((query) => query.parameters ?? [])).toContain(claims.cid);

      const auditIndex = dataSource.pool.queries.findIndex((query) =>
        query.sql.includes('write_audit'),
      );
      const lastSetting = dataSource.pool.queries.reduce(
        (last, query, index) => (query.sql.includes('set_config') ? index : last),
        -1,
      );
      expect(lastSetting).toBeLessThan(auditIndex);
    });

    it('swallows a failure rather than turning a 403 into a 500', async () => {
      const logged = jest.spyOn(Logger.prototype, 'error').mockImplementation();
      dataSource.pool.failing = true;

      await expect(
        service.recordDenial(claims, AUDIT_ACTIONS.PERMISSION_DENIED, {
          type: 'nav_node',
          id: randomUUID(),
        }),
      ).resolves.toBeUndefined();

      // Best-effort, but Doc 10 §3 asks that it not be *silently* dropped.
      expect(logged).toHaveBeenCalledTimes(1);
      expect(dataSource.events).toContain('rollback');
      expect(dataSource.events).toContain('release');

      logged.mockRestore();
    });
  });
});
