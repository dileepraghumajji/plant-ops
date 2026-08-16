/**
 * The expiry sweep's control flow, without a database (Doc 04 §7, Doc 01 §4.5).
 *
 * What the SQL does — claiming rows exactly once, auditing them in their own
 * tenant, surviving two replicas — belongs to migration 0016 and is proven in
 * `invalidation.integration.spec.ts` against a real Postgres, because every one
 * of those properties is a property of `for update skip locked` and of the RLS
 * policies, which no fake can model honestly.
 *
 * What is left, and what is here, is the part that is this class's own: that it
 * runs on the pool rather than a request transaction, that a timer callback can
 * never take the process down, that a slow pass does not stack, and that each
 * claimed binding turns into an invalidation for the right subject in the right
 * tenant.
 */

import type { EnvConfig } from '@plantops/config';
import { SubjectType } from '@plantops/contracts';
import type { DatabaseService } from '../database/database.service';
import { ExpirySweepJob } from './expiry-sweep.job';
import type {
  GrantInvalidationService,
  InvalidationReason,
  TenantSubject,
} from './invalidation.service';

const CLIENT_A = '00000000-0000-4000-8000-0000000000c1';
const CLIENT_B = '00000000-0000-4000-8000-0000000000c2';
const ALICE = '00000000-0000-4000-8000-0000000000a1';
const BOT = '00000000-0000-4000-8000-0000000000b1';

interface SweptRow {
  binding_id: string;
  binding_client_id: string;
  binding_user_id: string | null;
  binding_service_account_id: string | null;
}

interface Published {
  subjects: readonly TenantSubject[];
  reason: InvalidationReason;
}

function createJob(options: { interval?: number; rows?: SweptRow[] } = {}) {
  const queries: { sql: string; parameters: unknown[] }[] = [];
  const published: Published[] = [];
  let failQuery: Error | null = null;

  const database = {
    dataSource: {
      query: async (sql: string, parameters: unknown[]) => {
        queries.push({ sql, parameters });
        if (failQuery !== null) throw failQuery;
        return options.rows ?? [];
      },
    },
  } as unknown as DatabaseService;

  const invalidation = {
    publishAcrossTenants: async (
      subjects: readonly TenantSubject[],
      reason: InvalidationReason,
    ) => {
      published.push({ subjects, reason });
    },
  } as unknown as GrantInvalidationService;

  const env = {
    EXPIRY_SWEEP_INTERVAL_SECONDS: options.interval ?? 60,
    EXPIRY_SWEEP_BATCH_SIZE: 500,
  } as EnvConfig;

  return {
    job: new ExpirySweepJob(env, database, invalidation),
    queries,
    published,
    fail: (error: Error) => {
      failQuery = error;
    },
  };
}

describe('ExpirySweepJob.runOnce', () => {
  it('calls the definer function on the pool with the configured batch size', async () => {
    const { job, queries } = createJob();

    await expect(job.runOnce()).resolves.toEqual({ bindings: 0, subjects: 0 });

    // The pool, not `entityManager()`: there is no request here and therefore no
    // ambient transaction. All the work is inside the function because the sweep
    // has no RLS context of its own to run a query under (Doc 07 §5).
    expect(queries).toHaveLength(1);
    expect(queries[0].sql).toContain('sweep_expired_bindings');
    expect(queries[0].parameters).toEqual([500]);
  });

  it('publishes nothing when nothing has newly expired', async () => {
    const { job, published } = createJob();

    // The steady state, once a minute, forever: an index scan over an empty
    // partial index and no Redis traffic at all.
    await job.runOnce();

    expect(published).toEqual([]);
  });

  it('invalidates each claimed binding’s subject in its own tenant', async () => {
    const { job, published } = createJob({
      rows: [
        {
          binding_id: 'b1',
          binding_client_id: CLIENT_A,
          binding_user_id: ALICE,
          binding_service_account_id: null,
        },
        {
          binding_id: 'b2',
          binding_client_id: CLIENT_B,
          binding_user_id: null,
          binding_service_account_id: BOT,
        },
      ],
    });

    await expect(job.runOnce()).resolves.toEqual({ bindings: 2, subjects: 2 });

    // The XOR of migration 0004 read the only way it can be: whichever column is
    // populated is the subject, and the type follows from which one that was.
    expect(published[0]).toEqual({
      subjects: [{ clientId: CLIENT_A, type: SubjectType.USER, id: ALICE }],
      reason: { cause: 'role_binding.expired', bindingId: 'b1' },
    });
    expect(published[1]).toEqual({
      subjects: [{ clientId: CLIENT_B, type: SubjectType.SERVICE, id: BOT }],
      reason: { cause: 'role_binding.expired', bindingId: 'b2' },
    });
  });

  it('counts one subject when two of their bindings lapse together', async () => {
    const { job } = createJob({
      rows: [
        {
          binding_id: 'b1',
          binding_client_id: CLIENT_A,
          binding_user_id: ALICE,
          binding_service_account_id: null,
        },
        {
          binding_id: 'b2',
          binding_client_id: CLIENT_A,
          binding_user_id: ALICE,
          binding_service_account_id: null,
        },
      ],
    });

    // Two grants with the same expiry — a temporary contractor bound at two
    // gates. Two audit rows, two events, one cache entry; the `subjects` count
    // is what the log line reports and it should say one person.
    await expect(job.runOnce()).resolves.toEqual({ bindings: 2, subjects: 1 });
  });

  it('propagates a failure to a caller that asked for a pass', async () => {
    const { job, fail } = createJob();
    fail(new Error('connection terminated'));

    // `runOnce` is public so an operator can force a sweep after an outage, and
    // someone who does that wants to know it failed. The timer path swallows it
    // instead — see below.
    await expect(job.runOnce()).rejects.toThrow('connection terminated');
  });
});

describe('ExpirySweepJob scheduling', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('does not schedule anything when the interval is zero', () => {
    jest.useFakeTimers();
    const { job, queries } = createJob({ interval: 0 });

    // The documented off switch (`env.schema.ts`). Integration suites need it:
    // a timer firing mid-run makes cache assertions non-deterministic, and the
    // fallback is the grants TTL, which Doc 04 §7 already accepts as the bound.
    job.onApplicationBootstrap();
    jest.advanceTimersByTime(600_000);

    expect(queries).toEqual([]);
    job.onApplicationShutdown();
  });

  it('sweeps on the interval and stops on shutdown', async () => {
    jest.useFakeTimers();
    const { job, queries } = createJob({ interval: 60 });

    job.onApplicationBootstrap();

    jest.advanceTimersByTime(60_000);
    await Promise.resolve();
    expect(queries).toHaveLength(1);

    job.onApplicationShutdown();
    jest.advanceTimersByTime(600_000);
    await Promise.resolve();

    // Still one. A timer surviving shutdown would keep a connection pool alive
    // past `onApplicationShutdown`, which is where `DatabaseService` destroys it.
    expect(queries).toHaveLength(1);
  });

  it('never lets a failed pass escape the timer', async () => {
    jest.useFakeTimers();
    const { job, fail } = createJob({ interval: 60 });
    fail(new Error('connection terminated'));

    const unhandled = jest.fn();
    process.on('unhandledRejection', unhandled);

    // A rejecting timer callback is an unhandled rejection, which on a modern
    // Node exits the process — so the IAM would die because a sweep could not
    // reach the database. Nothing here is load-bearing enough for that: the
    // bindings stay unclaimed and the next tick retries them.
    job.onApplicationBootstrap();
    jest.advanceTimersByTime(60_000);
    await Promise.resolve();
    await Promise.resolve();

    process.off('unhandledRejection', unhandled);
    expect(unhandled).not.toHaveBeenCalled();
    job.onApplicationShutdown();
  });
});
