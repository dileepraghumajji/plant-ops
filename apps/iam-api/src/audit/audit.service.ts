/**
 * The Nest-side audit layer over `iam.write_audit` (Doc 10 §3).
 *
 * ## One path, and what that buys
 *
 * Before this service, four call sites wrote audit rows by hand — the same
 * `select iam.write_audit($1, …)` copied into `SessionService`,
 * `AccountStateService` and `ServiceAccountsService`, each with its own action
 * string and its own idea of what belonged in the payload. Nothing was wrong
 * with any of them, which is precisely the problem: correctness that lives in
 * four places is correctness that stops holding the first time somebody adds a
 * fifth. Doc 10 §8's "redact at the `AuditService` boundary" is not enforceable
 * unless there *is* a boundary.
 *
 * So every mutation audit now goes through {@link AuditService.record}, and the
 * three properties the spec asks for are properties of the method rather than
 * of each caller's discipline:
 *
 * 1. **Same transaction as the change** (Doc 10 §3). `record` runs on
 *    `entityManager()` — the ambient request transaction — and nothing else. It
 *    takes no executor parameter, so there is no way to hand it a pooled
 *    connection by accident, and outside a transaction it throws rather than
 *    quietly falling back to one. A rolled-back business transaction therefore
 *    leaves no audit row, and a committed change always has one.
 * 2. **Redacted** (Doc 10 §8). The payload passes through `redactPayload`, with
 *    no parameter that skips it.
 * 3. **From the catalog** (Doc 10 §4). `action` is an {@link AuditAction}, so a
 *    misspelling does not compile.
 *
 * What this service deliberately does *not* do is decide the actor or the
 * tenant. Those are derived inside `iam.write_audit` from the session context
 * the verified token established (migration 0010) — there is no parameter for
 * them, so no service can misattribute a record even by trying.
 *
 * ## Denials are the exception, and they are shaped differently on purpose
 *
 * Doc 10 §3: for denials "a lightweight guard-level writer records the attempt
 * (these may be outside a business transaction — best-effort but should not be
 * silently dropped)". {@link AuditService.recordDenial} is that writer, and
 * every difference from `record` follows from one fact: **a denied request ends
 * by throwing**, so the interceptor rolls its transaction back on the way out.
 * An `authz.permission_denied` written inside it would vanish along with the
 * 403 — silently, and for exactly the events an operator most wants to find.
 *
 * It therefore commits on its own connection, in its own transaction, with the
 * RLS context applied from the same verified claims the request carried — so
 * the row is still attributed to the subject who attempted the thing, rather
 * than to the contextless nobody a bare pooled connection would produce. A
 * failure to write is logged loudly and swallowed: the denial itself is the
 * security-relevant outcome, and turning a lost audit row into a 500 would tell
 * a caller which requests were refused for which reason.
 *
 * That shape is wrong for anything that accompanies a change, which is why the
 * action type is narrowed to the two authorization actions.
 *
 * ## Actions this service cannot write, and why that is fine
 *
 * `auth.login.*`, `auth.refresh.*`, the password-reset pair and the
 * failed-attempt lock are emitted from inside migrations 0012–0015. They are
 * pre-authentication paths with no RLS context to write under, and each record
 * has to be atomic with a decision made in the same statement — a login failure
 * counted but not audited, or a reuse detected but not recorded, is the failure
 * mode those functions exist to rule out. Consolidating them here would mean
 * moving the decision out of the database, which Session 8–11 argued at length
 * against. The catalog covers them so the vocabulary stays single (see
 * `audit-actions.ts`); the writer does not, and should not.
 */

import { Injectable, Logger } from '@nestjs/common';
import { IAM_SCHEMA, applyRlsContext, type VerifiedClaims } from '@plantops/db';
import { entityManager } from '../common/transaction-context';
import { DatabaseService } from '../database/database.service';
import type { AuditAction, AuditTarget, DenialAuditAction } from './audit-actions';
import { redactPayload, type AuditPayload } from './redact';

const S = `"${IAM_SCHEMA}"`;

const WRITE_AUDIT = `select ${S}.write_audit($1, $2, $3, $4::jsonb)`;

@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(private readonly database: DatabaseService) {}

  /**
   * Records one action, in the caller's transaction (Doc 10 §3).
   *
   * Call it beside the write it describes, never after the response: if the
   * change rolls back this must roll back with it, and if this throws the
   * change must not stand. Both directions are the same requirement — that a
   * committed change and its record are one atomic fact — and both come free
   * from running on the ambient transaction.
   *
   * @throws when there is no transaction in scope. That is a wiring bug (a
   * handler that opted out with `@SkipTransaction()`, or work started after the
   * response), and failing is the only safe answer: the alternative is an audit
   * row on a pooled connection with no tenant context, which `write_audit`
   * would attribute to nobody.
   */
  async record(
    action: AuditAction,
    target: AuditTarget,
    payload: AuditPayload = {},
  ): Promise<void> {
    await entityManager().query(WRITE_AUDIT, [
      action,
      target.type,
      target.id,
      JSON.stringify(redactPayload(payload)),
    ]);
  }

  /**
   * Records an authorization denial, on its own connection (Doc 10 §3).
   *
   * For the `PermissionGuard` hook that arrives in Session 23 — a guard runs
   * before the request transaction exists, and the request it refuses is about
   * to be rolled back regardless. See the header for the full argument.
   *
   * Never throws. The caller is in the middle of refusing a request and has
   * nothing useful to do with a cache-or-database failure here; what it must
   * not do is turn a clean 403 into a 500.
   */
  async recordDenial(
    claims: VerifiedClaims,
    action: DenialAuditAction,
    target: AuditTarget,
    payload: AuditPayload = {},
  ): Promise<void> {
    const runner = this.database.dataSource.createQueryRunner();
    try {
      await runner.connect();
      await runner.startTransaction();
      try {
        // The same derivation every request gets, on this connection: the
        // context is transaction-local, so it exists for this insert and is
        // gone when the connection returns to the pool.
        await applyRlsContext(runner.manager, claims);
        await runner.manager.query(WRITE_AUDIT, [
          action,
          target.type,
          target.id,
          JSON.stringify(redactPayload(payload)),
        ]);
        await runner.commitTransaction();
      } catch (error) {
        if (runner.isTransactionActive) {
          await runner.rollbackTransaction().catch(() => undefined);
        }
        throw error;
      } finally {
        await runner.release();
      }
    } catch (error) {
      // Loud, because Doc 10 §3 asks that these not be *silently* dropped —
      // a denial nobody can find afterwards is the difference between an audit
      // trail and a log.
      this.logger.error(
        `Failed to record ${action} against ${target.type} ${target.id ?? '(none)'}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}
