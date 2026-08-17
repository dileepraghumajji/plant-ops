/**
 * Sessions and revocation (Doc 03 §6, Doc 06 §3).
 *
 * A `session` row is what makes a stateless access token revocable: `session.id`
 * *is* the `sid` claim, so killing the row and publishing the id is enough to
 * make every verifier in the fleet refuse tokens that were already issued. That
 * matters most for the case the spec singles out — a shared gate terminal
 * logged out at shift end, where the person holding the device is no longer the
 * person who logged in.
 *
 * ## Two kinds of database access, for one reason
 *
 * Most methods here run on the ambient request transaction, under the RLS
 * context the token established — so a caller physically cannot touch another
 * tenant's sessions, whatever this code gets wrong.
 *
 * {@link SessionService.begin}, {@link SessionService.rotateRefreshToken} and
 * {@link SessionService.isRevoked} cannot. `begin` runs during login, before any
 * token exists and therefore before any context does; `rotateRefreshToken` runs
 * during refresh, where the caller presents a refresh token rather than an
 * access token and so has no verified `cid` either; `isRevoked` runs inside
 * `AuthGuard`, which is *before* the transaction is opened at all. All three go
 * through the migration-0012 and -0013 definer functions, which are the
 * sanctioned pre-auth doorway — see those migrations for why they exist and what
 * keeps them narrow.
 *
 * ## Ordering: commit, then publish
 *
 * A revocation writes the row and publishes the `sid` to the cache **after**
 * the transaction commits. Publishing first would let a verifier reject a
 * session that a rollback then restores, and — worse in the other direction —
 * it is the same class of ordering bug as invalidating a grants cache before a
 * scope move commits (Doc 07 §7): a reader repopulates from pre-change state
 * and re-poisons the cache. Here the consequence is milder (a live session
 * briefly refused) but the discipline is the same one, so it is written the
 * same way.
 */

import { Inject, Injectable, Logger } from '@nestjs/common';
import type { RevocationCache, RevocationFallback } from '@plantops/auth-kit';
import type { EnvConfig } from '@plantops/config';
import {
  SubjectType,
  type JwtClaims,
  type SessionDTO,
} from '@plantops/contracts';
import { IAM_SCHEMA, type RefreshOutcome, type VerifiedClaims } from '@plantops/db';
import { ENV } from '../config/config.module';
import type { AuditAction } from '../audit/audit-actions';
import { AuditService } from '../audit/audit.service';
import { afterCommit, entityManager } from '../common/transaction-context';
import { DatabaseService } from '../database/database.service';
import { REVOCATION_CACHE } from './revocation.provider';
import {
  formatRefreshToken,
  hashRefreshSecret,
  mintRefreshSecret,
} from './refresh-token.util';

const S = `"${IAM_SCHEMA}"`;

export interface BeginSessionInput {
  clientId: string;
  userId: string;
  /** e.g. "Gate-3 Terminal" — optional, and the only caller-supplied field. */
  deviceLabel?: string | null;
}

export interface StartedSession {
  sessionId: string;
  /** The only time the raw refresh token exists outside the caller's hands. */
  refreshToken: string;
  refreshExpiresAt: Date;
}

interface SessionRow {
  id: string;
  device_label: string | null;
  issued_at: Date;
  expires_at: Date;
  revoked_at: Date | null;
}

export interface RotateRefreshInput {
  /** From the token itself — an address, not a claim of identity. */
  sessionId: string;
  /** The secret half of the token the client presented. */
  presentedSecret: string;
  /** The secret to install if — and only if — this turns out to be a rotation. */
  successorSecret: string;
}

/** One row of `iam.auth_rotate_refresh_token`. */
interface RotationRow {
  outcome: RefreshOutcome;
  client_id: string | null;
  user_id: string | null;
}

/**
 * What the database decided.
 *
 * The subject is present on every outcome that has one, and absent on `invalid`
 * — where there is no session, and therefore nobody to name. Modelled as a union
 * so a caller cannot reach for a `clientId` on the branch that does not have
 * one.
 */
export type RotationResult =
  | { outcome: 'invalid' }
  | {
      outcome: Exclude<RefreshOutcome, 'invalid'>;
      clientId: string;
      userId: string;
    };

@Injectable()
export class SessionService implements RevocationFallback {
  private readonly logger = new Logger(SessionService.name);

  constructor(
    @Inject(ENV) private readonly env: EnvConfig,
    @Inject(REVOCATION_CACHE) private readonly revocations: RevocationCache,
    private readonly audit: AuditService,
    private readonly database: DatabaseService,
  ) {}

  /**
   * Creates the session behind a successful login, and audits it.
   *
   * Returns `null` when the database declines — the user was locked or the
   * client suspended between the credential check and this call. The caller
   * turns that into the same generic 401 as a wrong password, because from the
   * outside it is the same thing: no session for you, and no reason given.
   *
   * The audit record is written *by the function*, not here, so
   * `auth.login.success` names an actor the database confirmed rather than one
   * this service asserted (Doc 07 §6).
   */
  async begin(input: BeginSessionInput): Promise<StartedSession | null> {
    const secret = mintRefreshSecret();
    const refreshExpiresAt = new Date(
      Date.now() + this.env.REFRESH_TOKEN_TTL_SECONDS * 1000,
    );

    const rows = (await entityManager().query(
      `select ${S}.auth_begin_session($1, $2, $3, $4, $5) as session_id`,
      [
        input.clientId,
        input.userId,
        hashRefreshSecret(secret),
        refreshExpiresAt.toISOString(),
        input.deviceLabel ?? null,
      ],
    )) as { session_id: string | null }[];

    const sessionId = rows[0]?.session_id ?? null;
    // The session id is prefixed to the token only now, because the database
    // generated it — which is why the *hash* above covers the secret alone
    // (see `refresh-token.util.ts`).
    return sessionId === null
      ? null
      : {
          sessionId,
          refreshToken: formatRefreshToken(sessionId, secret),
          refreshExpiresAt,
        };
  }

  /**
   * One rotation attempt, decided entirely inside the database (Doc 03 §4).
   *
   * The caller supplies the secret it was handed and the secret it would like
   * next; what comes back is which of the four things just happened. Every part
   * of that judgement — is the session live, is this the current generation, is
   * a one-generation-old token still inside its window, is this compromise —
   * belongs to `iam.auth_rotate_refresh_token`, and not because SQL is a nicer
   * language for it. Split across a read here and a write there, two concurrent
   * refreshes would both see the same current hash and both rotate, and each
   * client would walk away holding a token the other had already superseded. The
   * function's `select … for update` is what makes the race resolve to one
   * winner and one *recognised* loser.
   *
   * ## On the pool, not the request transaction
   *
   * Every other write in this service runs on the ambient transaction, so that a
   * failed request leaves nothing behind. This one must do the opposite, and for
   * the same reason `AuthService.recordFailure` does: three of its four outcomes
   * end in a thrown 401, the interceptor rolls the transaction back on the way
   * out, and the `reuse` branch's revocation and `auth.refresh.reuse_detected`
   * audit would roll back with it — silently discarding the response to a
   * detected compromise, which is precisely the event that must survive.
   *
   * There is nothing here for the rotation to be atomically coupled to anyway:
   * the function is one statement, and everything it decides and writes is
   * already inside it.
   */
  async rotateRefreshToken(input: RotateRefreshInput): Promise<RotationResult> {
    const rows = (await this.database.dataSource.query(
      `select * from ${S}.auth_rotate_refresh_token($1, $2, $3, $4)`,
      [
        input.sessionId,
        hashRefreshSecret(input.presentedSecret),
        hashRefreshSecret(input.successorSecret),
        this.env.REFRESH_REUSE_GRACE_SECONDS,
      ],
    )) as RotationRow[];

    const row = rows[0];
    // No row at all would mean the function did not run, not that it declined —
    // and "declined" is the only thing this method is allowed to guess.
    if (row === undefined) return { outcome: 'invalid' };

    return row.outcome === 'invalid'
      ? { outcome: 'invalid' }
      : {
          outcome: row.outcome,
          clientId: row.client_id as string,
          userId: row.user_id as string,
        };
  }

  /**
   * The subject's own sessions, newest first (Doc 06 §3).
   *
   * Scoped to the caller's subject as well as to their tenant. RLS already
   * confines the query to the tenant; the subject predicate is this service's
   * job, and there is no path by which one user lists another's — which is the
   * correct deny-by-default posture for a screen that exists to *kill* sessions,
   * and the reason the route can carry `@NoPermissionRequired()` honestly.
   */
  async listForSubject(claims: VerifiedClaims): Promise<SessionDTO[]> {
    const column = claims.sty === SubjectType.USER ? 'user_id' : 'service_account_id';

    const rows = (await entityManager().query(
      `select s.id, s.device_label, s.issued_at, s.expires_at, s.revoked_at
         from ${S}."session" s
        where s.${column} = $1
        order by s.issued_at desc`,
      [claims.sub],
    )) as SessionRow[];

    return rows.map((row) => toDto(row, claims.sid));
  }

  /**
   * Revokes one of the caller's own sessions.
   *
   * Returns false when no such session belongs to the caller — the controller
   * answers 404 for that, and it is deliberately the same 404 a session id from
   * another tenant produces. RLS makes the row invisible rather than forbidden,
   * so "not yours" and "does not exist" are indistinguishable here, which is
   * exactly the property Doc 06 §2 asks denials to have.
   *
   * Revoking an already-revoked session is a no-op that still succeeds:
   * `revoked_at` is never overwritten (a revocation time is a fact), and a
   * client retrying a force-logout should not be told it failed.
   */
  async revoke(
    sessionId: string,
    claims: VerifiedClaims,
    action: AuditAction,
  ): Promise<boolean> {
    const column = claims.sty === SubjectType.USER ? 'user_id' : 'service_account_id';

    // Wrapped in a CTE so the statement's command is SELECT. A bare
    // `update … returning` looks equivalent and is not: TypeORM's Postgres
    // driver returns `[rows, rowCount]` for UPDATE and DELETE, so the result is
    // a two-element array whatever happened — and `rows.length === 0` would
    // never be true, turning "no such session" into a silent success.
    const rows = (await entityManager().query(
      `with revoked as (
         update ${S}."session" s
            set revoked_at = coalesce(s.revoked_at, now())
          where s.id = $1
            and s.${column} = $2
          returning s.id
       )
       select id from revoked`,
      [sessionId, claims.sub],
    )) as { id: string }[];

    if (rows.length === 0) return false;

    await this.audit.record(action, { type: 'session', id: sessionId });

    // After COMMIT, never before: until the transaction lands there is no
    // revocation to announce, and a rollback would leave every verifier in the
    // fleet refusing a session that is still live.
    afterCommit(() => this.publishRevocations([sessionId]));
    return true;
  }

  /**
   * Revokes every live session a user has, and audits each one (Doc 03 §6).
   *
   * The force-logout behind a lock, a disable and a completed password reset —
   * "revoke all sessions for a user", which the spec lists precisely because a
   * state change that leaves existing sessions running changes nothing for
   * whoever is already inside.
   *
   * Runs on the request transaction, unlike the pre-auth paths above: every
   * caller of this is an *authenticated* administrative action, so the RLS
   * context exists and the revocation belongs to the same transaction as the
   * status change it accompanies. Publishing to the cache is the caller's job,
   * after that transaction commits — see {@link publishRevocations}.
   *
   * One audit row per session rather than one for the user. The session list is
   * a screen an administrator reads back (Doc 09), and "this device was logged
   * out at 14:02" is the thing they are looking for; a single aggregate row
   * would leave every individual session's ending unexplained. One *statement*
   * for all of them, though — `recordMany` writes the same rows the loop did,
   * without holding the transaction open across a round-trip per device.
   */
  async revokeAllForUser(userId: string, action: AuditAction): Promise<string[]> {
    // The same CTE shape as `revoke`, and for the same reason: TypeORM's
    // Postgres driver returns `[rows, rowCount]` for a bare UPDATE, so the
    // `returning` clause has to be wrapped to come back as rows.
    const rows = (await entityManager().query(
      `with revoked as (
         update ${S}."session" s
            set revoked_at = now()
          where s.user_id = $1
            and s.revoked_at is null
          returning s.id
       )
       select id from revoked`,
      [userId],
    )) as { id: string }[];

    await this.audit.recordMany(
      rows.map(({ id }) => ({ action, target: { type: 'session' as const, id } })),
    );

    return rows.map((row) => row.id);
  }

  /**
   * Publishes revoked `sid`s to the cache every verifier reads (Doc 03 §6).
   *
   * Best-effort by design. The database is authoritative — a session with
   * `revoked_at` set is dead whether or not the cache heard about it — and
   * {@link SessionService.isRevoked} is the fallback `AuthGuard` reaches for
   * when Redis cannot answer. So a failed publish is logged loudly and the
   * caller's operation still succeeds: the alternative is failing a completed
   * lockout because a cache was briefly unreachable, which would leave the
   * account locked in the database and the request reported as an error.
   *
   * Callers inside a transaction must defer this with `afterCommit`; callers on
   * the pool (the pre-auth paths) can call it directly, because their write has
   * already committed by the time they have the ids.
   */
  async publishRevocations(sessionIds: readonly string[]): Promise<void> {
    for (const sessionId of sessionIds) {
      try {
        await this.revocations.revoke(sessionId);
      } catch (error) {
        this.logger.error(
          `Session ${sessionId} was revoked in the database but not published to ` +
            `the revocation cache (${(error as Error).message}); verifiers will ` +
            'fall back to the database until the entry is written',
        );
      }
    }
  }

  /**
   * {@link RevocationFallback} — the authoritative answer, for `AuthGuard` to
   * use when Redis cannot give one.
   *
   * Runs on the pool rather than the request transaction, because the guard
   * executes before that transaction exists. It therefore goes through
   * `iam.session_is_revoked`, which supplies its own context.
   *
   * A **service** subject short-circuits to "not revoked". Its `sid` is
   * ephemeral and backed by no row at all (Doc 03 §5) — looking it up would
   * find nothing, read that absence as revoked, and kill every machine identity
   * for the duration of a cache outage. Their revocation model is the ≤5 minute
   * TTL and the next `/auth/token` exchange, not this table.
   */
  async isRevoked(claims: JwtClaims): Promise<boolean> {
    if (claims.sty === SubjectType.SERVICE) return false;

    const rows = (await this.database.dataSource.query(
      `select ${S}.session_is_revoked($1) as revoked`,
      [claims.sid],
    )) as { revoked: boolean }[];

    return rows[0]?.revoked ?? true;
  }
}

function toDto(row: SessionRow, currentSid: string): SessionDTO {
  return {
    id: row.id,
    device_label: row.device_label,
    issued_at: row.issued_at.toISOString(),
    expires_at: row.expires_at.toISOString(),
    revoked_at: row.revoked_at?.toISOString() ?? null,
    current: row.id === currentSid,
  };
}
