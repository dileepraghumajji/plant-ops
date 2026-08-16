/**
 * 0016 — the binding-expiry sweep (Doc 04 §7 last row, Doc 01 §4.5).
 *
 * ## The one row of the invalidation table that has no writer
 *
 * Every other cause in Doc 04 §7 is somebody's mutation: a bind, an unbind, a
 * role edited, an app toggled. Each of those runs inside a request transaction,
 * so it can capture the affected subjects and publish after commit. `expires_at`
 * passing is not like that — **time passing is not a hook**, as §7 puts it — and
 * nothing at all happens at the moment a grant lapses. `resolve()` already
 * filters on `expires_at > now()` (Session 21), so the *database* stops honouring
 * the binding on the second it expires; what does not stop is a cache entry
 * written a minute earlier, which keeps serving the grant until its TTL runs out.
 *
 * This migration supplies what a periodic sweep needs to close that window and,
 * more importantly, to close it **exactly once**.
 *
 * ## Why a column rather than "everything that expired since the last run"
 *
 * A sweep that selected `expires_at between _last_run and now()` would need to
 * remember `_last_run` somewhere, and every way of remembering it is a way of
 * getting it wrong: a process restart loses it, two replicas keep two of them,
 * and a clock that steps backwards re-audits a range or skips one. Worse, the
 * failure is silent in the skip direction — a grant that lapsed inside a missed
 * window never gets invalidated at all.
 *
 * {@link EXPIRY_SWEPT_AT_COLUMN} moves that state onto the row it is about. A
 * binding is "newly expired" iff `expires_at <= now() and expiry_swept_at is
 * null`, which is a fact about the database rather than about the sweeper — so
 * the job is idempotent, safely restartable, and safe to run from more than one
 * replica at once (see `for update skip locked` below). It also makes the sweep's
 * own progress auditable: the column says when the system noticed.
 *
 * The column is **not** the expiry itself. `expires_at` remains the authority and
 * resolution keeps filtering on it directly; a binding whose `expiry_swept_at` is
 * still null is already inert everywhere that matters. This column records
 * housekeeping, and nothing reads it to decide access.
 *
 * ## Why the row is marked and never deleted
 *
 * Doc 06 §9 requires expired bindings to stay listable and flagged — an access
 * history that erases lapsed grants cannot answer "who could do this in March".
 * `bindings.service.ts` already computes its `expired` flag from `expires_at`, so
 * nothing about the read side changes here.
 *
 * ## Why a `SECURITY DEFINER` function
 *
 * The sweep runs on a timer, not on a request, so there is no JWT and therefore
 * no RLS context (Doc 07 §5) — the same position `AuthGuard`'s revocation check
 * and every `auth_*` function of 0012–0015 are in, and it gets the same answer.
 * The function supplies its own context: platform, to *find* expired bindings
 * across every tenant, then the binding's own `client_id` before each audit write
 * so the record lands in the tenant it belongs to.
 *
 * That per-tenant switch is not optional. `role_binding`'s policy has
 * `with check (client_id = app.current_client_id)` and no platform arm (0007) —
 * deliberately, so a platform action cannot write a row under the wrong tenant —
 * so a single cross-tenant `UPDATE` would be rejected however privileged the
 * caller. The tenant loop is that policy being obeyed, not worked around.
 *
 * The audit rows go through `iam.write_audit` rather than a direct insert, unlike
 * 0012's and 0014's anonymous login rows. Those bypass it because there is no
 * authenticated context to derive an actor from and `write_audit` would attribute
 * the row to nobody. Here there *is* a correct answer: the platform noticed, so
 * `is_platform_admin` stays true across the loop, `app.current_user_id` is
 * cleared, and `write_audit` derives `actor_type = 'platform'` with a null actor —
 * which is precisely what a system-initiated event is.
 */

import type { MigrationInterface, QueryRunner } from 'typeorm';
import { IAM_SCHEMA } from '../schema.js';
import { APP_GROUP_ROLE } from './0007-rls-tenant.js';

const S = `"${IAM_SCHEMA}"`;

/** The housekeeping column: when the sweep noticed this binding had lapsed. */
export const EXPIRY_SWEPT_AT_COLUMN = 'expiry_swept_at';

/** Partial index backing the sweep's only query. */
export const EXPIRY_SWEEP_INDEX = 'role_binding_pending_expiry_idx';

/** The signature the job calls, and the one the grant is pinned to. */
export const SWEEP_EXPIRED_BINDINGS_SIGNATURE = 'sweep_expired_bindings(integer)';

/**
 * `role_binding.expired` — Doc 10 §4's action for a lapsed grant.
 *
 * Spelled here as well as in `audit/audit-actions.ts` because this function is
 * the only writer of it and PL/pgSQL cannot import the catalog. The two are
 * pinned together by `audit-actions.spec.ts`, so a rename that misses one fails
 * the suite rather than quietly splitting one event across two spellings.
 */
export const ROLE_BINDING_EXPIRED_ACTION = 'role_binding.expired';

export class BindingExpirySweep1786406400016 implements MigrationInterface {
  name = 'BindingExpirySweep1786406400016';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      alter table ${S}."role_binding"
        add column ${EXPIRY_SWEPT_AT_COLUMN} timestamptz;
    `);

    await queryRunner.query(`
      comment on column ${S}."role_binding".${EXPIRY_SWEPT_AT_COLUMN} is
        'When the expiry sweep invalidated this lapsed binding. Housekeeping only — expires_at is the authority on access (Doc 04 §7).';
    `);

    // Partial on exactly the sweep's predicate, and narrower than migration
    // 0006's `role_binding_expires_at_idx` in the way that matters: that one
    // carries every dated binding, because it backs the `expired` flag Doc 06 §9
    // requires the listing to show. This one additionally excludes the rows the
    // sweep has already claimed, so it is roughly *empty* in steady state —
    // which is the point. The sweep runs on a timer forever, and when there is
    // nothing to do it should cost an index scan over nothing.
    await queryRunner.query(`
      create index ${EXPIRY_SWEEP_INDEX}
        on ${S}."role_binding" (expires_at)
        where expires_at is not null and ${EXPIRY_SWEPT_AT_COLUMN} is null;
    `);

    await queryRunner.query(`
      create or replace function ${S}.sweep_expired_bindings(_limit integer default 500)
      returns table (
        binding_id                 uuid,
        binding_client_id          uuid,
        binding_user_id            uuid,
        binding_service_account_id uuid
      )
      language plpgsql
      security definer
      -- Pinned, like every definer function in this schema: without it a
      -- caller-controlled search_path could resolve 'role_binding' or an
      -- operator to something of its own.
      set search_path = ${IAM_SCHEMA}, pg_temp
      as $fn$
      declare
        _prev_client   text := coalesce(current_setting('app.current_client_id', true), '');
        _prev_user     text := coalesce(current_setting('app.current_user_id', true), '');
        _prev_platform text := coalesce(current_setting('app.is_platform_admin', true), '');
        _clients       uuid[];
        _client        uuid;
        _row           record;
      begin
        -- Platform for the whole function: it is what lets the scan below see
        -- every tenant, and what makes \`write_audit\` stamp actor_type
        -- 'platform' with a null actor. Cleared, so no user is credited with
        -- an event that a timer caused.
        perform set_config('app.is_platform_admin', 'true', true);
        perform set_config('app.current_user_id', '', true);

        -- Materialized into an array rather than driven as a cursor. A
        -- \`for _client in select ...\` would fetch lazily, and the loop body
        -- changes \`app.current_client_id\` on every iteration — so later
        -- fetches would be re-evaluated under a *tenant* context and the scan
        -- would silently stop after the first client.
        select coalesce(array_agg(distinct client_id), '{}')
          into _clients
          from ${S}."role_binding"
         where expires_at is not null
           and expires_at <= now()
           and ${EXPIRY_SWEPT_AT_COLUMN} is null;

        foreach _client in array _clients
        loop
          -- The tenant the next write belongs to. \`with check\` on
          -- role_binding demands it, and \`write_audit\` reads it for the audit
          -- row's own client_id — one setting, both purposes, which is why the
          -- audit lands in the tenant that owned the grant.
          perform set_config('app.current_client_id', _client::text, true);

          for _row in
            -- \`skip locked\` makes two replicas sweeping at once correct rather
            -- than merely unlikely: each claims a disjoint set and neither
            -- waits. Combined with \`expiry_swept_at is null\`, a binding is
            -- audited and invalidated exactly once no matter how many sweepers
            -- run or how often they restart.
            with claimed as (
              select id
                from ${S}."role_binding"
               where client_id = _client
                 and expires_at is not null
                 and expires_at <= now()
                 and ${EXPIRY_SWEPT_AT_COLUMN} is null
               order by expires_at asc
               limit _limit
                 for update skip locked
            ),
            swept as (
              update ${S}."role_binding" rb
                 set ${EXPIRY_SWEPT_AT_COLUMN} = now()
                from claimed c
               where rb.id = c.id
              returning rb.id, rb.client_id, rb.user_id, rb.service_account_id,
                        rb.role_id, rb.scope_node_id, rb.expires_at
            )
            select * from swept
          loop
            perform ${S}.write_audit(
              '${ROLE_BINDING_EXPIRED_ACTION}',
              'role_binding',
              _row.id,
              jsonb_build_object(
                'user_id',            _row.user_id,
                'service_account_id', _row.service_account_id,
                'role_id',            _row.role_id,
                'scope_node_id',      _row.scope_node_id,
                'expires_at',         _row.expires_at
              )
            );

            binding_id                 := _row.id;
            binding_client_id          := _row.client_id;
            binding_user_id            := _row.user_id;
            binding_service_account_id := _row.service_account_id;
            return next;
          end loop;
        end loop;

        perform set_config('app.current_client_id', _prev_client, true);
        perform set_config('app.current_user_id', _prev_user, true);
        perform set_config('app.is_platform_admin', _prev_platform, true);
      end;
      $fn$;
    `);

    // Same lockdown every definer function in this schema gets: strip the
    // implicit `execute to public` a new function is created with, then grant it
    // back to the one role that may call it.
    await queryRunner.query(
      `revoke all on function ${S}.${SWEEP_EXPIRED_BINDINGS_SIGNATURE} from public;`,
    );
    await queryRunner.query(
      `grant execute on function ${S}.${SWEEP_EXPIRED_BINDINGS_SIGNATURE} to ${APP_GROUP_ROLE};`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `drop function if exists ${S}.${SWEEP_EXPIRED_BINDINGS_SIGNATURE};`,
    );
    await queryRunner.query(`drop index if exists ${S}.${EXPIRY_SWEEP_INDEX};`);
    await queryRunner.query(
      `alter table ${S}."role_binding" drop column if exists ${EXPIRY_SWEPT_AT_COLUMN};`,
    );
  }
}
