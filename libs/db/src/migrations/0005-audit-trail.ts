/**
 * 0005 — `audit_trail`, the append-only record (Doc 01 §4.8, Doc 10;
 * Doc 07 §4 step 5).
 *
 * This migration creates the *shape*. The teeth — RLS, the revoked
 * INSERT/UPDATE/DELETE/TRUNCATE grants, and the `iam.write_audit`
 * SECURITY DEFINER function that is the only way in — arrive in Session 5
 * (Doc 07 §6). What is decided here and cannot be undone later:
 *
 * - **No `updated_at`, and no update trigger.** Every other table in this
 *   schema stamps one. Its absence is the point: there is no update path to
 *   stamp (Doc 10 §1). A column would imply one exists.
 * - **No foreign keys.** `client_id`, `actor_id` and `target_id` are plain
 *   uuids — note that Doc 01 §4.8 is the one table whose column list does not
 *   say "FK →". Audit is a record of what happened, and it has to survive the
 *   deletion of whatever it describes; an FK would make a delete elsewhere
 *   either fail or rewrite history.
 */

import type { MigrationInterface, QueryRunner } from 'typeorm';
import { IAM_ENUMS, IAM_SCHEMA } from '../schema.js';

const S = `"${IAM_SCHEMA}"`;

export class AuditTrail1786406400005 implements MigrationInterface {
  name = 'AuditTrail1786406400005';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      create table ${S}."audit_trail" (
        id          uuid        not null default gen_random_uuid(),
        -- null = a platform-level action, outside any tenant (Doc 10 §2).
        client_id   uuid,
        actor_type  ${S}."${IAM_ENUMS.AUDIT_ACTOR_TYPE}" not null,
        -- Nullable: \`iam.write_audit\` derives the actor from the request
        -- context, and a platform action taken before any subject exists
        -- (\`platform.bootstrap\`, Doc 07 §8) has none to name.
        actor_id    uuid,
        action      text        not null,
        target_type text,
        target_id   uuid,
        payload     jsonb       not null default '{}'::jsonb,
        created_at  timestamptz not null default now(),
        constraint audit_trail_pkey primary key (id),
        -- \`action\` is the dotted verb from the Doc 10 §4 catalog; an
        -- unattributable blank is worse than no row at all.
        constraint audit_trail_action_not_blank check (length(btrim(action)) > 0),
        -- A target_id without a target_type cannot be interpreted.
        constraint audit_trail_target_is_typed check (target_id is null or target_type is not null)
      );
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`drop table if exists ${S}."audit_trail";`);
  }
}
