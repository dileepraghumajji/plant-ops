/**
 * 0015 — the client-credentials exchange's pre-authentication doorway
 * (Doc 03 §5).
 *
 * ## Why this is a migration at all
 *
 * `POST /auth/token` is in exactly the position `POST /auth/login` is, and for
 * the same reason (0012's header sets it out at length): the caller presents a
 * credential, not a token, so there is no verified `cid` and therefore no RLS
 * context — and `service_account` carries `force row level security` like every
 * other tenant table (0007). The app role can read nothing. The two functions
 * below are the sanctioned way in, each doing one named thing.
 *
 * Note what is *not* here. Creating, rotating and revoking a service account are
 * ordinary authenticated administrative writes: they run on the request
 * transaction under the caller's own RLS context and audit through
 * `iam.write_audit`, exactly as `AccountStateService` does. Only the exchange
 * needs elevation, because only the exchange happens before anybody is anybody.
 *
 * ## The tenant a platform-level account authenticates into
 *
 * `service_account.client_id` is nullable — null means platform-level (Doc 01
 * §3.7), which is what the bootstrap identity is (0011). But `cid` is a required
 * claim (Doc 03 §2) and the whole RLS context is derived from it (Doc 07 §5), so
 * a token with no tenant is not representable and should not be: a subject that
 * belongs to no tenant would read nothing and write nothing.
 *
 * The lookup therefore resolves the *effective* tenant — the account's own
 * client, or the platform client (0011) when it has none — and returns both. The
 * effective one becomes `cid`; the raw one stays null so an audit row for a
 * platform-level account is filed as the platform-level action it is (Doc 10
 * §2). This is what finally makes the bootstrap identity usable: it authenticates
 * into the platform tenant, where its `role_binding` sits, and
 * `applyRlsContext` then derives `is_platform_admin` from that binding rather
 * than from anything it asserted.
 *
 * ## What is audited, and what deliberately is not
 *
 * Failures only. A *successful* exchange is a machine collecting a five-minute
 * token, forever, on a timer: at one identity per module that is a row every few
 * minutes per consumer, which buys nothing — the account is already named on
 * every action it goes on to take, and Doc 10 §5's retention would be spent on
 * heartbeats. A *refused* exchange is the interesting event and is rare by
 * nature: it means a secret is wrong, which is either a misconfigured deployment
 * or somebody trying keys.
 *
 * `auth.token.failed` is the machine counterpart of `auth.login.failed` and
 * carries a reason from a closed set, for the reason that one does — an audit
 * trail is queried by action *and* payload, and free text cannot be filtered on
 * six months later.
 */

import type { MigrationInterface, QueryRunner } from 'typeorm';
import { IAM_SCHEMA } from '../schema.js';
import { APP_GROUP_ROLE } from './0007-rls-tenant.js';
import { PLATFORM_CLIENT_SLUG } from './0011-bootstrap-seed.js';

const S = `"${IAM_SCHEMA}"`;

/** Signatures, so grants and the drop path cannot drift from the definitions. */
export const AUTH_LOOKUP_SERVICE_ACCOUNT_SIGNATURE = 'auth_lookup_service_account(text)';
export const AUTH_RECORD_SERVICE_TOKEN_FAILURE_SIGNATURE =
  'auth_record_service_token_failure(text,text)';

const SERVICE_AUTH_FUNCTION_SIGNATURES = [
  AUTH_LOOKUP_SERVICE_ACCOUNT_SIGNATURE,
  AUTH_RECORD_SERVICE_TOKEN_FAILURE_SIGNATURE,
] as const;

/**
 * The reason codes `auth.token.failed` may carry.
 *
 * Closed, and checked inside the function rather than trusted from the caller —
 * it is the one string the exchange path puts into a stored row, so bounding it
 * keeps the shape of the audit table decided here rather than at each call site.
 *
 * `bad_secret` and `unknown_account` are separate in the *record* and identical
 * in the *response*, which is the same split login makes (Doc 03 §3): an
 * operator investigating an integration needs to know whether the key was wrong
 * or the secret was, and a caller must not be able to tell.
 */
export const SERVICE_TOKEN_FAILURE_REASONS = [
  'unknown_account',
  'bad_secret',
  'account_revoked',
  'client_suspended',
] as const;
export type ServiceTokenFailureReason = (typeof SERVICE_TOKEN_FAILURE_REASONS)[number];

const REASON_LIST = SERVICE_TOKEN_FAILURE_REASONS.map((reason) => `'${reason}'`).join(', ');

/**
 * The Doc 10 §4 action strings the service-account surface writes.
 *
 * The catalog names `service_account.created/rotated/revoked`; `reactivated` is
 * this migration's addition, and the catalog is explicitly a *minimum*. Turning
 * a revoked machine identity back on is the most consequential of the four
 * transitions — it re-arms a credential somebody decided to kill — and leaving
 * exactly that one unrecorded would make the trail read as though the account
 * had never been revoked at all.
 */
export const SERVICE_ACCOUNT_AUDIT_ACTIONS = {
  CREATED: 'service_account.created',
  ROTATED: 'service_account.rotated',
  REVOKED: 'service_account.revoked',
  REACTIVATED: 'service_account.reactivated',
  /** The machine counterpart of `auth.login.failed` (Doc 03 §9). */
  TOKEN_FAILED: 'auth.token.failed',
} as const;

export class ServiceAccountAuth1786406400015 implements MigrationInterface {
  name = 'ServiceAccountAuth1786406400015';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ── 1. Credential lookup ──────────────────────────────────────────────
    //
    // The counterpart of `auth_lookup_password_identity` (0012), and shaped the
    // same way: it reports, it does not decide. Everything the caller needs to
    // classify a refusal comes back in one row — the account's status, the
    // effective tenant's status, and the stored hash — so the *service* can run
    // the same fixed sequence of work whatever the outcome, rather than
    // returning early down a fast path an attacker could time.
    //
    // `key_hash` crosses the boundary for the reason `secret_hash` does in
    // 0012: argon2id lives in Node (Doc 03 §7) and there is no implementation
    // inside Postgres to compare against. It is never logged and never audited.
    //
    // The elevation is the platform flag rather than a tenant, because the
    // tenant is what this function is being asked to find. It is dropped again
    // before returning.
    await queryRunner.query(`
      create or replace function ${S}.auth_lookup_service_account(
        _key text
      ) returns table (
        service_account_id uuid,
        client_id          uuid,
        token_client_id    uuid,
        account_status     text,
        client_status      text,
        key_hash           text
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
          select sa.id,
                 sa.client_id,
                 -- The tenant the token will name. A platform-level account
                 -- (null client_id) authenticates into the platform client,
                 -- which is where its role_binding lives (0011).
                 coalesce(sa.client_id, p.id),
                 sa.status::text,
                 coalesce(c.status, p.status)::text,
                 sa.key_hash
            from ${S}."service_account" sa
            left join ${S}."client" c on c.id = sa.client_id
            -- \`left join … on true\` rather than a cross join: a missing
            -- platform client would otherwise drop the whole row and report a
            -- real account as unknown. This way the tenant columns come back
            -- null, and the caller's status check refuses — the same fail-closed
            -- direction every other branch takes.
            left join lateral (
              select cp.id, cp.status
                from ${S}."client" cp
               where cp.slug = '${PLATFORM_CLIENT_SLUG}'
            ) p on true
           where sa.key = _key;

        perform set_config('app.is_platform_admin', _prev_platform, true);
      end;
      $fn$;
    `);

    // ── 2. Refused-exchange audit ─────────────────────────────────────────
    //
    // Direct into `audit_trail`, like 0012's login-failure writer and for the
    // same reason: nobody is authenticated here — that is what failed — so
    // `write_audit` would derive the actor from an empty context and stamp one
    // that is not merely imprecise but wrong.
    //
    // The caller is given nothing to forge with. The action and the actor type
    // are literals, the actor id is unconditionally null, the tenant is looked
    // up from the key rather than accepted, and the reason is checked against a
    // closed set. The key is recorded because a failure trail with no subject
    // cannot answer the question it exists for; it is an identifier, not a
    // credential, and the secret never appears in any form (Doc 10 §8).
    //
    // `actor_id` stays null even when the account is known, for the reason the
    // failed-login row's does (0014): whoever presented the wrong secret is not
    // the account, and filing their attempt under the account's own name would
    // put a stranger's action in it. The account is named as the *target*.
    await queryRunner.query(`
      create or replace function ${S}.auth_record_service_token_failure(
        _key    text,
        _reason text
      ) returns void
      language plpgsql
      security definer
      set search_path = ${IAM_SCHEMA}, pg_temp
      as $fn$
      declare
        _prev_platform text := coalesce(current_setting('app.is_platform_admin', true), '');
        _account_id    uuid;
        _client_id     uuid;
      begin
        if _reason not in (${REASON_LIST}) then
          raise exception 'auth_record_service_token_failure: unknown reason code %', _reason;
        end if;

        perform set_config('app.is_platform_admin', 'true', true);
        select sa.id, sa.client_id into _account_id, _client_id
          from ${S}."service_account" sa
         where sa.key = _key;
        perform set_config('app.is_platform_admin', _prev_platform, true);

        -- A null \`client_id\` here is not a missing value: it is a
        -- platform-level action, which is exactly what a refused exchange
        -- against a platform-level account (or an unknown key, which belongs to
        -- no tenant) is (Doc 10 §2).
        insert into ${S}."audit_trail"
          (client_id, actor_type, actor_id, action, target_type, target_id, payload)
        values
          (_client_id, 'service_account', null,
           '${SERVICE_ACCOUNT_AUDIT_ACTIONS.TOKEN_FAILED}',
           case when _account_id is null then null else 'service_account' end,
           _account_id,
           jsonb_build_object('reason', _reason, 'account_key', _key));
      end;
      $fn$;
    `);

    // As in 0012–0014: strip the implicit `execute to public` that would
    // otherwise hand a SECURITY DEFINER path to every role in the cluster.
    for (const signature of SERVICE_AUTH_FUNCTION_SIGNATURES) {
      await queryRunner.query(`revoke all on function ${S}.${signature} from public;`);
      await queryRunner.query(
        `grant execute on function ${S}.${signature} to ${APP_GROUP_ROLE};`,
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const signature of [...SERVICE_AUTH_FUNCTION_SIGNATURES].reverse()) {
      await queryRunner.query(`drop function if exists ${S}.${signature};`);
    }
  }
}
