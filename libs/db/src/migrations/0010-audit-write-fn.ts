/**
 * 0010 — `iam.write_audit`, and locking `audit_trail` down around it
 * (Doc 07 §6, Doc 10 §1).
 *
 * A naive `insert with check (true)` would be worse than no policy: it lets any
 * authenticated context fabricate audit rows with an arbitrary actor, tenant and
 * action — so a buggy service, or an attacker holding any valid token, could
 * misattribute or manufacture history. Audit is only worth having if it cannot
 * be forged.
 *
 * The shape that makes it non-forgeable:
 *
 * - The runtime role holds **`select` only**. No INSERT, UPDATE, DELETE — and
 *   `truncate` revoked explicitly, since it is a separate privilege that would
 *   otherwise defeat the append-only intent wholesale.
 * - Writes go through this one `SECURITY DEFINER` function, which runs as its
 *   owner and **derives** `client_id`, `actor_id` and `actor_type` from the
 *   session context rather than accepting them. There is no parameter through
 *   which a caller could claim to be someone else.
 * - The context it reads is itself JWT-sourced (Doc 07 §5), so the chain from
 *   verified token to audit row has no client-supplied link in it.
 *
 * **`audit_trail` is deliberately left un-forced.** Every other RLS table gets
 * `force row level security`; here the owner path is exactly what the definer
 * function needs to insert. The app role is stopped by *privilege* — it simply
 * has no INSERT — which is the stronger barrier, because it does not depend on
 * a policy being evaluated correctly (Doc 07 §5.1).
 */

import type { MigrationInterface, QueryRunner } from 'typeorm';
import { IAM_SCHEMA } from '../schema.js';
import { APP_GROUP_ROLE, CTX_CLIENT_ID, CTX_IS_PLATFORM_ADMIN } from './0007-rls-tenant.js';

const S = `"${IAM_SCHEMA}"`;

/** The signature the app calls, and the one grants are pinned to. */
export const WRITE_AUDIT_SIGNATURE = 'write_audit(text,text,uuid,jsonb)';

export class AuditWriteFn1786406400010 implements MigrationInterface {
  name = 'AuditWriteFn1786406400010';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`alter table ${S}."audit_trail" enable row level security;`);

    // Read only, and tenant-scoped: a client admin sees its own rows, a
    // platform admin sees everything including the platform-level rows whose
    // client_id is null (Doc 10 §7).
    await queryRunner.query(`
      create policy audit_trail_read on ${S}."audit_trail"
        for select using (
          ${CTX_IS_PLATFORM_ADMIN}
          or client_id = ${CTX_CLIENT_ID}
        );
    `);

    // No insert/update/delete policy exists, by design. Even if the privilege
    // were granted by mistake, there is no policy to permit the row.

    await queryRunner.query(`
      create or replace function ${S}.write_audit(
        _action      text,
        _target_type text,
        _target_id   uuid,
        _payload     jsonb default '{}'::jsonb
      ) returns uuid
      language plpgsql
      security definer
      -- Pinned search_path: a SECURITY DEFINER function without one can be
      -- hijacked by a caller-controlled path resolving 'audit_trail' or an
      -- operator to something else entirely.
      set search_path = ${IAM_SCHEMA}, pg_temp
      as $fn$
      declare
        _id         uuid := gen_random_uuid();
        _client_id  uuid := ${CTX_CLIENT_ID};
        _actor_id   uuid := nullif(current_setting('app.current_user_id', true), '')::uuid;
        _actor_type ${S}."audit_actor_type" := case
                        when ${CTX_IS_PLATFORM_ADMIN} then 'platform'
                        when _actor_id is not null    then 'user'
                        else 'service_account'
                      end;
      begin
        insert into ${S}.audit_trail
          (id, client_id, actor_type, actor_id, action, target_type, target_id, payload, created_at)
        values
          (_id, _client_id, _actor_type, _actor_id, _action, _target_type, _target_id,
           coalesce(_payload, '{}'::jsonb), now());
        return _id;
      end;
      $fn$;
    `);

    // Strip the implicit `execute to public` that comes with a new function —
    // otherwise SECURITY DEFINER hands the insert path to every role.
    await queryRunner.query(
      `revoke all on function ${S}.${WRITE_AUDIT_SIGNATURE} from public;`,
    );

    await queryRunner.query(`revoke all on ${S}."audit_trail" from ${APP_GROUP_ROLE};`);
    await queryRunner.query(`grant select on ${S}."audit_trail" to ${APP_GROUP_ROLE};`);
    await queryRunner.query(
      `grant execute on function ${S}.${WRITE_AUDIT_SIGNATURE} to ${APP_GROUP_ROLE};`,
    );
    // Belt and braces (Doc 07 §6). TRUNCATE is not implied by DELETE.
    await queryRunner.query(
      `revoke insert, update, delete, truncate on ${S}."audit_trail" from ${APP_GROUP_ROLE};`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`drop function if exists ${S}.${WRITE_AUDIT_SIGNATURE};`);
    await queryRunner.query(`drop policy if exists audit_trail_read on ${S}."audit_trail";`);
    await queryRunner.query(`alter table ${S}."audit_trail" disable row level security;`);
    await queryRunner.query(`revoke all on ${S}."audit_trail" from ${APP_GROUP_ROLE};`);
  }
}
