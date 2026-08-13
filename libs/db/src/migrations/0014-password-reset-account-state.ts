/**
 * 0014 — tokenized password reset, and the account-state machine that failed
 * logins drive (Doc 03 §7–8).
 *
 * ## Two mechanisms, one migration, because they share a row
 *
 * Password reset and failed-attempt lockout look unrelated until you notice
 * that both are decided on the `user` row, both run on the *pre*-authentication
 * path, and both end in the same place: sessions revoked and an audit record
 * that has to survive the 401 the caller is about to receive. Splitting them
 * across two migrations would split the lock they need over that row.
 *
 * ## Why the counter is a column and not a Redis key
 *
 * A lockout counter in a cache is a lockout that evicts. The whole point of
 * Doc 03 §8's `locked` state is that it *persists* — it is the "Account Locked
 * Users" list an administrator works from — and a threshold that resets itself
 * whenever memory gets tight is a credential-stuffing budget that refills on its
 * own. `failed_login_attempts` therefore lives on the row it locks, next to the
 * status it will set, and both move under one `select … for update`.
 *
 * The rate limiter in front of `/auth/login` is the other half of this and not a
 * substitute for it: that limit is per caller IP, so it bounds one attacker
 * against the whole tenant, while this bounds the whole internet against one
 * account. Neither covers the other's case.
 *
 * ## Why reset tokens get their own table
 *
 * A reset token is a credential that must be single-use, time-boxed and
 * revocable — three properties that are `used_at`, `expires_at` and a `delete`,
 * and none of which fit as columns on `user` without making "has an outstanding
 * reset" unrepresentable for a second concurrent request. The stored form is a
 * SHA-256 hash for the reason `refresh-token.util.ts` sets out at length: the
 * secret is 256 bits from a CSPRNG, so there is nothing for a work factor to
 * slow down, and the lookup is an equality comparison that a salt would break.
 *
 * The app role gets `select` on the table and nothing else. Every write — issue,
 * consume, invalidate — goes through the definer functions below, which is where
 * the audit record is written from, so there is no path that mints or spends a
 * reset token without recording it (Doc 07 §6).
 *
 * ## Locked, disabled, and what a reset does *not* do
 *
 * Reset is available to `active` accounts only. A locked account cannot reset
 * its way out of the lock: Doc 03 §8 makes locking an administrative state
 * ("Contact an administrator"), and an unlock-by-email path would hand the
 * decision back to whoever provoked the lock in the first place. A disabled
 * account is offboarded and gets nothing at all. Both refusals are silent — the
 * endpoint answers 202 either way (Doc 06 §3), because a reset request that
 * distinguishes states is the user-enumeration oracle login refuses to be.
 */

import type { MigrationInterface, QueryRunner } from 'typeorm';
import { IAM_SCHEMA } from '../schema.js';
import {
  AuthFunctions1786406400012,
  LOGIN_FAILURE_REASONS,
} from './0012-auth-functions.js';
import { APP_GROUP_ROLE, CTX_CLIENT_ID, CTX_IS_PLATFORM_ADMIN } from './0007-rls-tenant.js';

const S = `"${IAM_SCHEMA}"`;

/**
 * The same closed reason set 0012 pins, spelled from the same constant.
 *
 * Read from 0012 rather than restated: this migration replaces that function
 * body, and two independently-maintained copies of the vocabulary is how a
 * reason code becomes writable in one version and rejected in the other.
 */
const REASON_LIST = LOGIN_FAILURE_REASONS.map((reason) => `'${reason}'`).join(', ');

/** Signatures, so grants and the drop path cannot drift from the definitions. */
export const AUTH_RECORD_LOGIN_FAILURE_V2_SIGNATURE =
  'auth_record_login_failure(text,text,text,integer)';
export const AUTH_REQUEST_PASSWORD_RESET_SIGNATURE =
  'auth_request_password_reset(text,text,text,timestamptz)';
export const AUTH_COMPLETE_PASSWORD_RESET_SIGNATURE =
  'auth_complete_password_reset(text,text)';

/** The 0012 signature this migration replaces — dropped, not shadowed. */
const AUTH_RECORD_LOGIN_FAILURE_V1_SIGNATURE = 'auth_record_login_failure(text,text,text)';

const PASSWORD_RESET_FUNCTION_SIGNATURES = [
  AUTH_RECORD_LOGIN_FAILURE_V2_SIGNATURE,
  AUTH_REQUEST_PASSWORD_RESET_SIGNATURE,
  AUTH_COMPLETE_PASSWORD_RESET_SIGNATURE,
] as const;

/**
 * What `auth_complete_password_reset` can answer.
 *
 * Two values, and deliberately only two: an expired token, a spent one, a
 * token for a locked account and a string that matches nothing all come back
 * `invalid`, because the caller must not be able to tell them apart. The
 * distinction that matters is kept in the audit trail, not in the response.
 */
export const PASSWORD_RESET_OUTCOMES = ['completed', 'invalid'] as const;
export type PasswordResetOutcome = (typeof PASSWORD_RESET_OUTCOMES)[number];

/**
 * The Doc 10 §4 action strings this migration's functions and the account-state
 * service write.
 *
 * `auth.account.locked` / `auth.account.unlocked` are Doc 03 §9's names and are
 * used for *both* causes of a state change — the failed-attempt policy here, and
 * an administrator acting deliberately (Session 16's `PATCH /iam/users/:id`).
 * The event is the account's state changing; who caused it is already on the
 * row, in `actor_id` and `actor_type`, and splitting the vocabulary by actor
 * would mean querying two action names to answer "when was this account
 * locked?". Disabling keeps Doc 10 §4's `user.disabled`, which is the only name
 * either document gives it.
 */
export const ACCOUNT_AUDIT_ACTIONS = {
  PASSWORD_RESET_REQUESTED: 'auth.password.reset_requested',
  PASSWORD_RESET_COMPLETED: 'auth.password.reset_completed',
  ACCOUNT_LOCKED: 'auth.account.locked',
  ACCOUNT_UNLOCKED: 'auth.account.unlocked',
  ACCOUNT_DISABLED: 'user.disabled',
} as const;

/** The `payload.reason` an auto-lock carries, distinguishing it from a manual one. */
export const AUTO_LOCK_REASON = 'failed_attempts';

export class PasswordResetAccountState1786406400014 implements MigrationInterface {
  name = 'PasswordResetAccountState1786406400014';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ── 1. The lockout counter ────────────────────────────────────────────
    //
    // `last_failed_login_at` is not consulted by the policy — the threshold is
    // a plain count — and exists because an administrator looking at the
    // "Account Locked Users" list needs to know whether the attempts were an
    // attack last night or a forgotten password over three weeks. A time-decay
    // policy would read it; not having one is a deliberate v1 choice, since a
    // decaying counter is a lockout an attacker can simply wait out.
    await queryRunner.query(`
      alter table ${S}."user"
        add column failed_login_attempts integer not null default 0,
        add column last_failed_login_at  timestamptz;
    `);
    await queryRunner.query(`
      alter table ${S}."user"
        add constraint user_failed_login_attempts_not_negative
        check (failed_login_attempts >= 0);
    `);

    // ── 2. Reset-token storage ────────────────────────────────────────────
    await queryRunner.query(`
      create table ${S}."password_reset_token" (
        id         uuid        not null default gen_random_uuid(),
        client_id  uuid        not null,
        user_id    uuid        not null,
        -- SHA-256 of the token, never the token. See the header.
        token_hash text        not null,
        expires_at timestamptz not null,
        -- Set the moment the token is spent *or* superseded, which is what
        -- makes "single use" and "one outstanding token" the same mechanism.
        used_at    timestamptz,
        created_at timestamptz not null default now(),
        constraint password_reset_token_pkey primary key (id),
        -- The composite FK carries the tenant, as everywhere else (0003's
        -- header): a token cannot end up pointing at a user in another client.
        constraint password_reset_token_user_id_client_id_fkey
          foreign key (user_id, client_id) references ${S}."user" (id, client_id)
          on delete cascade,
        constraint password_reset_token_hash_not_blank
          check (length(btrim(token_hash)) > 0),
        constraint password_reset_token_expires_after_created
          check (expires_at > created_at)
      );
    `);
    // The lookup is by hash and nothing else — the token carries no id, because
    // unlike a refresh token there is no row that needs finding when the hash
    // matches nothing (0013's header explains why refresh is the exception).
    await queryRunner.query(`
      create unique index password_reset_token_token_hash_key
        on ${S}."password_reset_token" (token_hash);
    `);
    // Covers "invalidate this user's outstanding tokens", which runs on every
    // issue. Partial, because a spent token is never searched for again.
    await queryRunner.query(`
      create index password_reset_token_user_id_outstanding_idx
        on ${S}."password_reset_token" (user_id)
        where used_at is null;
    `);

    // Read-only for the app role. Writes are the definer functions' alone —
    // they are what pin the audit record to the token being minted or spent, and
    // a credential whose issuance can happen off that path is a credential with
    // no trail (Doc 07 §6).
    await queryRunner.query(
      `grant select on ${S}."password_reset_token" to ${APP_GROUP_ROLE};`,
    );
    await queryRunner.query(
      `alter table ${S}."password_reset_token" enable row level security;`,
    );
    await queryRunner.query(
      `alter table ${S}."password_reset_token" force row level security;`,
    );
    // The same asymmetric shape as every other tenant table (0007): platform
    // reads across tenants, writes stay pinned to the current client.
    await queryRunner.query(`
      create policy password_reset_token_tenant_isolation on ${S}."password_reset_token"
        using (
          ${CTX_IS_PLATFORM_ADMIN}
          or client_id = ${CTX_CLIENT_ID}
        )
        with check (
          client_id = ${CTX_CLIENT_ID}
        );
    `);

    // ── 3. Login failure, now with the lockout policy ─────────────────────
    //
    // Replaces the 0012 three-argument version, which is dropped rather than
    // left beside this one: two overloads of a SECURITY DEFINER function is two
    // paths that can drift, and the older one would be the one without the
    // policy.
    //
    // The threshold arrives as a parameter instead of being compiled in, because
    // it is deployment configuration (`LOGIN_MAX_FAILED_ATTEMPTS`) and the
    // alternative is a migration every time an operator retunes it. It cannot be
    // used to *weaken* anything a caller would want weakened — passing a large
    // number only makes the caller's own account harder to protect.
    //
    // Returns the sessions the lock revoked, because the revoked-`sid` cache
    // lives outside Postgres and only the caller can publish to it (Doc 03 §6).
    await queryRunner.query(`
      create or replace function ${S}.auth_record_login_failure(
        _client_slug   text,
        _email         text,
        _reason        text,
        _max_attempts  integer
      ) returns uuid[]
      language plpgsql
      security definer
      set search_path = ${IAM_SCHEMA}, pg_temp
      as $fn$
      declare
        _prev_client   text := coalesce(current_setting('app.current_client_id', true), '');
        _prev_platform text := coalesce(current_setting('app.is_platform_admin', true), '');
        _client_id     uuid;
        _user_id       uuid;
        _attempts      integer;
        _revoked       uuid[] := '{}';
      begin
        if _reason not in (${REASON_LIST}) then
          raise exception 'auth_record_login_failure: unknown reason code %', _reason;
        end if;

        perform set_config('app.is_platform_admin', 'true', true);
        select c.id into _client_id from ${S}."client" c where c.slug = _client_slug;

        -- Only a wrong password against a real, still-active account moves the
        -- counter. An unknown address must not, or the table becomes a
        -- write-amplification target for anyone who can spell a slug; an already
        -- locked or disabled account must not either, since its status is
        -- decided and counting further attempts would only delay the unlock.
        if _reason = 'bad_password' and _client_id is not null and _max_attempts > 0 then
          -- Down onto the tenant the client row itself named, so the writes
          -- below satisfy the same policies every other write does.
          perform set_config('app.current_client_id', _client_id::text, true);
          perform set_config('app.is_platform_admin', 'false', true);

          -- \`for update\` because two attempts arriving together would otherwise
          -- both read N and both write N+1, and the account that should have
          -- locked at the fifth attempt would survive the tenth.
          select u.id into _user_id
            from ${S}."user" u
           where u.client_id = _client_id
             and u.email = lower(btrim(_email))
             and u.status = 'active'
           for update;

          if _user_id is not null then
            update ${S}."user"
               set failed_login_attempts = failed_login_attempts + 1,
                   last_failed_login_at  = now()
             where id = _user_id
            returning failed_login_attempts into _attempts;

            if _attempts >= _max_attempts then
              -- The counter is zeroed as the status changes: it has done its
              -- job, and leaving it at the threshold would re-lock the account
              -- on the first failure after an unlock.
              update ${S}."user"
                 set status = 'locked',
                     failed_login_attempts = 0
               where id = _user_id;

              -- Doc 03 §6: locking force-logs-out everywhere. The person who
              -- can no longer log in must not still be logged in on the gate
              -- terminal they left running.
              with killed as (
                update ${S}."session"
                   set revoked_at = now()
                 where user_id = _user_id
                   and revoked_at is null
                returning id
              )
              select coalesce(array_agg(id), '{}') into _revoked from killed;

              -- Direct, not through \`write_audit\`, for the reason the failure
              -- row below is: nobody is authenticated here, so \`write_audit\`
              -- would derive \`actor_type = 'service_account'\` and file a
              -- policy lockout under machine identities. The actor is the same
              -- anonymous caller whose attempts caused it — attributable by
              -- target, not by identity.
              insert into ${S}."audit_trail"
                (client_id, actor_type, actor_id, action, target_type, target_id, payload)
              values
                (_client_id, 'user', null, '${ACCOUNT_AUDIT_ACTIONS.ACCOUNT_LOCKED}',
                 'user', _user_id,
                 jsonb_build_object('reason', '${AUTO_LOCK_REASON}',
                                    'attempts', _attempts));
            end if;
          end if;
        end if;

        perform set_config('app.is_platform_admin', _prev_platform, true);
        perform set_config('app.current_client_id', _prev_client, true);

        -- Unchanged from 0012, and still the only direct \`audit_trail\` insert
        -- the schema makes outside this function: the action, the actor type and
        -- the null actor id are literals here, the tenant is looked up rather
        -- than accepted, and the reason is checked against a closed set, so the
        -- caller has nothing to forge with. The password never appears, in any
        -- form (Doc 10 §8).
        insert into ${S}."audit_trail"
          (client_id, actor_type, actor_id, action, target_type, target_id, payload)
        values
          (_client_id, 'user', null, 'auth.login.failed', null, null,
           jsonb_build_object('reason', _reason,
                              'email', lower(btrim(_email)),
                              'client_slug', _client_slug));

        return _revoked;
      end;
      $fn$;
    `);
    await queryRunner.query(
      `drop function if exists ${S}.${AUTH_RECORD_LOGIN_FAILURE_V1_SIGNATURE};`,
    );

    // ── 4. Session creation clears the counter ────────────────────────────
    //
    // Same signature and same body as 0012's, plus the reset. It belongs here
    // rather than in the service because it has to be part of the same
    // transaction that proves the password was right: a counter cleared by a
    // separate statement is a counter that survives a login which then failed to
    // create a session.
    await queryRunner.query(`
      create or replace function ${S}.auth_begin_session(
        _client_id          uuid,
        _user_id            uuid,
        _refresh_token_hash text,
        _expires_at         timestamptz,
        _device_label       text
      ) returns uuid
      language plpgsql
      security definer
      set search_path = ${IAM_SCHEMA}, pg_temp
      as $fn$
      declare
        _prev_client   text := coalesce(current_setting('app.current_client_id', true), '');
        _prev_user     text := coalesce(current_setting('app.current_user_id', true), '');
        _prev_platform text := coalesce(current_setting('app.is_platform_admin', true), '');
        _session_id    uuid;
        _eligible      boolean;
      begin
        perform set_config('app.current_client_id', _client_id::text, true);
        perform set_config('app.current_user_id', _user_id::text, true);
        perform set_config('app.is_platform_admin', 'false', true);

        select exists (
          select 1
            from ${S}."user" u
            join ${S}."client" c on c.id = u.client_id
           where u.id = _user_id
             and u.client_id = _client_id
             and u.status = 'active'
             and c.status = 'active'
        ) into _eligible;

        if _eligible then
          insert into ${S}."session"
            (client_id, user_id, refresh_token_hash, expires_at, device_label)
          values
            (_client_id, _user_id, _refresh_token_hash, _expires_at, _device_label)
          returning id into _session_id;

          -- Guarded, so a login that changes nothing does not stamp
          -- \`updated_at\` on the user row every fifteen minutes.
          update ${S}."user"
             set failed_login_attempts = 0,
                 last_failed_login_at  = null
           where id = _user_id
             and (failed_login_attempts <> 0 or last_failed_login_at is not null);

          perform ${S}.write_audit(
            'auth.login.success',
            'session',
            _session_id,
            jsonb_build_object('device_label', _device_label)
          );
        end if;

        perform set_config('app.current_client_id', _prev_client, true);
        perform set_config('app.current_user_id', _prev_user, true);
        perform set_config('app.is_platform_admin', _prev_platform, true);

        return _session_id;
      end;
      $fn$;
    `);

    // ── 5. Reset request ──────────────────────────────────────────────────
    //
    // Returns whether a token was stored, which the caller needs in order to
    // decide whether there is anything to deliver — and which it must never turn
    // into a difference the *requester* can observe (Doc 06 §3: always 202).
    //
    // Issuing invalidates whatever was outstanding. One live token per account
    // is what makes "single use" mean anything: two tokens in two inboxes is two
    // chances for the wrong one to be the one that leaks.
    await queryRunner.query(`
      create or replace function ${S}.auth_request_password_reset(
        _client_slug text,
        _email       text,
        _token_hash  text,
        _expires_at  timestamptz
      ) returns boolean
      language plpgsql
      security definer
      set search_path = ${IAM_SCHEMA}, pg_temp
      as $fn$
      declare
        _prev_client   text := coalesce(current_setting('app.current_client_id', true), '');
        _prev_platform text := coalesce(current_setting('app.is_platform_admin', true), '');
        _client_id     uuid;
        _user_id       uuid;
      begin
        perform set_config('app.is_platform_admin', 'true', true);

        -- Active client, active user, or nothing happens. A suspended tenant's
        -- users must not be able to walk their way back in through email.
        select u.client_id, u.id into _client_id, _user_id
          from ${S}."user" u
          join ${S}."client" c on c.id = u.client_id
         where c.slug = _client_slug
           and c.status = 'active'
           and u.email = lower(btrim(_email))
           and u.status = 'active';

        if _user_id is null then
          perform set_config('app.is_platform_admin', _prev_platform, true);
          return false;
        end if;

        perform set_config('app.current_client_id', _client_id::text, true);
        perform set_config('app.is_platform_admin', 'false', true);

        update ${S}."password_reset_token"
           set used_at = now()
         where user_id = _user_id
           and used_at is null;

        insert into ${S}."password_reset_token"
          (client_id, user_id, token_hash, expires_at)
        values
          (_client_id, _user_id, _token_hash, _expires_at);

        -- Anonymous, like the failed-login row: anybody can ask for a reset on
        -- anybody's address, and recording the target as the requester would put
        -- a stranger's action in the account's own name. The email is an
        -- identifier, not a credential (Doc 10 §8), and it is what correlates
        -- this row with the \`auth.login.failed\` rows that usually precede it.
        insert into ${S}."audit_trail"
          (client_id, actor_type, actor_id, action, target_type, target_id, payload)
        values
          (_client_id, 'user', null, '${ACCOUNT_AUDIT_ACTIONS.PASSWORD_RESET_REQUESTED}',
           'user', _user_id,
           jsonb_build_object('email', lower(btrim(_email))));

        perform set_config('app.is_platform_admin', _prev_platform, true);
        perform set_config('app.current_client_id', _prev_client, true);
        return true;
      end;
      $fn$;
    `);

    // ── 6. Reset completion ───────────────────────────────────────────────
    //
    // One statement's worth of atomic, for the reason 0013's rotation is: the
    // token is spent, the secret is replaced and the sessions are killed
    // together, or a concurrent second presentation of the same token would find
    // it unspent and set a *second* password.
    //
    // Revoking every session is not incidental. A password is reset either
    // because it was forgotten or because it was compromised, and the second
    // case is the one that decides the behaviour: leaving live sessions alone
    // would mean the reset changes nothing for whoever is already inside.
    await queryRunner.query(`
      create or replace function ${S}.auth_complete_password_reset(
        _token_hash       text,
        _new_secret_hash  text
      ) returns table (
        outcome          text,
        revoked_sessions uuid[]
      )
      language plpgsql
      security definer
      set search_path = ${IAM_SCHEMA}, pg_temp
      as $fn$
      declare
        _prev_client   text := coalesce(current_setting('app.current_client_id', true), '');
        _prev_user     text := coalesce(current_setting('app.current_user_id', true), '');
        _prev_platform text := coalesce(current_setting('app.is_platform_admin', true), '');
        _token         record;
        _revoked       uuid[] := '{}';
        _outcome       text;
      begin
        -- Platform, because the token is all the caller has and the tenant is
        -- what this call is being asked to find.
        perform set_config('app.is_platform_admin', 'true', true);

        select t.id,
               t.client_id,
               t.user_id,
               t.used_at,
               t.expires_at,
               u.status as user_status,
               c.status as client_status
          into _token
          from ${S}."password_reset_token" t
          join ${S}."user" u   on u.id = t.user_id
          join ${S}."client" c on c.id = t.client_id
         where t.token_hash = _token_hash
         for update of t;

        if not found then
          perform set_config('app.is_platform_admin', _prev_platform, true);
          return query select 'invalid'::text, '{}'::uuid[];
          return;
        end if;

        perform set_config('app.current_client_id', _token.client_id::text, true);
        perform set_config('app.current_user_id', _token.user_id::text, true);
        perform set_config('app.is_platform_admin', 'false', true);

        if _token.used_at is not null
           or _token.expires_at <= now()
           or _token.user_status <> 'active'
           or _token.client_status <> 'active' then
          -- Not marked used: a token refused for an expiry or a lock has not
          -- been spent, and burning it here would let anyone who guessed a hash
          -- invalidate a live one.
          _outcome := 'invalid';
        else
          update ${S}."password_reset_token"
             set used_at = now()
           where id = _token.id;

          -- Upsert rather than update: a user created without a password (an
          -- invite flow, Session 16) has no password identity yet, and reset is
          -- exactly how they get one.
          insert into ${S}."user_identity"
            (client_id, user_id, provider, secret_hash)
          values
            (_token.client_id, _token.user_id, 'password', _new_secret_hash)
          on conflict (user_id, provider)
            do update set secret_hash = excluded.secret_hash;

          -- The person proved control of the address; whatever the counter said
          -- about their memory is no longer interesting.
          update ${S}."user"
             set failed_login_attempts = 0,
                 last_failed_login_at  = null
           where id = _token.user_id
             and (failed_login_attempts <> 0 or last_failed_login_at is not null);

          with killed as (
            update ${S}."session"
               set revoked_at = now()
             where user_id = _token.user_id
               and revoked_at is null
            returning id
          )
          select coalesce(array_agg(id), '{}') into _revoked from killed;

          -- Through \`write_audit\` this time, and attributed to the user: the
          -- token is a credential and presenting it is the closest thing to
          -- authentication this path has. The context was derived from the token
          -- row, never from a parameter, so the actor is one the database
          -- confirmed (Doc 07 §6).
          perform ${S}.write_audit(
            '${ACCOUNT_AUDIT_ACTIONS.PASSWORD_RESET_COMPLETED}',
            'user',
            _token.user_id,
            '{}'::jsonb
          );
          _outcome := 'completed';
        end if;

        perform set_config('app.current_client_id', _prev_client, true);
        perform set_config('app.current_user_id', _prev_user, true);
        perform set_config('app.is_platform_admin', _prev_platform, true);

        return query select _outcome, _revoked;
      end;
      $fn$;
    `);

    // As in 0012 and 0013: strip the implicit `execute to public` that would
    // otherwise hand a SECURITY DEFINER path to every role in the cluster.
    for (const signature of PASSWORD_RESET_FUNCTION_SIGNATURES) {
      await queryRunner.query(`revoke all on function ${S}.${signature} from public;`);
      await queryRunner.query(
        `grant execute on function ${S}.${signature} to ${APP_GROUP_ROLE};`,
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const signature of [...PASSWORD_RESET_FUNCTION_SIGNATURES].reverse()) {
      await queryRunner.query(`drop function if exists ${S}.${signature};`);
    }

    // `auth_begin_session` and `auth_record_login_failure` were *replaced*, not
    // created, so undoing this migration means putting 0012's definitions back —
    // and the only honest source for those is 0012 itself. Its `up` is
    // idempotent (`create or replace`, plus a revoke/grant loop), so re-running
    // it restores exactly the four functions it owns and nothing else.
    await new AuthFunctions1786406400012().up(queryRunner);

    await queryRunner.query(`
      drop policy if exists password_reset_token_tenant_isolation
        on ${S}."password_reset_token";
    `);
    await queryRunner.query(`drop table if exists ${S}."password_reset_token";`);

    await queryRunner.query(`
      alter table ${S}."user"
        drop constraint if exists user_failed_login_attempts_not_negative;
    `);
    await queryRunner.query(`
      alter table ${S}."user"
        drop column if exists last_failed_login_at,
        drop column if exists failed_login_attempts;
    `);
  }
}
