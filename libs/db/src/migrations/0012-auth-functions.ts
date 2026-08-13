/**
 * 0012 — the pre-authentication data path (Doc 03 §3, Doc 07 §5–6).
 *
 * ## The problem this migration exists to solve
 *
 * Every table login touches — `client`, `user`, `user_identity`, `session` —
 * carries `force row level security`, and every one of their policies keys off
 * `app.current_client_id` (Doc 07 §6). Login has no such context: there is no
 * token yet, and the tenant is named by a *request body field* (`client_slug`),
 * which Doc 07 §5 PROVENANCE forbids as a source for the RLS context in the
 * strongest terms available. So the app role, correctly, can read nothing and
 * write nothing before a token exists.
 *
 * The tempting fixes are all worse than the problem:
 *
 * - Setting `app.current_client_id` from the login body is the exact hole the
 *   PROVENANCE rule names, and the lint gate rejects it.
 * - Granting the app role `BYPASSRLS`, or making it a table owner, disables
 *   isolation everywhere to serve one endpoint (Doc 07 §5.1).
 * - Opening the tables to an unset context turns "no context" from *deny all*
 *   into *allow all*, inverting the safe default across the entire schema.
 *
 * What is left is the shape Doc 07 §6 already uses for audit: a small number of
 * `SECURITY DEFINER` functions that are the *only* pre-auth doorway, each doing
 * one named thing, each auditable in isolation. The app role gets `execute` on
 * these and nothing else changes.
 *
 * ## Why they still have to set a context
 *
 * `SECURITY DEFINER` runs as the function's owner — and `force row level
 * security` applies to the owner too (Doc 07 §5.1). That is deliberate and it
 * is what makes the FORCE meaningful, but it means these functions are subject
 * to the same policies as everyone else. So each one sets the context it needs,
 * transaction-locally, and **restores the caller's previous values before
 * returning**. Two properties make that safe:
 *
 * 1. The values are derived *inside* the function from rows it has just read,
 *    never taken from a parameter that names a tenant to trust. The one
 *    exception, `auth_begin_session`, re-validates its arguments against the
 *    database before using them (see there).
 * 2. On any error the whole surrounding transaction aborts — the request
 *    wrapper rolls it back — so there is no path on which an elevated context
 *    survives into later work. Only the success path needs the restore, and it
 *    has it.
 *
 * ## What the app still decides
 *
 * Password verification. argon2id lives in Node (Doc 03 §7), so
 * {@link AUTH_LOOKUP_PASSWORD_IDENTITY_SIGNATURE} hands the stored hash back to
 * the caller. That is the one secret crossing this boundary, and it crosses it
 * because the alternative — an argon2 implementation inside Postgres — does not
 * exist. It is never logged, never audited, and never leaves the auth service.
 */

import type { MigrationInterface, QueryRunner } from 'typeorm';
import { IAM_SCHEMA } from '../schema.js';
import { APP_GROUP_ROLE } from './0007-rls-tenant.js';

const S = `"${IAM_SCHEMA}"`;

/** Signatures, so grants and the drop path cannot drift from the definitions. */
export const AUTH_LOOKUP_PASSWORD_IDENTITY_SIGNATURE =
  'auth_lookup_password_identity(text,text)';
export const AUTH_BEGIN_SESSION_SIGNATURE =
  'auth_begin_session(uuid,uuid,text,timestamptz,text)';
export const AUTH_RECORD_LOGIN_FAILURE_SIGNATURE =
  'auth_record_login_failure(text,text,text)';
export const SESSION_IS_REVOKED_SIGNATURE = 'session_is_revoked(uuid)';

const AUTH_FUNCTION_SIGNATURES = [
  AUTH_LOOKUP_PASSWORD_IDENTITY_SIGNATURE,
  AUTH_BEGIN_SESSION_SIGNATURE,
  AUTH_RECORD_LOGIN_FAILURE_SIGNATURE,
  SESSION_IS_REVOKED_SIGNATURE,
] as const;

/**
 * The reason codes `auth.login.failed` may carry (Doc 03 §3: "always audit
 * failures with reason code").
 *
 * A closed set, enforced inside the function rather than trusted from the
 * caller: audit is queried by action *and* payload, and a free-text reason is a
 * field that cannot be filtered on six months later. It is also the one string
 * a caller supplies that reaches a stored row, so bounding it keeps the shape
 * of the audit table decided here rather than at each call site.
 */
export const LOGIN_FAILURE_REASONS = [
  'unknown_client',
  'unknown_user',
  'bad_password',
  'account_locked',
  'account_disabled',
  'client_suspended',
] as const;
export type LoginFailureReason = (typeof LOGIN_FAILURE_REASONS)[number];

const REASON_LIST = LOGIN_FAILURE_REASONS.map((reason) => `'${reason}'`).join(', ');

export class AuthFunctions1786406400012 implements MigrationInterface {
  name = 'AuthFunctions1786406400012';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ── 1. Credential lookup ──────────────────────────────────────────────
    //
    // One row per *client*, so the caller can tell "no such tenant" from "no
    // such user in this tenant" — a distinction the login service needs for the
    // audit reason code and then deliberately throws away before answering
    // (Doc 03 §3: unknown user and bad password are the same 401).
    //
    // The elevation is the platform flag rather than a tenant, because the
    // tenant is what this function is being asked to find. It is dropped again
    // before returning.
    await queryRunner.query(`
      create or replace function ${S}.auth_lookup_password_identity(
        _client_slug text,
        _email       text
      ) returns table (
        client_id     uuid,
        client_status text,
        user_id       uuid,
        user_status   text,
        secret_hash   text
      )
      language plpgsql
      security definer
      set search_path = ${IAM_SCHEMA}, pg_temp
      as $fn$
      declare
        _prev_platform text := coalesce(current_setting('app.is_platform_admin', true), '');
      begin
        perform set_config('app.is_platform_admin', 'true', true);

        return query
          select c.id,
                 c.status::text,
                 u.id,
                 u.status::text,
                 ui.secret_hash
            from ${S}."client" c
            -- Emails are stored lowercased (migration 0003 rejects anything
            -- else), so the comparison is normalised on the input side only.
            left join ${S}."user" u
              on u.client_id = c.id
             and u.email = lower(btrim(_email))
            left join ${S}."user_identity" ui
              on ui.user_id = u.id
             and ui.provider = 'password'
           where c.slug = _client_slug;

        perform set_config('app.is_platform_admin', _prev_platform, true);
      end;
      $fn$;
    `);

    // ── 2. Session creation ───────────────────────────────────────────────
    //
    // This is the one function that takes a tenant as a parameter, because by
    // the time it is called the caller has established the identity that
    // parameter describes. Two things keep that from being a trust hole:
    //
    // - It re-derives the state it depends on. The (user, client) pair must
    //   exist, the user must be `active` and the client `active`, checked here
    //   and not merely upstream. A user locked between the credential lookup
    //   and this call gets no session.
    // - The audit row is written by this function, not by the caller, through
    //   `iam.write_audit` with the context set to the row just validated. So
    //   `auth.login.success` names an actor the database confirmed — there is
    //   no parameter through which a caller could claim a different one
    //   (Doc 07 §6).
    //
    // It returns null rather than raising when the state check fails: raising
    // would abort the request transaction and surface as a 500, when the honest
    // answer is the same generic 401 every other login failure gets.
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
        -- Explicitly false: this path must never inherit platform authority
        -- from whatever the connection was last used for.
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

    // ── 3. Failed-login audit ─────────────────────────────────────────────
    //
    // Deliberately **not** routed through `iam.write_audit`, and this is the
    // only place in the schema that inserts into `audit_trail` directly.
    //
    // `write_audit` derives the actor from the session context, which is
    // exactly right everywhere an actor is known. Here nobody is authenticated
    // — that is what failed — so the context is empty and `write_audit` would
    // stamp `actor_type = 'service_account'`, which is not merely imprecise but
    // false: it would file a human's failed password attempt under machine
    // identities and make the audit read wrong at exactly the moment someone is
    // reading it to investigate.
    //
    // The forgery properties are preserved by giving the caller nothing to
    // forge with: the action and the actor type are literals in the body, the
    // actor id is unconditionally null, the tenant is looked up from the slug
    // rather than accepted, and the reason is checked against a closed set.
    await queryRunner.query(`
      create or replace function ${S}.auth_record_login_failure(
        _client_slug text,
        _email       text,
        _reason      text
      ) returns void
      language plpgsql
      security definer
      set search_path = ${IAM_SCHEMA}, pg_temp
      as $fn$
      declare
        _prev_platform text := coalesce(current_setting('app.is_platform_admin', true), '');
        _client_id     uuid;
      begin
        if _reason not in (${REASON_LIST}) then
          raise exception 'auth_record_login_failure: unknown reason code %', _reason;
        end if;

        perform set_config('app.is_platform_admin', 'true', true);
        select c.id into _client_id from ${S}."client" c where c.slug = _client_slug;
        perform set_config('app.is_platform_admin', _prev_platform, true);

        -- The email is recorded because a failed-login trail with no subject is
        -- unusable for the thing it exists for — spotting an account under
        -- attack. It is an identifier, not a credential; the password never
        -- appears, in any form (Doc 10 §8).
        insert into ${S}."audit_trail"
          (client_id, actor_type, actor_id, action, target_type, target_id, payload)
        values
          (_client_id, 'user', null, 'auth.login.failed', null, null,
           jsonb_build_object('reason', _reason,
                              'email', lower(btrim(_email)),
                              'client_slug', _client_slug));
      end;
      $fn$;
    `);

    // ── 4. Authoritative revocation check ─────────────────────────────────
    //
    // The fallback behind the Redis revoked-`sid` cache (Doc 03 §6). It runs
    // from `AuthGuard`, which is *before* the request transaction exists — so
    // it must be answerable on a bare connection, with no context, which is
    // precisely what a definer function provides.
    //
    // Note the polarity: it answers "is this session **not** live?", so an
    // absent, expired or revoked session all read as revoked. Failing to a deny
    // is the only safe direction for a question asked when the cache is already
    // known to be broken.
    await queryRunner.query(`
      create or replace function ${S}.session_is_revoked(_sid uuid)
      returns boolean
      language plpgsql
      security definer
      set search_path = ${IAM_SCHEMA}, pg_temp
      as $fn$
      declare
        _prev_platform text := coalesce(current_setting('app.is_platform_admin', true), '');
        _live          boolean;
      begin
        perform set_config('app.is_platform_admin', 'true', true);

        select exists (
          select 1
            from ${S}."session" s
           where s.id = _sid
             and s.revoked_at is null
             and s.expires_at > now()
        ) into _live;

        perform set_config('app.is_platform_admin', _prev_platform, true);
        return not _live;
      end;
      $fn$;
    `);

    // Strip the implicit `execute to public` that comes with every new
    // function. Left in place, SECURITY DEFINER would hand these paths to every
    // role in the cluster (Doc 07 §6).
    for (const signature of AUTH_FUNCTION_SIGNATURES) {
      await queryRunner.query(`revoke all on function ${S}.${signature} from public;`);
      await queryRunner.query(
        `grant execute on function ${S}.${signature} to ${APP_GROUP_ROLE};`,
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const signature of [...AUTH_FUNCTION_SIGNATURES].reverse()) {
      await queryRunner.query(`drop function if exists ${S}.${signature};`);
    }
  }
}
