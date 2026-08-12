/**
 * 0001 — extensions, the `iam` schema, and every enum type (Doc 07 §4 step 1).
 *
 * Enums for tables that arrive in later migrations are created here on purpose:
 * the migration strategy is "extensions + enums first", so a type is never
 * introduced halfway through a table build.
 */

import type { MigrationInterface, QueryRunner } from 'typeorm';
import { IAM_ENUMS, IAM_SCHEMA } from '../schema.js';

/**
 * Enum name → its ordered value list (Doc 01 §3–4).
 *
 * Spelled out here rather than imported from the entities on purpose: an
 * applied migration is history. If it read a live constant, editing that
 * constant would retroactively change what this migration claims to have done.
 * Tests pin the two together instead.
 */
export const ENUM_VALUES: Record<string, readonly string[]> = {
  [IAM_ENUMS.NAV_NODE_KIND]: ['module', 'menu', 'sub_menu'],
  [IAM_ENUMS.CLIENT_STATUS]: ['active', 'suspended'],
  [IAM_ENUMS.SCOPE_NODE_KIND]: ['group', 'plant', 'department', 'gate'],
  [IAM_ENUMS.USER_STATUS]: ['active', 'locked', 'disabled'],
  [IAM_ENUMS.SERVICE_ACCOUNT_STATUS]: ['active', 'revoked'],
  [IAM_ENUMS.IDENTITY_PROVIDER]: ['password', 'oidc'],
  [IAM_ENUMS.AUDIT_ACTOR_TYPE]: ['user', 'service_account', 'platform'],
};

export class Extensions1786406400001 implements MigrationInterface {
  name = 'Extensions1786406400001';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // `ltree` backs scope-tree coverage (`<@`) — Doc 07 §2. The schema is
    // pinned rather than left to `search_path`: managed Postgres (Supabase)
    // puts extensions in an `extensions` schema that plain Postgres has no
    // equivalent of, and an `ltree` type sitting in a schema the app role does
    // not search is a column type that will not resolve. `if not exists`
    // short-circuits when a host pre-installed it elsewhere, so this is safe
    // to run against either.
    await queryRunner.query(`create extension if not exists "ltree" with schema public`);
    // `pgcrypto` is kept for its hashing and random-bytes functions. It is not
    // what supplies `gen_random_uuid()` — that has been in core since
    // Postgres 13 — so a PK default resolves wherever this ends up living.
    await queryRunner.query(`create extension if not exists "pgcrypto"`);

    await queryRunner.query(`create schema if not exists "${IAM_SCHEMA}"`);

    for (const [name, values] of Object.entries(ENUM_VALUES)) {
      const labels = values.map((value) => `'${value}'`).join(', ');
      // `create type` has no `if not exists`; the guard keeps the migration
      // re-runnable against a partially-built database.
      await queryRunner.query(`
        do $$
        begin
          if not exists (
            select 1
            from pg_type t
            join pg_namespace n on n.oid = t.typnamespace
            where t.typname = '${name}' and n.nspname = '${IAM_SCHEMA}'
          ) then
            create type "${IAM_SCHEMA}"."${name}" as enum (${labels});
          end if;
        end
        $$;
      `);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const name of Object.keys(ENUM_VALUES).reverse()) {
      await queryRunner.query(`drop type if exists "${IAM_SCHEMA}"."${name}"`);
    }

    // Plain `drop schema` (no cascade): if anything still lives in `iam` the
    // revert fails loudly rather than silently taking tables with it.
    await queryRunner.query(`drop schema if exists "${IAM_SCHEMA}"`);

    // Extensions are intentionally left installed. They are database-wide and
    // may be in use outside the `iam` schema — and on managed Postgres
    // (Supabase) the app role is not entitled to drop them anyway.
  }
}
