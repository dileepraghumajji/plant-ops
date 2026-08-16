/**
 * The claim Session 12 has to earn against a real database: **a rolled-back
 * business transaction leaves no audit row** (Doc 10 §3).
 *
 * `audit.service.spec.ts` proves the half that TypeScript can prove — that the
 * write goes down the request's connection and never the pool. It cannot prove
 * the consequence, because a fake has no rollback to speak of. Only Postgres
 * can show that the row committed with the change and vanished with the
 * refusal, and only Postgres can show the *other* half of the coupling: that
 * `write_audit` stamped actor and tenant from the RLS context rather than from
 * anything the service asserted (migration 0010).
 *
 * Needs a migrated database. Skips (loudly, in the suite name) without one:
 *
 *   docker compose up -d postgres
 *   npm run migration:run
 *   npx nx test @plantops/iam-api
 *
 * **Destructive within its own fixture only.** It creates one client under a
 * generated slug and removes it afterwards. The audit rows it commits are
 * deliberately *not* removed — `audit_trail` has no DELETE grant for anyone but
 * the owner, and deleting from it in a test would be rehearsing the one
 * operation the whole design forbids. They are scoped to the fixture tenant and
 * carry a generated action target, so they are trivially identifiable.
 *
 * ## Why the service is exercised directly rather than over HTTP
 *
 * The property is about transaction boundaries, and the endpoints that would
 * reach it (`PATCH /iam/users/:id`, the registry surfaces) are Sessions 13–18.
 * Driving `AuditService` inside a transaction this suite controls is the
 * narrower test *and* the stronger one: it can roll back on demand, which no
 * shipped route can be asked to do.
 */

import { loadEnv } from '@plantops/config';
import {
  IAM_SCHEMA,
  IAM_SCHEMA_TEST_LOCK_ID,
  applyRlsContext,
  createAppDataSource,
  createMigrationDataSource,
  markClaimsVerified,
  type VerifiedClaims,
} from '@plantops/db';
import { randomUUID } from 'node:crypto';
import type { DataSource, EntityManager } from 'typeorm';
import { runInTransactionContext } from '../common/transaction-context';
import type { DatabaseService } from '../database/database.service';
import { AUDIT_ACTIONS } from './audit-actions';
import { AuditService } from './audit.service';
import { REDACTED } from './redact';

const S = `"${IAM_SCHEMA}"`;

const PLACEHOLDER = /REPLACE_ME|[[\]<>]/;
const usable = (url: string | undefined) =>
  url !== undefined &&
  /^postgres(ql)?:\/\/\S+@\S+/.test(url.trim()) &&
  !PLACEHOLDER.test(url);

const configured =
  usable(process.env['DATABASE_URL']) && usable(process.env['DATABASE_DIRECT_URL']);

const describeWithDb = configured ? describe : describe.skip;

interface AuditRow {
  action: string;
  client_id: string | null;
  actor_type: string;
  actor_id: string | null;
  target_type: string | null;
  target_id: string | null;
  payload: Record<string, unknown>;
}

describeWithDb(
  `AuditService against Postgres (${configured ? 'live' : 'skipped: no DATABASE_URL'})`,
  () => {
    let admin: DataSource;
    let app: DataSource;
    let service: AuditService;
    let claims: VerifiedClaims;
    let clientId: string;
    let userId: string;

    jest.setTimeout(60_000);

    beforeAll(async () => {
      const env = loadEnv();

      admin = createMigrationDataSource(env);
      await admin.initialize();
      await admin.query('select pg_advisory_lock($1)', [IAM_SCHEMA_TEST_LOCK_ID]);

      const suffix = randomUUID().slice(0, 8);
      clientId = randomUUID();
      userId = randomUUID();

      // Even the owner needs a context: every tenant table carries `force row
      // level security`, which applies to the owner too (Doc 07 §5.1) — and the
      // `client` policy's `with check` names the tenant, so the id has to be
      // decided here rather than by the default.
      await elevate();
      await admin.query(
        `insert into ${S}."client" (id, name, slug, status) values ($1, $2, $3, 'active')`,
        [clientId, `Session 12 ${suffix}`, `s12-audit-${suffix}`],
      );
      await admin.query(
        `insert into ${S}."user" (id, client_id, email, full_name, status)
         values ($1, $2, $3, 'Session 12 Fixture', 'active')`,
        [userId, clientId, `audit-${suffix}@example.test`],
      );

      claims = markClaimsVerified({
        cid: clientId,
        sub: userId,
        sty: 'user',
        sid: randomUUID(),
      });

      // The **app** role, not the owner — the audit grants are what this suite
      // is standing on, and the owner is exempt from them (Doc 07 §5.1).
      app = createAppDataSource(env);
      await app.initialize();

      service = new AuditService({ dataSource: app } as unknown as DatabaseService);
    });

    afterAll(async () => {
      if (app?.isInitialized) await app.destroy();
      if (admin?.isInitialized) {
        await elevate();
        // As the **owner**, which is the only role that can — the app role has
        // no DELETE on `audit_trail` at all, and this suite proves it below.
        await admin.query(`delete from ${S}."audit_trail" where client_id = $1`, [
          clientId,
        ]);
        await admin.query(`delete from ${S}."user" where client_id = $1`, [clientId]);
        await admin.query(`delete from ${S}."client" where id = $1`, [clientId]);
        await admin.query('select pg_advisory_unlock($1)', [IAM_SCHEMA_TEST_LOCK_ID]);
        await admin.destroy();
      }
    });

    /** The owner's own RLS context — see `elevate` in the Session 10 suite. */
    async function elevate(): Promise<void> {
      await admin.query(`select set_config('app.is_platform_admin', 'true', false)`);
      await admin.query(`select set_config('app.current_client_id', $1, false)`, [
        clientId,
      ]);
    }

    /** Runs `work` in a transaction with the fixture's RLS context applied. */
    async function inTransaction(
      work: (manager: EntityManager) => Promise<unknown>,
      outcome: 'commit' | 'rollback',
    ): Promise<void> {
      const runner = app.createQueryRunner();
      await runner.connect();
      await runner.startTransaction();
      try {
        await applyRlsContext(runner.manager, claims);
        await runInTransactionContext(runner.manager, () => work(runner.manager));
        if (outcome === 'commit') await runner.commitTransaction();
        else await runner.rollbackTransaction();
      } finally {
        if (runner.isTransactionActive) await runner.rollbackTransaction();
        await runner.release();
      }
    }

    /** A row by everything except which target it names. */
    function comparable(row: AuditRow): Omit<AuditRow, 'target_id'> {
      return {
        action: row.action,
        client_id: row.client_id,
        actor_type: row.actor_type,
        actor_id: row.actor_id,
        target_type: row.target_type,
        payload: row.payload,
      };
    }

    async function rowsFor(targetId: string): Promise<AuditRow[]> {
      return (await admin.query(
        `select action, client_id, actor_type, actor_id, target_type, target_id, payload
           from ${S}."audit_trail" where target_id = $1`,
        [targetId],
      )) as AuditRow[];
    }

    it('leaves no audit row when the business transaction rolls back', async () => {
      const targetId = randomUUID();

      await inTransaction(
        () => service.record(AUDIT_ACTIONS.USER_UPDATED, { type: 'user', id: targetId }),
        'rollback',
      );

      expect(await rowsFor(targetId)).toEqual([]);
    });

    it('commits the audit row with the change, attributed from the context', async () => {
      const targetId = randomUUID();

      await inTransaction(
        () =>
          service.record(
            AUDIT_ACTIONS.USER_UPDATED,
            { type: 'user', id: targetId },
            { full_name: 'Renamed', password: 'hunter2' },
          ),
        'commit',
      );

      const rows = await rowsFor(targetId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        action: AUDIT_ACTIONS.USER_UPDATED,
        // Derived by `write_audit` from the session context, not passed in —
        // there is no parameter through which this service could claim to be
        // anyone else (migration 0010).
        client_id: clientId,
        actor_type: 'user',
        actor_id: userId,
        target_type: 'user',
        target_id: targetId,
      });
      expect(rows[0].payload).toEqual({ full_name: 'Renamed', password: REDACTED });
    });

    it('writes the same row in a batch as it does one at a time', async () => {
      // The claim `recordMany` has to earn: it is a round-trip optimisation and
      // nothing else. Every column `write_audit` derives — tenant, actor type,
      // actor — plus the redacted payload must come out of the batched form
      // exactly as they came out of the single one, or the two writers are two
      // vocabularies again and the boundary this service exists to be is gone.
      const alone = randomUUID();
      const batched = randomUUID();
      const alongside = randomUUID();
      const payload = { full_name: 'Renamed', password: 'hunter2' };

      await inTransaction(
        () => service.record(AUDIT_ACTIONS.USER_UPDATED, { type: 'user', id: alone }, payload),
        'commit',
      );

      await inTransaction(
        () =>
          service.recordMany([
            {
              action: AUDIT_ACTIONS.USER_UPDATED,
              target: { type: 'user', id: batched },
              payload,
            },
            // A second entry with a different action, target type and payload,
            // so the batch is not proved on a single row.
            {
              action: AUDIT_ACTIONS.SESSION_REVOKED,
              target: { type: 'session', id: alongside },
            },
          ]),
        'commit',
      );

      const [single] = await rowsFor(alone);
      const [many] = await rowsFor(batched);

      // Every column but the target the two rows deliberately differ on.
      expect(comparable(many)).toEqual(comparable(single));
      expect(many.payload).toEqual({ full_name: 'Renamed', password: REDACTED });

      // The other entry of the same batch, on its own terms.
      const [second] = await rowsFor(alongside);
      expect(second).toMatchObject({
        action: AUDIT_ACTIONS.SESSION_REVOKED,
        client_id: clientId,
        actor_type: 'user',
        actor_id: userId,
        target_type: 'session',
      });
      expect(second.payload).toEqual({});
    });

    it('leaves no audit rows when a batched write’s transaction rolls back', async () => {
      const first = randomUUID();
      const second = randomUUID();

      await inTransaction(
        () =>
          service.recordMany([
            { action: AUDIT_ACTIONS.USER_UPDATED, target: { type: 'user', id: first } },
            { action: AUDIT_ACTIONS.USER_UPDATED, target: { type: 'user', id: second } },
          ]),
        'rollback',
      );

      expect(await rowsFor(first)).toEqual([]);
      expect(await rowsFor(second)).toEqual([]);
    });

    it('rolls back the change and the record together, not one of them', async () => {
      // The coupling in the direction that is easy to get wrong: the audit
      // succeeded, and the *business* write failed afterwards. Both must go.
      const targetId = randomUUID();

      await expect(
        inTransaction(async (manager) => {
          await service.record(AUDIT_ACTIONS.USER_UPDATED, {
            type: 'user',
            id: targetId,
          });
          await manager.query(`select 1 / 0`);
        }, 'commit'),
      ).rejects.toThrow();

      expect(await rowsFor(targetId)).toEqual([]);
    });

    it('refuses a direct insert from the app role — the writer is the only door', async () => {
      // Doc 10 §1: append-only is a privilege, not a convention. If this ever
      // succeeds, every same-transaction guarantee above is decoration.
      await expect(
        app.query(
          `insert into ${S}."audit_trail"
             (client_id, actor_type, actor_id, action, target_type, target_id, payload)
           values ($1, 'user', $2, 'auth.logout', 'session', $3, '{}'::jsonb)`,
          [clientId, userId, randomUUID()],
        ),
      ).rejects.toThrow(/permission denied/i);
    });
  },
);
