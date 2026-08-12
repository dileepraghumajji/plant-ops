/**
 * 0008 — RLS on the registry/catalog tables: `application`, `permission`,
 * `nav_node` (Doc 07 §6).
 *
 * Catalog is the mirror image of tenant data. These rows belong to no client —
 * they describe the applications the platform offers — so they are **globally
 * readable** by any authenticated subject and **writable only by a platform
 * admin**. Which of them a given tenant actually sees is decided further up, by
 * `client_application` enablement and by resolution (Doc 04 §4), not here.
 *
 * `menu_permission` follows this same catalog shape rather than the tenant one,
 * and lands in 0009 next to the join table it is deliberately split from.
 */

import type { MigrationInterface, QueryRunner } from 'typeorm';
import { IAM_SCHEMA } from '../schema.js';
import { APP_GROUP_ROLE, CTX_IS_PLATFORM_ADMIN } from './0007-rls-tenant.js';

const S = `"${IAM_SCHEMA}"`;

const CATALOG_TABLES: readonly string[] = ['application', 'permission', 'nav_node'];

export const CATALOG_RLS_TABLES = CATALOG_TABLES;

export class RlsCatalog1786406400008 implements MigrationInterface {
  name = 'RlsCatalog1786406400008';

  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const table of CATALOG_TABLES) {
      await queryRunner.query(
        `grant select, insert, update, delete on ${S}."${table}" to ${APP_GROUP_ROLE};`,
      );
      await queryRunner.query(`alter table ${S}."${table}" enable row level security;`);
      await queryRunner.query(`alter table ${S}."${table}" force row level security;`);

      // Read: unconditional. A subject must be able to see the catalog of what
      // exists to be granted anything against it.
      await queryRunner.query(`
        create policy ${table}_catalog_read on ${S}."${table}"
          for select using (true);
      `);

      // Write: platform only. `for all` covers insert/update/delete; the
      // `for select using (true)` policy above already permits reads, and
      // permissive policies are OR-ed, so this does not narrow them.
      await queryRunner.query(`
        create policy ${table}_catalog_write on ${S}."${table}"
          for all
          using (${CTX_IS_PLATFORM_ADMIN})
          with check (${CTX_IS_PLATFORM_ADMIN});
      `);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const table of [...CATALOG_TABLES].reverse()) {
      await queryRunner.query(`drop policy if exists ${table}_catalog_write on ${S}."${table}";`);
      await queryRunner.query(`drop policy if exists ${table}_catalog_read on ${S}."${table}";`);
      await queryRunner.query(`alter table ${S}."${table}" no force row level security;`);
      await queryRunner.query(`alter table ${S}."${table}" disable row level security;`);
      await queryRunner.query(`revoke all on ${S}."${table}" from ${APP_GROUP_ROLE};`);
    }
  }
}
