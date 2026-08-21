/**
 * The binding-expiry sweep (Doc 04 §7 last row, Doc 01 §4.5).
 *
 * ## What it is for, and what it is not for
 *
 * It is **not** what makes an expired binding stop working. `resolve()` filters
 * on `expires_at > now()` in SQL (Session 21), so the database stops honouring a
 * lapsed grant on the second it lapses, whether or not this job ever runs. A
 * deployment with the sweep disabled is still correct.
 *
 * What it fixes is the *cache*. A grants entry written a minute before expiry
 * carries the permission with no expiry information in it — Doc 04 §6's cached
 * shape is `{permissions, scopes, v}` and nothing more — so the subject keeps the
 * grant until the entry's TTL evicts it. Every other cause in the §7 table has a
 * mutation to hang an invalidation off; this one has only time passing, which
 * §7 notes "is not a hook". So the hook is manufactured: a timer that asks the
 * database what has lapsed since it last looked, and publishes the invalidation
 * the mutation would have.
 *
 * The effect is to replace a `GRANTS_CACHE_TTL_SECONDS` staleness bound with an
 * `EXPIRY_SWEEP_INTERVAL_SECONDS` one — ten minutes down to one, by default.
 *
 * ## Why it holds no state of its own
 *
 * "What has lapsed since I last looked" is answered by the row, not by this
 * class: migration 0016's `expiry_swept_at` is null until a sweep claims the
 * binding, and `for update skip locked` makes the claim atomic. So this job has
 * no cursor, no last-run timestamp and no leader election. It can be restarted,
 * run late, or run on every replica at once, and each binding is still audited
 * and invalidated exactly once. See the migration for the argument against the
 * timestamp-window alternative.
 *
 * ## Which connection it runs on
 *
 * The pool, directly — `DatabaseService.dataSource`, never `entityManager()`.
 * There is no request here and therefore no ambient transaction, and
 * `entityManager()` throws rather than falling back precisely so that this
 * distinction cannot be made by accident (`common/transaction-context.ts`).
 *
 * That also means no RLS context, which is why the work is inside
 * `iam.sweep_expired_bindings` — a `SECURITY DEFINER` function that supplies its
 * own, exactly as `AuthGuard`'s revocation check and the `auth_*` functions of
 * 0012–0015 do for the same reason (Doc 07 §5). This file does no SQL of its own
 * beyond calling it.
 *
 * ## Ordering, and why it is not `afterCommit`
 *
 * Every other caller of {@link GrantInvalidationService} defers its publish with
 * `afterCommit()`, because it is writing inside a request transaction that might
 * roll back. This one is not: the function call *is* the transaction — a single
 * statement, autocommitted by the pool — so by the time it returns rows, the
 * `expiry_swept_at` marks and the audit rows have already committed. Publishing
 * on the next line satisfies Doc 04 §7.1 rule 3 for the same reason
 * `SessionService.publishRevocations` may be called directly from the pre-auth
 * paths: there is no pending commit left to race.
 */

import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import type { EnvConfig } from '@plantops/config';
import { SubjectType } from '@plantops/contracts';
import { IAM_SCHEMA } from '@plantops/db';
import { ENV } from '../config/env.token';
import { DatabaseService } from '../database/database.service';
import {
  GrantInvalidationService,
  type TenantSubject,
} from './invalidation.service';

const S = `"${IAM_SCHEMA}"`;

/** One row of `iam.sweep_expired_bindings` — a binding it just claimed. */
interface SweptBindingRow {
  binding_id: string;
  binding_client_id: string;
  binding_user_id: string | null;
  binding_service_account_id: string | null;
}

/** What one pass did, for the log line and for the tests. */
export interface SweepResult {
  /** Bindings marked, audited and invalidated. */
  bindings: number;
  /** Distinct subjects whose cached grants were bumped. */
  subjects: number;
}

@Injectable()
export class ExpirySweepJob implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(ExpirySweepJob.name);
  private timer: NodeJS.Timeout | null = null;

  /**
   * Guards against a pass starting while the previous one is still running.
   *
   * The interval is a minute and a pass is normally an index scan over an empty
   * partial index, so overlap should never happen — but "should never" plus a
   * database hiccup is how a slow pass turns into an unbounded pile of
   * concurrent passes, each holding a connection. `skip locked` would keep them
   * *correct*; this keeps them from existing.
   */
  private running = false;

  constructor(
    @Inject(ENV) private readonly env: EnvConfig,
    private readonly database: DatabaseService,
    private readonly invalidation: GrantInvalidationService,
  ) {}

  onApplicationBootstrap(): void {
    const interval = this.env.EXPIRY_SWEEP_INTERVAL_SECONDS;

    if (interval === 0) {
      this.logger.log(
        'Binding-expiry sweep disabled (EXPIRY_SWEEP_INTERVAL_SECONDS=0); expired ' +
          'grants stay cached until GRANTS_CACHE_TTL_SECONDS evicts them',
      );
      return;
    }

    // `unref` so the timer never holds the process open. Without it a SIGTERM
    // during an idle minute would wait for the next tick before Node's event
    // loop could drain, which turns a fast shutdown into a slow one for no work.
    this.timer = setInterval(() => void this.tick(), interval * 1_000);
    this.timer.unref();

    this.logger.log(`Binding-expiry sweep every ${interval}s`);
  }

  onApplicationShutdown(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * One scheduled pass, with every error swallowed.
   *
   * A timer callback that rejects is an unhandled rejection, which on a modern
   * Node is a process exit — so the IAM would die because a sweep could not
   * reach Redis. Nothing here is load-bearing enough to justify that: a failed
   * pass leaves the bindings unclaimed (the marking and the audit are one
   * transaction with the read) and the next tick retries them.
   */
  private async tick(): Promise<void> {
    if (this.running) {
      this.logger.warn('Skipping a binding-expiry sweep; the previous pass is still running');
      return;
    }

    this.running = true;
    try {
      const result = await this.runOnce();
      if (result.bindings > 0) {
        this.logger.log(
          `Expired ${result.bindings} role binding(s); invalidated ${result.subjects} subject(s)`,
        );
      }
    } catch (error) {
      this.logger.error(
        `Binding-expiry sweep failed (${
          error instanceof Error ? error.message : String(error)
        }); retrying on the next interval`,
      );
    } finally {
      this.running = false;
    }
  }

  /**
   * Claims every newly-expired binding and invalidates its subject.
   *
   * Public because the tests drive it directly rather than waiting on a timer,
   * and because an operator running the sweep by hand after a long outage is a
   * reasonable thing to want. Idempotent: a second call with nothing newly
   * expired claims nothing and publishes nothing.
   *
   * Errors propagate here and are caught by {@link ExpirySweepJob.tick} — a
   * caller invoking this deliberately wants to know that it failed.
   */
  async runOnce(): Promise<SweepResult> {
    const rows = (await this.database.dataSource.query(
      `select binding_id, binding_client_id, binding_user_id, binding_service_account_id
         from ${S}.sweep_expired_bindings($1)`,
      [this.env.EXPIRY_SWEEP_BATCH_SIZE],
    )) as SweptBindingRow[];

    if (rows.length === 0) return { bindings: 0, subjects: 0 };

    // One event per binding rather than per subject, deliberately: `bindingId`
    // is what the `role_binding.expired` audit row the function just wrote
    // targets, so a log line and an audit record name the same thing. The
    // duplicate bumps two lapsed bindings of one subject produce are collapsed
    // by `bumpMany`'s own dedupe.
    const subjects = new Set<string>();
    for (const row of rows) {
      const subject: TenantSubject = {
        clientId: row.binding_client_id,
        ...(row.binding_user_id === null
          ? { type: SubjectType.SERVICE, id: row.binding_service_account_id as string }
          : { type: SubjectType.USER, id: row.binding_user_id }),
      };

      subjects.add(`${subject.clientId}:${subject.type}:${subject.id}`);

      await this.invalidation.publishAcrossTenants([subject], {
        cause: 'role_binding.expired',
        bindingId: row.binding_id,
      });
    }

    return { bindings: rows.length, subjects: subjects.size };
  }
}
