/**
 * 0009 — RLS on the two join tables that carry no `client_id` of their own:
 * `role_permission` and `menu_permission` (Doc 07 §6).
 *
 * These are the tables where "apply the same shape as the others" is wrong, and
 * the spec calls that out explicitly: skipping the reach-through leaks role
 * composition across tenants (violates I5). They are deliberately split, in
 * opposite directions:
 *
 * - **`role_permission` is tenant data.** What a role can do is tenant-
 *   sensitive, so its policy reaches through `role_id` to the parent role's
 *   `client_id`. The `exists` subquery costs one index lookup per row touched
 *   (`role.id` is the primary key).
 * - **`menu_permission` is catalog.** It maps an application's nav nodes to
 *   that application's permissions — neither side belongs to a client — so it
 *   gets the globally-readable, platform-writable shape from 0008.
 *
 * `client_application` is *not* here: it carries a real `client_id`, but it is
 * also the table that decides which catalog a tenant sees. It gets the tenant
 * shape below for the same reason `role` does.
 */

import type { MigrationInterface, QueryRunner } from 'typeorm';
import { IAM_SCHEMA } from '../schema.js';
import { APP_GROUP_ROLE, CTX_CLIENT_ID, CTX_IS_PLATFORM_ADMIN } from './0007-rls-tenant.js';

const S = `"${IAM_SCHEMA}"`;

export class RlsJoinTables1786406400009 implements MigrationInterface {
  name = 'RlsJoinTables1786406400009';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ── role_permission — tenant-owned via its parent role ────────────────
    await queryRunner.query(
      `grant select, insert, update, delete on ${S}."role_permission" to ${APP_GROUP_ROLE};`,
    );
    await queryRunner.query(`alter table ${S}."role_permission" enable row level security;`);
    await queryRunner.query(`alter table ${S}."role_permission" force row level security;`);
    await queryRunner.query(`
      create policy role_permission_tenant_isolation on ${S}."role_permission"
        using (
          ${CTX_IS_PLATFORM_ADMIN}
          or exists (
            select 1 from ${S}."role" r
             where r.id = role_permission.role_id
               and r.client_id = ${CTX_CLIENT_ID}
          )
        )
        with check (
          exists (
            select 1 from ${S}."role" r
             where r.id = role_permission.role_id
               and r.client_id = ${CTX_CLIENT_ID}
          )
        );
    `);

    // ── client_application — tenant-owned, direct client_id ───────────────
    await queryRunner.query(
      `grant select, insert, update, delete on ${S}."client_application" to ${APP_GROUP_ROLE};`,
    );
    await queryRunner.query(`alter table ${S}."client_application" enable row level security;`);
    await queryRunner.query(`alter table ${S}."client_application" force row level security;`);
    await queryRunner.query(`
      create policy client_application_tenant_isolation on ${S}."client_application"
        using (
          ${CTX_IS_PLATFORM_ADMIN}
          or client_id = ${CTX_CLIENT_ID}
        )
        with check (
          client_id = ${CTX_CLIENT_ID}
        );
    `);

    // ── menu_permission — catalog, NOT the tenant join shape ──────────────
    await queryRunner.query(
      `grant select, insert, update, delete on ${S}."menu_permission" to ${APP_GROUP_ROLE};`,
    );
    await queryRunner.query(`alter table ${S}."menu_permission" enable row level security;`);
    await queryRunner.query(`alter table ${S}."menu_permission" force row level security;`);
    await queryRunner.query(`
      create policy menu_permission_catalog_read on ${S}."menu_permission"
        for select using (true);
    `);
    await queryRunner.query(`
      create policy menu_permission_catalog_write on ${S}."menu_permission"
        for all
        using (${CTX_IS_PLATFORM_ADMIN})
        with check (${CTX_IS_PLATFORM_ADMIN});
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const [table, policies] of [
      ['menu_permission', ['menu_permission_catalog_write', 'menu_permission_catalog_read']],
      ['client_application', ['client_application_tenant_isolation']],
      ['role_permission', ['role_permission_tenant_isolation']],
    ] as const) {
      for (const policy of policies) {
        await queryRunner.query(`drop policy if exists ${policy} on ${S}."${table}";`);
      }
      await queryRunner.query(`alter table ${S}."${table}" no force row level security;`);
      await queryRunner.query(`alter table ${S}."${table}" disable row level security;`);
      await queryRunner.query(`revoke all on ${S}."${table}" from ${APP_GROUP_ROLE};`);
    }
  }
}
