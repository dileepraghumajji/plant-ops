/**
 * 0007 — base grants for the runtime role, and RLS on every table that carries
 * its own `client_id` (Doc 07 §4 step 6, §6).
 *
 * This is the migration that turns the schema into a tenant-isolated one. Read
 * the three mechanisms it relies on, because each is load-bearing on its own:
 *
 * 1. **Grants go to `iam_app`, never to a login role.** `iam_app` is a NOLOGIN
 *    group created by `tools/setup-db-roles.sql`; each environment grants it to
 *    whatever it named its runtime login role. Migrations therefore never need
 *    to know that name.
 * 2. **`force row level security`, not merely `enable`.** A table's *owner* is
 *    exempt from its own policies — independent of SUPERUSER and BYPASSRLS —
 *    so `enable` alone leaves every policy inert for the role that runs these
 *    migrations. `force` closes it (Doc 07 §5.1).
 * 3. **`nullif(current_setting(...), '')`.** An unset session variable reads as
 *    NULL, and `NULL::uuid` comparisons are NULL — never true — so a request
 *    with no context sees zero tenant rows. The `nullif` additionally maps the
 *    empty string to NULL; without it, `''::uuid` raises rather than denying,
 *    turning a missing context into a 500 instead of an empty result.
 */

import type { MigrationInterface, QueryRunner } from 'typeorm';
import { IAM_SCHEMA } from '../schema.js';

const S = `"${IAM_SCHEMA}"`;

/** The NOLOGIN group holding the runtime privilege bundle (Doc 07 §5.1). */
export const APP_GROUP_ROLE = 'iam_app';

/** Transaction-local settings the app sets per request (Doc 07 §5). */
export const CTX_CLIENT_ID = `nullif(current_setting('app.current_client_id', true), '')::uuid`;
export const CTX_IS_PLATFORM_ADMIN = `current_setting('app.is_platform_admin', true) = 'true'`;

/**
 * Tables owning a direct `client_id`, and the column that carries the tenant.
 * `client` is its own tenant, so it matches on `id` (Doc 07 §6).
 */
const TENANT_TABLES: readonly (readonly [table: string, tenantColumn: string])[] = [
  ['client', 'id'],
  ['scope_node', 'client_id'],
  ['user', 'client_id'],
  ['role', 'client_id'],
  ['role_binding', 'client_id'],
  ['user_identity', 'client_id'],
  ['session', 'client_id'],
];

/**
 * `service_account` is the one tenant table whose tenant column is nullable —
 * a null `client_id` means platform-level (Doc 01 §3.7) — so the plain shape
 * would lock the platform out of its own rows: `null = <anything>` is null,
 * never true, so no context value could read *or* write them. The bootstrap
 * seed (0011) creates exactly such a row.
 *
 * Both clauses therefore carry an explicit platform arm. Note this does not
 * widen tenant access: a client context still matches only `client_id =`, and
 * the write arm demands platform context *and* a null `client_id`, so a
 * platform admin cannot mislabel a tenant's account as platform-level.
 */
const SERVICE_ACCOUNT_USING = `
  ${CTX_IS_PLATFORM_ADMIN}
  or client_id = ${CTX_CLIENT_ID}
`;
const SERVICE_ACCOUNT_CHECK = `
  client_id = ${CTX_CLIENT_ID}
  or (client_id is null and ${CTX_IS_PLATFORM_ADMIN})
`;

export const TENANT_RLS_TABLES: readonly string[] = [
  ...TENANT_TABLES.map(([table]) => table),
  'service_account',
];

export class RlsTenant1786406400007 implements MigrationInterface {
  name = 'RlsTenant1786406400007';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // The group must exist before anything can be granted to it. Failing here
    // with a legible message beats a bare "role does not exist" mid-release.
    await queryRunner.query(`
      do $$
      begin
        if not exists (select 1 from pg_roles where rolname = '${APP_GROUP_ROLE}') then
          raise exception
            'role "${APP_GROUP_ROLE}" does not exist — run tools/setup-db-roles.sql first (Doc 07 §5.1)';
        end if;
      end
      $$;
    `);

    // Usage only: the runtime role may resolve objects in the schema, never
    // create them. DDL belongs to migrations, which run as the owner.
    await queryRunner.query(`grant usage on schema ${S} to ${APP_GROUP_ROLE};`);

    for (const [table, tenantColumn] of TENANT_TABLES) {
      await queryRunner.query(
        `grant select, insert, update, delete on ${S}."${table}" to ${APP_GROUP_ROLE};`,
      );
      await queryRunner.query(`alter table ${S}."${table}" enable row level security;`);
      await queryRunner.query(`alter table ${S}."${table}" force row level security;`);

      // The asymmetry between `using` and `with check` is deliberate (Doc 07
      // §6): a platform admin may *read* across tenants, but writes are still
      // pinned to the current client, so a platform action cannot land a row
      // under the wrong tenant. Platform-initiated writes set
      // `app.current_client_id` to the target client explicitly instead.
      await queryRunner.query(`
        create policy ${table}_tenant_isolation on ${S}."${table}"
          using (
            ${CTX_IS_PLATFORM_ADMIN}
            or "${tenantColumn}" = ${CTX_CLIENT_ID}
          )
          with check (
            "${tenantColumn}" = ${CTX_CLIENT_ID}
          );
      `);
    }

    await queryRunner.query(
      `grant select, insert, update, delete on ${S}."service_account" to ${APP_GROUP_ROLE};`,
    );
    await queryRunner.query(`alter table ${S}."service_account" enable row level security;`);
    await queryRunner.query(`alter table ${S}."service_account" force row level security;`);
    await queryRunner.query(`
      create policy service_account_tenant_isolation on ${S}."service_account"
        using (${SERVICE_ACCOUNT_USING})
        with check (${SERVICE_ACCOUNT_CHECK});
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `drop policy if exists service_account_tenant_isolation on ${S}."service_account";`,
    );
    await queryRunner.query(`alter table ${S}."service_account" no force row level security;`);
    await queryRunner.query(`alter table ${S}."service_account" disable row level security;`);
    await queryRunner.query(`revoke all on ${S}."service_account" from ${APP_GROUP_ROLE};`);

    for (const [table] of [...TENANT_TABLES].reverse()) {
      await queryRunner.query(
        `drop policy if exists ${table}_tenant_isolation on ${S}."${table}";`,
      );
      await queryRunner.query(`alter table ${S}."${table}" no force row level security;`);
      await queryRunner.query(`alter table ${S}."${table}" disable row level security;`);
      await queryRunner.query(
        `revoke all on ${S}."${table}" from ${APP_GROUP_ROLE};`,
      );
    }
    await queryRunner.query(`revoke usage on schema ${S} from ${APP_GROUP_ROLE};`);
  }
}
