/**
 * 0003 — the tenant tables: `client`, `scope_node`, `user`, `service_account`,
 * `role` (Doc 01 §3.4–3.7, §4.2; Doc 07 §4 step 3).
 *
 * Everything here is tenant-owned, so every row carries `client_id` (Doc 01
 * §6.6) — the column RLS keys off in Session 5. `service_account` is the one
 * exception: a null `client_id` means platform-level (Doc 01 §3.7).
 *
 * Two conventions repeat below and are worth reading once:
 *
 * - **`unique (id, client_id)`.** Redundant next to the primary key on its own.
 *   It exists so `role_binding` (0004) can carry `client_id` into its foreign
 *   keys, making "the role, the node and the subject all belong to the same
 *   client" (Doc 02 §6) a database guarantee rather than a service-layer
 *   promise. The same trick already ties `nav_node.parent_id` to its
 *   application in 0002.
 * - **`on delete restrict` towards `client`.** Tenants are suspended, never
 *   deleted (Doc 01 §3.4); a cascade here would be a silent tenant wipe.
 */

import type { MigrationInterface, QueryRunner } from 'typeorm';
import { IAM_ENUMS, IAM_SCHEMA } from '../schema.js';

const S = `"${IAM_SCHEMA}"`;

export class TenantTables1786406400003 implements MigrationInterface {
  name = 'TenantTables1786406400003';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      create table ${S}."client" (
        id         uuid        not null default gen_random_uuid(),
        name       text        not null,
        slug       text        not null,
        status     ${S}."${IAM_ENUMS.CLIENT_STATUS}" not null default 'active',
        config     jsonb       not null default '{}'::jsonb,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now(),
        constraint client_pkey primary key (id),
        constraint client_name_not_blank check (length(btrim(name)) > 0),
        -- The slug is half of the login credential (Doc 03 §3:
        -- \`{ email, password, client_slug }\`), so it has to be something a
        -- person can type unambiguously: lowercase kebab-case, no leading,
        -- trailing or doubled hyphens.
        constraint client_slug_format check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$')
      );
    `);
    await queryRunner.query(`create unique index client_slug_key on ${S}."client" (slug);`);
    await queryRunner.query(`
      create trigger client_set_updated_at
        before update on ${S}."client"
        for each row execute function ${S}.set_updated_at();
    `);

    // ── scope_node — the WHERE dimension (Doc 01 §3.5) ────────────────────
    await queryRunner.query(`
      create table ${S}."scope_node" (
        id         uuid        not null default gen_random_uuid(),
        client_id  uuid        not null,
        parent_id  uuid,
        kind       ${S}."${IAM_ENUMS.SCOPE_NODE_KIND}" not null,
        name       text        not null,
        path       ltree       not null,
        metadata   jsonb       not null default '{}'::jsonb,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now(),
        constraint scope_node_pkey primary key (id),
        constraint scope_node_id_client_id_key unique (id, client_id),
        constraint scope_node_client_id_fkey
          foreign key (client_id) references ${S}."client" (id)
          on delete restrict,
        -- A node's parent must live in the same tenant's tree.
        constraint scope_node_parent_id_fkey
          foreign key (parent_id, client_id)
          references ${S}."scope_node" (id, client_id)
          on delete restrict,
        constraint scope_node_parent_id_not_self check (parent_id is null or parent_id <> id),
        constraint scope_node_name_not_blank check (length(btrim(name)) > 0),
        -- Doc 01 §3.5 / Doc 07 §7 — the load-bearing path rule, enforced here
        -- rather than trusted to the service layer: a node's own (last) label
        -- is 'n_' + its UUID hex. Display names never reach \`path\`, so a
        -- rename cannot rewrite a path and invalidate every grant beneath it,
        -- and a hostile name like "Gate-3" cannot mangle the ltree.
        constraint scope_node_path_label_is_id_derived check (
          subpath(path, nlevel(path) - 1)::text = 'n_' || replace(id::text, '-', '')
        ),
        -- Roots sit at depth 1, children below. Together with the label rule
        -- this pins both ends of the path: a child cannot be stored as a root
        -- and a root cannot claim an ancestor it does not have.
        constraint scope_node_root_is_depth_one check ((parent_id is null) = (nlevel(path) = 1))
      );
    `);
    await queryRunner.query(`
      create trigger scope_node_set_updated_at
        before update on ${S}."scope_node"
        for each row execute function ${S}.set_updated_at();
    `);

    // ── user (Doc 01 §3.6) ────────────────────────────────────────────────
    // \`user\` is a reserved word in Postgres and is quoted everywhere.
    await queryRunner.query(`
      create table ${S}."user" (
        id              uuid        not null default gen_random_uuid(),
        client_id       uuid        not null,
        email           text        not null,
        full_name       text        not null,
        phone           text,
        status          ${S}."${IAM_ENUMS.USER_STATUS}" not null default 'active',
        is_client_admin boolean     not null default false,
        created_at      timestamptz not null default now(),
        updated_at      timestamptz not null default now(),
        constraint user_pkey primary key (id),
        constraint user_id_client_id_key unique (id, client_id),
        constraint user_client_id_fkey
          foreign key (client_id) references ${S}."client" (id)
          on delete restrict,
        constraint user_full_name_not_blank check (length(btrim(full_name)) > 0),
        -- Login is by (client_slug, email) (Doc 03 §3) and must not depend on
        -- how the address was typed. Storing the normalized form is what makes
        -- \`unique (client_id, email)\` below a genuinely case-insensitive
        -- identity constraint; the service lowercases before writing.
        constraint user_email_is_lowercase check (email = lower(email)),
        -- Deliberately loose: enough to catch a blank, a stray space or a
        -- missing @, not an attempt to adjudicate RFC 5322 in a check
        -- constraint. Real validation is the API's job (Doc 06 §8).
        constraint user_email_shape check (email ~ '^[^[:space:]@]+@[^[:space:]@]+$')
      );
    `);
    // Doc 01 §3.6 / Doc 07 §9 — per client, not globally: the same address may
    // be a distinct user in two tenants, which is intended.
    await queryRunner.query(`
      create unique index user_client_id_email_key on ${S}."user" (client_id, email);
    `);
    await queryRunner.query(`
      create trigger user_set_updated_at
        before update on ${S}."user"
        for each row execute function ${S}.set_updated_at();
    `);

    // ── service_account (Doc 01 §3.7) ─────────────────────────────────────
    await queryRunner.query(`
      create table ${S}."service_account" (
        id         uuid        not null default gen_random_uuid(),
        client_id  uuid,
        name       text        not null,
        key        text        not null,
        key_hash   text        not null,
        status     ${S}."${IAM_ENUMS.SERVICE_ACCOUNT_STATUS}" not null default 'active',
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now(),
        constraint service_account_pkey primary key (id),
        -- Nullable client_id = platform-level account (Doc 01 §3.7).
        constraint service_account_client_id_fkey
          foreign key (client_id) references ${S}."client" (id)
          on delete restrict,
        constraint service_account_name_not_blank check (length(btrim(name)) > 0),
        constraint service_account_key_not_blank check (length(btrim(key)) > 0),
        constraint service_account_key_hash_not_blank check (length(btrim(key_hash)) > 0)
      );
    `);
    // \`key\` is not in the Doc 01 §3.7 column list but the exchange it serves
    // is: \`POST /auth/token { account_key, account_secret }\` (Doc 03 §5,
    // Doc 06 §3) carries no tenant, so the lookup handle must resolve an
    // account on its own — hence global uniqueness. Only \`key_hash\` ever
    // holds the secret; the key is a public identifier.
    await queryRunner.query(`
      create unique index service_account_key_key on ${S}."service_account" (key);
    `);
    await queryRunner.query(`
      create trigger service_account_set_updated_at
        before update on ${S}."service_account"
        for each row execute function ${S}.set_updated_at();
    `);

    // ── role (Doc 01 §4.2) ────────────────────────────────────────────────
    await queryRunner.query(`
      create table ${S}."role" (
        id          uuid        not null default gen_random_uuid(),
        client_id   uuid        not null,
        name        text        not null,
        description text,
        is_system   boolean     not null default false,
        created_at  timestamptz not null default now(),
        updated_at  timestamptz not null default now(),
        constraint role_pkey primary key (id),
        constraint role_id_client_id_key unique (id, client_id),
        constraint role_client_id_fkey
          foreign key (client_id) references ${S}."client" (id)
          on delete restrict,
        constraint role_name_not_blank check (length(btrim(name)) > 0)
      );
    `);
    await queryRunner.query(`
      create unique index role_client_id_name_key on ${S}."role" (client_id, name);
    `);
    await queryRunner.query(`
      create trigger role_set_updated_at
        before update on ${S}."role"
        for each row execute function ${S}.set_updated_at();
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`drop table if exists ${S}."role";`);
    await queryRunner.query(`drop table if exists ${S}."service_account";`);
    await queryRunner.query(`drop table if exists ${S}."user";`);
    await queryRunner.query(`drop table if exists ${S}."scope_node";`);
    await queryRunner.query(`drop table if exists ${S}."client";`);
  }
}
