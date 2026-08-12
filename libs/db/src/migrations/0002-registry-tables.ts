/**
 * 0002 — the registry/catalog tables: `application`, `permission`, `nav_node`
 * (Doc 01 §3.1–3.3, Doc 07 §4 step 2).
 *
 * These three are catalog, not tenant data: no `client_id`, globally readable,
 * platform-writable. Their RLS policies land in Session 5's migrations.
 *
 * SQL is hand-written rather than generated so the constraints that carry the
 * spec's invariants are reviewable in one place (Doc 07 §3).
 */

import type { MigrationInterface, QueryRunner } from 'typeorm';
import { IAM_ENUMS, IAM_SCHEMA } from '../schema.js';

const S = `"${IAM_SCHEMA}"`;

export class RegistryTables1786406400002 implements MigrationInterface {
  name = 'RegistryTables1786406400002';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Shared `updated_at` trigger. Owning the stamp in the database means a
    // raw SQL update cannot leave a stale timestamp behind; later migrations
    // reuse this function for the tenant tables.
    await queryRunner.query(`
      create or replace function ${S}.set_updated_at() returns trigger
      language plpgsql as $$
      begin
        new.updated_at := now();
        return new;
      end;
      $$;
    `);

    await queryRunner.query(`
      create table ${S}."application" (
        id          uuid        not null default gen_random_uuid(),
        key         text        not null,
        name        text        not null,
        description text,
        is_active   boolean     not null default true,
        config      jsonb       not null default '{}'::jsonb,
        created_at  timestamptz not null default now(),
        updated_at  timestamptz not null default now(),
        constraint application_pkey primary key (id),
        constraint application_key_not_blank check (length(btrim(key)) > 0),
        constraint application_name_not_blank check (length(btrim(name)) > 0)
      );
    `);
    await queryRunner.query(
      `create unique index application_key_key on ${S}."application" (key);`,
    );
    await queryRunner.query(`
      create trigger application_set_updated_at
        before update on ${S}."application"
        for each row execute function ${S}.set_updated_at();
    `);

    await queryRunner.query(`
      create table ${S}."permission" (
        id             uuid        not null default gen_random_uuid(),
        application_id uuid        not null,
        key            text        not null,
        name           text        not null,
        description    text,
        is_active      boolean     not null default true,
        created_at     timestamptz not null default now(),
        updated_at     timestamptz not null default now(),
        constraint permission_pkey primary key (id),
        constraint permission_application_id_fkey
          foreign key (application_id) references ${S}."application" (id)
          on delete cascade,
        constraint permission_key_not_blank check (length(btrim(key)) > 0),
        constraint permission_name_not_blank check (length(btrim(name)) > 0)
      );
    `);
    // Doc 01 §6.3 — a permission is addressed globally as
    // `application.key + permission.key`, so the pair must be unique.
    await queryRunner.query(`
      create unique index permission_application_id_key_key
        on ${S}."permission" (application_id, key);
    `);
    await queryRunner.query(`
      create trigger permission_set_updated_at
        before update on ${S}."permission"
        for each row execute function ${S}.set_updated_at();
    `);

    await queryRunner.query(`
      create table ${S}."nav_node" (
        id             uuid        not null default gen_random_uuid(),
        application_id uuid        not null,
        parent_id      uuid,
        kind           ${S}."${IAM_ENUMS.NAV_NODE_KIND}" not null,
        key            text        not null,
        label          text        not null,
        route          text,
        icon           text,
        sort_order     integer     not null default 0,
        is_active      boolean     not null default true,
        is_public      boolean     not null default false,
        created_at     timestamptz not null default now(),
        updated_at     timestamptz not null default now(),
        constraint nav_node_pkey primary key (id),
        -- Target for the composite parent FK below. Redundant with the PK on
        -- its own; it exists so the FK can carry application_id along.
        constraint nav_node_id_application_id_key unique (id, application_id),
        constraint nav_node_application_id_fkey
          foreign key (application_id) references ${S}."application" (id)
          on delete cascade,
        -- A node's parent must belong to the *same application* (Doc 06 §4).
        -- Carrying application_id into the FK makes that a database
        -- guarantee rather than a service-layer promise.
        constraint nav_node_parent_id_fkey
          foreign key (parent_id, application_id)
          references ${S}."nav_node" (id, application_id)
          on delete cascade,
        constraint nav_node_parent_id_not_self check (parent_id is null or parent_id <> id),
        constraint nav_node_key_not_blank check (length(btrim(key)) > 0),
        constraint nav_node_label_not_blank check (length(btrim(label)) > 0)
      );
    `);
    await queryRunner.query(`
      create unique index nav_node_application_id_key_key
        on ${S}."nav_node" (application_id, key);
    `);
    // Ordered sibling fetch — the shape Doc 05's pruning walks.
    await queryRunner.query(`
      create index nav_node_application_id_parent_id_sort_order_idx
        on ${S}."nav_node" (application_id, parent_id, sort_order);
    `);
    // Postgres does not index referencing columns automatically; without this
    // the self-FK's cascade delete degrades to a sequential scan per row.
    await queryRunner.query(
      `create index nav_node_parent_id_idx on ${S}."nav_node" (parent_id);`,
    );
    await queryRunner.query(`
      create trigger nav_node_set_updated_at
        before update on ${S}."nav_node"
        for each row execute function ${S}.set_updated_at();
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`drop table if exists ${S}."nav_node";`);
    await queryRunner.query(`drop table if exists ${S}."permission";`);
    await queryRunner.query(`drop table if exists ${S}."application";`);
    await queryRunner.query(`drop function if exists ${S}.set_updated_at();`);
  }
}
