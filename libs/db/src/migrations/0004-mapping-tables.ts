/**
 * 0004 — the mapping tables: `client_application`, `role_permission`,
 * `menu_permission`, `role_binding`, `user_identity`, `session`
 * (Doc 01 §4.1, §4.3–4.7; Doc 07 §4 step 4).
 *
 * `role_binding` is the heart of the system (Doc 01 §4.5) — WHO × WHAT × WHERE
 * in one row — and carries the two invariants this migration exists to make
 * unbreakable: exactly one subject, and no duplicate (subject, role, node).
 *
 * The join tables get `created_at` but no `updated_at`: a row that is nothing
 * but its own key has no update to stamp. They are inserted and deleted.
 */

import type { MigrationInterface, QueryRunner } from 'typeorm';
import { IAM_ENUMS, IAM_SCHEMA } from '../schema.js';

const S = `"${IAM_SCHEMA}"`;

export class MappingTables1786406400004 implements MigrationInterface {
  name = 'MappingTables1786406400004';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ── client_application — the per-client on/off switch (Doc 01 §4.1) ───
    await queryRunner.query(`
      create table ${S}."client_application" (
        client_id      uuid        not null,
        application_id uuid        not null,
        enabled        boolean     not null default true,
        config         jsonb       not null default '{}'::jsonb,
        created_at     timestamptz not null default now(),
        updated_at     timestamptz not null default now(),
        constraint client_application_pkey primary key (client_id, application_id),
        constraint client_application_client_id_fkey
          foreign key (client_id) references ${S}."client" (id)
          on delete restrict,
        constraint client_application_application_id_fkey
          foreign key (application_id) references ${S}."application" (id)
          on delete cascade
      );
    `);
    // Disabling is \`enabled = false\`, never a delete: the row keeps the
    // client's per-app config so re-enabling restores it (Doc 02 §7).
    await queryRunner.query(`
      create trigger client_application_set_updated_at
        before update on ${S}."client_application"
        for each row execute function ${S}.set_updated_at();
    `);

    // ── role_permission (Doc 01 §4.3) ─────────────────────────────────────
    await queryRunner.query(`
      create table ${S}."role_permission" (
        role_id       uuid        not null,
        permission_id uuid        not null,
        created_at    timestamptz not null default now(),
        constraint role_permission_pkey primary key (role_id, permission_id),
        -- Doc 07 §9 — cascade when the role goes; the service writes the audit
        -- for the cascaded rows *before* deleting (Doc 10 §4).
        constraint role_permission_role_id_fkey
          foreign key (role_id) references ${S}."role" (id)
          on delete cascade,
        constraint role_permission_permission_id_fkey
          foreign key (permission_id) references ${S}."permission" (id)
          on delete cascade
      );
    `);

    // ── menu_permission (Doc 01 §4.4) ─────────────────────────────────────
    // Multiple rows per node are OR semantics: holding any one mapped
    // permission reveals the node (Doc 05 §3).
    await queryRunner.query(`
      create table ${S}."menu_permission" (
        nav_node_id   uuid        not null,
        permission_id uuid        not null,
        created_at    timestamptz not null default now(),
        constraint menu_permission_pkey primary key (nav_node_id, permission_id),
        constraint menu_permission_nav_node_id_fkey
          foreign key (nav_node_id) references ${S}."nav_node" (id)
          on delete cascade,
        constraint menu_permission_permission_id_fkey
          foreign key (permission_id) references ${S}."permission" (id)
          on delete cascade
      );
    `);

    // ── role_binding — WHO × WHAT × WHERE (Doc 01 §4.5) ───────────────────
    await queryRunner.query(`
      create table ${S}."role_binding" (
        id                 uuid        not null default gen_random_uuid(),
        client_id          uuid        not null,
        user_id            uuid,
        service_account_id uuid,
        role_id            uuid        not null,
        scope_node_id      uuid        not null,
        expires_at         timestamptz,
        created_at         timestamptz not null default now(),
        updated_at         timestamptz not null default now(),
        constraint role_binding_pkey primary key (id),
        -- Doc 01 §6.1 / Doc 07 §9 — exactly one subject. \`<>\` on two
        -- booleans is XOR; neither-set and both-set are equally rejected.
        constraint role_binding_subject_xor
          check ((user_id is not null) <> (service_account_id is not null)),
        constraint role_binding_client_id_fkey
          foreign key (client_id) references ${S}."client" (id)
          on delete restrict,
        -- The composite keys added in 0003 do the cross-tenant work here: a
        -- binding cannot name a role, a node, or a user from another tenant,
        -- whatever the service layer believes (Doc 02 §6). MATCH SIMPLE means
        -- the user FK simply does not apply when \`user_id\` is null, which is
        -- exactly the service-account arm of the XOR.
        constraint role_binding_user_id_client_id_fkey
          foreign key (user_id, client_id) references ${S}."user" (id, client_id)
          on delete cascade,
        constraint role_binding_role_id_client_id_fkey
          foreign key (role_id, client_id) references ${S}."role" (id, client_id)
          on delete cascade,
        -- Doc 07 §9 — restrict, not cascade: deleting a scope node that still
        -- grants access must fail loudly (Doc 06 §6 turns this into the 409).
        constraint role_binding_scope_node_id_client_id_fkey
          foreign key (scope_node_id, client_id)
          references ${S}."scope_node" (id, client_id)
          on delete restrict,
        -- Service accounts get a plain FK, not the composite one: a platform
        -- account has a null \`client_id\` (Doc 01 §3.7) and a composite key
        -- would make it unbindable anywhere. Same-tenant enforcement for the
        -- service-account arm is the service layer's (Session 20).
        constraint role_binding_service_account_id_fkey
          foreign key (service_account_id) references ${S}."service_account" (id)
          on delete cascade
      );
    `);
    // Doc 01 §6.7 — no duplicate binding for the same subject+role+node. An
    // expression index rather than a plain unique constraint because the
    // subject lives in whichever of the two columns is populated; \`coalesce\`
    // is immutable, so it is indexable. Binding the same subject+role at an
    // ancestor *and* a descendant stays legal (Doc 01 §4.5) — resolution
    // dedupes the covering paths instead.
    await queryRunner.query(`
      create unique index role_binding_subject_role_scope_key
        on ${S}."role_binding" (coalesce(user_id, service_account_id), role_id, scope_node_id);
    `);
    await queryRunner.query(`
      create trigger role_binding_set_updated_at
        before update on ${S}."role_binding"
        for each row execute function ${S}.set_updated_at();
    `);

    // ── user_identity — login methods (Doc 01 §4.6) ───────────────────────
    // Carries \`client_id\` because Doc 07 §6 lists it among the tables with a
    // direct-\`client_id\` RLS policy; the composite FK keeps it honest.
    await queryRunner.query(`
      create table ${S}."user_identity" (
        id               uuid        not null default gen_random_uuid(),
        client_id        uuid        not null,
        user_id          uuid        not null,
        provider         ${S}."${IAM_ENUMS.IDENTITY_PROVIDER}" not null default 'password',
        secret_hash      text,
        provider_subject text,
        created_at       timestamptz not null default now(),
        updated_at       timestamptz not null default now(),
        constraint user_identity_pkey primary key (id),
        constraint user_identity_user_id_client_id_fkey
          foreign key (user_id, client_id) references ${S}."user" (id, client_id)
          on delete cascade,
        -- A password identity without a hash is an account that cannot be
        -- authenticated but looks like it can (Doc 03 §7).
        constraint user_identity_password_has_secret
          check (provider <> 'password' or secret_hash is not null)
      );
    `);
    // One identity per provider per user: v1 has exactly one, \`password\`.
    await queryRunner.query(`
      create unique index user_identity_user_id_provider_key
        on ${S}."user_identity" (user_id, provider);
    `);
    // Reserved for the OIDC federation Doc 03 §10 defers: an external subject
    // maps to at most one identity.
    await queryRunner.query(`
      create unique index user_identity_provider_provider_subject_key
        on ${S}."user_identity" (provider, provider_subject)
        where provider_subject is not null;
    `);
    await queryRunner.query(`
      create trigger user_identity_set_updated_at
        before update on ${S}."user_identity"
        for each row execute function ${S}.set_updated_at();
    `);

    // ── session — the revocable token session (Doc 01 §4.7) ───────────────
    // \`id\` is the \`sid\` claim (Doc 03 §2). There is no \`created_at\`:
    // \`issued_at\` is the creation stamp, and two names for one instant is
    // how they drift apart.
    await queryRunner.query(`
      create table ${S}."session" (
        id                 uuid        not null default gen_random_uuid(),
        client_id          uuid        not null,
        user_id            uuid,
        service_account_id uuid,
        refresh_token_hash text,
        issued_at          timestamptz not null default now(),
        expires_at         timestamptz not null,
        revoked_at         timestamptz,
        device_label       text,
        updated_at         timestamptz not null default now(),
        constraint session_pkey primary key (id),
        constraint session_subject_xor
          check ((user_id is not null) <> (service_account_id is not null)),
        constraint session_client_id_fkey
          foreign key (client_id) references ${S}."client" (id)
          on delete restrict,
        constraint session_user_id_client_id_fkey
          foreign key (user_id, client_id) references ${S}."user" (id, client_id)
          on delete cascade,
        constraint session_service_account_id_fkey
          foreign key (service_account_id) references ${S}."service_account" (id)
          on delete cascade,
        constraint session_expires_after_issued check (expires_at > issued_at)
      );
    `);
    // Doc 03 §4 step 1 looks a session up *by* the hash, so it is indexed and
    // unique. Nullable and partial because Doc 03 §5's service tokens are
    // ephemeral — a session-backed service token would carry no refresh token.
    await queryRunner.query(`
      create unique index session_refresh_token_hash_key
        on ${S}."session" (refresh_token_hash)
        where refresh_token_hash is not null;
    `);
    await queryRunner.query(`
      create trigger session_set_updated_at
        before update on ${S}."session"
        for each row execute function ${S}.set_updated_at();
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`drop table if exists ${S}."session";`);
    await queryRunner.query(`drop table if exists ${S}."user_identity";`);
    await queryRunner.query(`drop table if exists ${S}."role_binding";`);
    await queryRunner.query(`drop table if exists ${S}."menu_permission";`);
    await queryRunner.query(`drop table if exists ${S}."role_permission";`);
    await queryRunner.query(`drop table if exists ${S}."client_application";`);
  }
}
