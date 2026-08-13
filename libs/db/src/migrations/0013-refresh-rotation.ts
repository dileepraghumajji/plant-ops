/**
 * 0013 — refresh-token rotation, reuse detection, and the grace window
 * (Doc 03 §4).
 *
 * ## What the two new columns are for
 *
 * Rotation on its own is easy: replace `refresh_token_hash` and hand the client
 * a new token. What makes it hard is that two legitimate clients on one session
 * — a phone and a desktop, or two browser tabs — can present the *same* current
 * token milliseconds apart. Whichever one loses the race then holds a token the
 * server has already replaced, and naive reuse detection reads that as theft and
 * kills a live session.
 *
 * So a rotation remembers what it replaced. `previous_refresh_token_hash` plus
 * `rotated_at` is the whole grace state Doc 03 §4 asks for: the token one
 * generation back, and when it stopped being current. Presented inside the
 * window it is a race, presented outside it is a replay, and the row itself is
 * what tells the two apart. Both columns move together — a previous hash with no
 * rotation time is a window with no clock — which is what
 * `session_rotation_state` enforces.
 *
 * ## Why the decision belongs in the database
 *
 * `auth_rotate_refresh_token` takes the same shape, and exists for the same
 * reason, as the migration-0012 login functions: refresh is a *pre*-auth path —
 * the caller presents a refresh token, not an access token, so there is no
 * verified `cid` and therefore no RLS context to read the `session` row under.
 * See 0012's header for why the alternatives (context from the request body,
 * `BYPASSRLS`, opening the tables to an unset context) are all worse than the
 * problem.
 *
 * It also has to be **one statement's worth of atomic**. Read-then-write from
 * the application would let two concurrent refreshes both read the same current
 * hash and both rotate, leaving each client holding a token the other's write
 * had already superseded. The `select … for update` here serialises them: the
 * second waits, re-reads the row the first committed, and correctly sees its own
 * token as one generation old and inside the window.
 *
 * ## Revoking on a hash that matches nothing
 *
 * A token that matches neither generation revokes the session. That is Doc 03
 * §4's "older than one generation" case, and it is deliberately the same branch
 * as a plainly wrong secret: the two are indistinguishable from here — an
 * older generation's hash is not stored anywhere — and both mean somebody is
 * presenting something they should not have. Refusing without revoking would
 * leave a session alive whose token is demonstrably in the wrong hands.
 *
 * The session id travels in the refresh token itself (see
 * `refresh-token.util.ts`), which is what makes the session findable at all when
 * the hash matches nothing. It is not a secret — it is already the `sid` claim
 * of the access token the same client holds — so this widens nothing: anyone who
 * can name a session id already holds a token for it, and could log it out.
 */

import type { MigrationInterface, QueryRunner } from 'typeorm';
import { IAM_SCHEMA } from '../schema.js';
import { APP_GROUP_ROLE } from './0007-rls-tenant.js';

const S = `"${IAM_SCHEMA}"`;

export const AUTH_ROTATE_REFRESH_TOKEN_SIGNATURE =
  'auth_rotate_refresh_token(uuid,text,text,integer)';

/**
 * What `auth_rotate_refresh_token` can answer. A closed set, because the caller
 * branches on it — including into a 401 that must not be reachable by accident.
 */
export const REFRESH_OUTCOMES = [
  'rotated',
  'replay',
  'stale',
  'reuse',
  'invalid',
] as const;
export type RefreshOutcome = (typeof REFRESH_OUTCOMES)[number];

/**
 * The Doc 10 §4 action strings this function writes.
 *
 * Exported rather than re-typed at each call site: the literals live in the SQL
 * body below (the function, not the caller, decides what it recorded — Doc 07
 * §6), and a test asserting on a string it spelled itself proves nothing.
 */
export const REFRESH_AUDIT_ACTIONS = {
  ROTATED: 'auth.refresh.rotated',
  REUSE_DETECTED: 'auth.refresh.reuse_detected',
} as const;

export class RefreshRotation1786406400013 implements MigrationInterface {
  name = 'RefreshRotation1786406400013';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ── 1. Grace state on the session row ─────────────────────────────────
    //
    // Not indexed, and that is not an omission. Session 8 looked a session up
    // *by* its refresh-token hash; from here the lookup is by primary key,
    // because the session id travels inside the token. The 0004 unique index on
    // `refresh_token_hash` stays as the integrity constraint it always also was
    // — two live sessions must never share a token — and this column needs no
    // equivalent, since a hash that is one generation old is only ever compared
    // against the row already in hand.
    await queryRunner.query(`
      alter table ${S}."session"
        add column previous_refresh_token_hash text,
        add column rotated_at                  timestamptz;
    `);

    // The pair is the window; half of it is a bug. A previous hash without a
    // rotation time has no window to be inside, and a rotation time without a
    // previous hash describes a generation nothing can present.
    await queryRunner.query(`
      alter table ${S}."session"
        add constraint session_rotation_state
        check ((previous_refresh_token_hash is null) = (rotated_at is null));
    `);

    // ── 2. The rotation decision ──────────────────────────────────────────
    //
    // Note what is *not* updated: `expires_at`. A rotation issues a new token
    // within a session, not a new session, so the row keeps the absolute expiry
    // login gave it. Sliding it on every refresh would make a session that is
    // refreshed every quarter of an hour immortal — and a stolen token that is
    // being diligently rotated is exactly the one that should still hit a wall.
    // The practical effect is that a refresh token's usable life is the shorter
    // of its own TTL and what remains of the session.
    await queryRunner.query(`
      create or replace function ${S}.auth_rotate_refresh_token(
        _session_id     uuid,
        _presented_hash text,
        _new_hash       text,
        _grace_seconds  integer
      ) returns table (
        outcome   text,
        client_id uuid,
        user_id   uuid
      )
      language plpgsql
      security definer
      set search_path = ${IAM_SCHEMA}, pg_temp
      as $fn$
      declare
        _prev_client   text := coalesce(current_setting('app.current_client_id', true), '');
        _prev_user     text := coalesce(current_setting('app.current_user_id', true), '');
        _prev_platform text := coalesce(current_setting('app.is_platform_admin', true), '');
        _session       record;
        _outcome       text;
      begin
        -- The elevation is the platform flag rather than a tenant, because the
        -- tenant is what this call is being asked to find: all the caller has is
        -- a session id out of an unauthenticated request body.
        perform set_config('app.is_platform_admin', 'true', true);

        select s.client_id,
               s.user_id,
               s.refresh_token_hash,
               s.previous_refresh_token_hash,
               s.rotated_at,
               s.revoked_at,
               s.expires_at
          into _session
          from ${S}."session" s
         where s.id = _session_id
           -- Service tokens carry an ephemeral sid backed by no row, and a
           -- session-backed one is issued without a refresh token (Doc 03 §5).
           -- Either way there is nothing here to rotate.
           and s.user_id is not null
         for update;

        if not found then
          perform set_config('app.is_platform_admin', _prev_platform, true);
          return query select 'invalid'::text, null::uuid, null::uuid;
          return;
        end if;

        -- Down from platform authority onto the tenant the row itself names.
        -- Derived, never taken from a parameter: this is what makes the audit
        -- rows below name an actor the database confirmed (Doc 07 §6).
        perform set_config('app.current_client_id', _session.client_id::text, true);
        perform set_config('app.current_user_id', _session.user_id::text, true);
        perform set_config('app.is_platform_admin', 'false', true);

        if _session.revoked_at is not null or _session.expires_at <= now() then
          -- A dead session is not a compromise, and must not be audited as one.
          -- This is also the branch that makes the revoked-sid cache's one
          -- honest gap (an evicted key) close on the next refresh: the row is
          -- authoritative even when the cache has forgotten.
          _outcome := 'invalid';

        elsif _session.refresh_token_hash is not null
          and _session.refresh_token_hash = _presented_hash then
          update ${S}."session"
             set previous_refresh_token_hash = refresh_token_hash,
                 refresh_token_hash          = _new_hash,
                 rotated_at                  = now()
           where id = _session_id;

          perform ${S}.write_audit(
            '${REFRESH_AUDIT_ACTIONS.ROTATED}', 'session', _session_id, '{}'::jsonb
          );
          _outcome := 'rotated';

        elsif _session.previous_refresh_token_hash = _presented_hash
          and _session.rotated_at > now() - make_interval(secs => _grace_seconds) then
          -- The race, not a replay: this client presented the token that was
          -- current when it started, and is entitled to the successor the
          -- winning request installed.
          --
          -- Which is why _new_hash is read here rather than written. The caller
          -- cannot hand back a successor it does not have, so it arrives holding
          -- a *proposal* — agreed with every other request racing this token,
          -- but agreed outside the database (see refresh-replay.cache.ts). This
          -- is the one place that can say whether the proposal is in fact what
          -- got installed. It is, when the winner's rotation was part of the
          -- same agreement; it is not, when that rotation happened somewhere the
          -- agreement could not reach — leaving a caller about to issue a
          -- credential no session has ever heard of.
          _outcome := case
            when _session.refresh_token_hash = _new_hash then 'replay'
            else 'stale'
          end;

        else
          update ${S}."session"
             set revoked_at = coalesce(revoked_at, now())
           where id = _session_id;

          perform ${S}.write_audit(
            '${REFRESH_AUDIT_ACTIONS.REUSE_DETECTED}', 'session', _session_id, '{}'::jsonb
          );
          _outcome := 'reuse';
        end if;

        perform set_config('app.current_client_id', _prev_client, true);
        perform set_config('app.current_user_id', _prev_user, true);
        perform set_config('app.is_platform_admin', _prev_platform, true);

        return query select _outcome, _session.client_id, _session.user_id;
      end;
      $fn$;
    `);

    // As in 0012: strip the implicit `execute to public` that would otherwise
    // hand a SECURITY DEFINER path to every role in the cluster (Doc 07 §6).
    await queryRunner.query(
      `revoke all on function ${S}.${AUTH_ROTATE_REFRESH_TOKEN_SIGNATURE} from public;`,
    );
    await queryRunner.query(
      `grant execute on function ${S}.${AUTH_ROTATE_REFRESH_TOKEN_SIGNATURE} to ${APP_GROUP_ROLE};`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `drop function if exists ${S}.${AUTH_ROTATE_REFRESH_TOKEN_SIGNATURE};`,
    );
    await queryRunner.query(
      `alter table ${S}."session" drop constraint if exists session_rotation_state;`,
    );
    await queryRunner.query(`
      alter table ${S}."session"
        drop column if exists rotated_at,
        drop column if exists previous_refresh_token_hash;
    `);
  }
}
