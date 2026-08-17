/**
 * 0017 — the IAM's own permission catalog, seeded (Doc 02 §1, §14, Doc 04 §10).
 *
 * ## The circle this exists to break
 *
 * Session 23 gates every IAM endpoint on an `iam.platform.*` / `iam.client.*`
 * permission, and Doc 02 §14 is emphatic that there is no bypass path: the
 * console calls the same authorized APIs everyone else does. The IAM's own
 * catalog is therefore supposed to arrive the way every application's does — by
 * uploading a manifest to `POST /iam/applications/:id/manifest`.
 *
 * That upload is itself gated on `iam.platform.app.manifest`. So the permission
 * that authorizes the upload can only be created *by* the upload, and nobody can
 * make the first call.
 *
 * It is migration 0011's problem exactly: "the first platform admin cannot be
 * created through the authorized API, because authorizing the call would require
 * the identity the call creates". 0011 seeded the identity and deliberately left
 * its role empty, promising that `iam.platform.*` would arrive with the manifest.
 * This migration is the half of that promise a migration has to keep — the
 * minimum that makes the first authorized call possible — and `tools/
 * seed-iam-manifest.ts` is the half the API keeps.
 *
 * ## The split, and why it is not arbitrary
 *
 * | | seeded here | uploaded by the manifest |
 * |---|---|---|
 * | the `iam` application row | ✔ | reconciled |
 * | `iam.platform.*` / `iam.client.*` permissions | ✔ | reconciled (a no-op diff) |
 * | the admin console's **nav catalog** | ✘ | ✔ |
 * | `menu_permission` mappings | ✘ | ✔ |
 *
 * The line falls where authorization does. Permissions are what the first call
 * has to *hold*, so they are bootstrapped; navigation is what the first call
 * *produces*, so it goes through the endpoint. The manifest is still the single
 * declaration of both — `apps/iam-api/src/registry/iam-manifest.spec.ts` asserts
 * that what is listed below is exactly the `permissions` half of
 * `tools/iam-manifest.json`, so the upload finds the rows already correct rather
 * than creating a second set or deactivating these (Doc 02 §7's upsert).
 *
 * ## What each grant is, and to whom
 *
 * - **The platform role** (`Platform Admin`, migration 0011) gets every
 *   `iam.platform.*` key, plus `iam.client.svc.*`. Doc 06 §10 heads the
 *   service-account surface "`iam.client.svc.*` / platform" and Doc 09 §2.4
 *   gives the platform console a service-accounts screen: a platform account
 *   creating platform-level machine identities is administering the *platform
 *   tenant*, which 0011 makes a tenant like any other.
 * - **Every existing `Client Admin` role** gets every `iam.client.*` key. Those
 *   roles were created with no permissions on the same promise (see
 *   `client-admin.service.ts`), and `user.is_client_admin` — Doc 01 §3.6's
 *   "shortcut flag; still enforced via permissions" — stops being an
 *   authorization input the moment this lands. Without the backfill every
 *   already-provisioned tenant admin would be locked out of their own tenant.
 *   Tenants provisioned *after* this get the same mapping from the service.
 * - **`client_application`** is enabled for the platform client and for every
 *   client that has an admin role, because `resolve()` drops any permission whose
 *   application is not enabled for the subject's tenant (Doc 02 §6) — an
 *   unenabled `iam` would make every key below inert.
 *
 * ## Idempotent, and RLS-obedient
 *
 * Every statement is `on conflict do nothing` / guarded, so a replay on an
 * environment that already has the rows is a no-op.
 *
 * The catalog writes need `app.is_platform_admin`; the tenant-owned writes
 * (`client_application`, `role_permission`) have policies whose `with check`
 * names `app.current_client_id` and carries **no** platform arm (migrations 0007
 * and 0009), deliberately, so that a platform action cannot land a row under the
 * wrong tenant. The per-client loop below is that policy being obeyed rather than
 * worked around — the same shape `withProvisioningTenant` gives the runtime and
 * 0016's sweep gives its audit writes.
 */

import type { MigrationInterface, QueryRunner } from 'typeorm';
import { IAM_SCHEMA } from '../schema.js';
import { PLATFORM_CLIENT_SLUG, PLATFORM_ROLE_NAME } from './0011-bootstrap-seed.js';

const S = `"${IAM_SCHEMA}"`;

/** `application.key` of the IAM's registry entry (Doc 02 §2). */
export const IAM_APPLICATION_KEY = 'iam';

export const IAM_APPLICATION_NAME = 'PlantOps IAM';

export const IAM_APPLICATION_DESCRIPTION =
  'Identity, access and the registry every other PlantOps application is described in.';

/**
 * The name `client-admin.service.ts` gives a tenant's system administration
 * role.
 *
 * Duplicated rather than imported: a migration is a frozen artefact and imports
 * nothing from the application (see `audit-actions.ts` for the same rule stated
 * from the other end). `iam-manifest.spec.ts` asserts the two strings match.
 */
export const CLIENT_ADMIN_ROLE_NAME = 'Client Admin';

/** `[key, name, description]`, in the order the manifest declares them. */
type PermissionSeed = readonly [key: string, name: string, description: string];

/** Catalog and tenant administration — bound at the platform root (Doc 04 §10). */
export const IAM_PLATFORM_PERMISSION_SEED: readonly PermissionSeed[] = [
  ['iam.platform.app.create', 'Register application', 'Add an application to the registry.'],
  ['iam.platform.app.read', 'View applications', 'List registered applications.'],
  ['iam.platform.app.update', 'Edit application', 'Rename an application or activate and deactivate it.'],
  ['iam.platform.app.manifest', 'Upload manifest', "Upsert an application's permission and navigation catalog from its manifest."],
  ['iam.platform.permission.create', 'Add permissions', "Add atomic permissions to an application's catalog."],
  ['iam.platform.permission.read', 'View permissions', "List an application's permissions."],
  ['iam.platform.nav.create', 'Add navigation nodes', "Add modules, menus and sub-menus to an application's navigation catalog."],
  ['iam.platform.nav.read', 'View navigation', "List an application's navigation tree."],
  ['iam.platform.nav.map', 'Map menu permissions', 'Decide which permissions make a navigation node visible.'],
  ['iam.platform.client.create', 'Create client', 'Provision a new tenant.'],
  ['iam.platform.client.read', 'View clients', 'List tenants.'],
  ['iam.platform.client.update', 'Edit client', 'Rename a tenant, or suspend and reactivate it.'],
  ['iam.platform.client.app.enable', 'Enable applications', 'Give a tenant access to an application.'],
  ['iam.platform.client.app.read', 'View enabled applications', 'List the applications enabled for a tenant.'],
  ['iam.platform.client.app.update', 'Toggle enabled application', "Turn one of a tenant's applications on or off."],
  ['iam.platform.client.admin.create', 'Create client admin', "Create a tenant's initial administrator."],
  ['iam.platform.audit.read', 'Read all audit', 'Read the audit trail across every tenant.'],
];

/** One tenant's own structure, people and grants (Doc 06 §6–10, §12). */
export const IAM_CLIENT_PERMISSION_SEED: readonly PermissionSeed[] = [
  ['iam.client.scope.create', 'Add scope node', 'Add a node to the organisation tree.'],
  ['iam.client.scope.read', 'View scope tree', "View the tenant's organisation tree."],
  ['iam.client.scope.update', 'Rename or move scope node', 'Rename a node, or move it and its subtree.'],
  ['iam.client.scope.delete', 'Delete scope node', 'Remove a node that has nothing anchored to it.'],
  ['iam.client.role.create', 'Create role', 'Create a role.'],
  ['iam.client.role.read', 'View roles', "List the tenant's roles."],
  ['iam.client.role.update', 'Rename role', 'Rename a role.'],
  ['iam.client.role.delete', 'Delete role', 'Delete a role and the grants that depend on it.'],
  ['iam.client.role.permission.read', 'View role permissions', "List a role's permissions."],
  ['iam.client.role.permission.set', 'Set role permissions', "Change what a role grants, everywhere it is bound."],
  ['iam.client.user.create', 'Create user', 'Add a person to the tenant.'],
  ['iam.client.user.read', 'View users', 'List and search users, and see their grants.'],
  ['iam.client.user.update', 'Edit user', 'Edit a profile, or lock, unlock and disable an account.'],
  ['iam.client.user.bulk_upload', 'Bulk upload users', 'Create many users at once from a CSV or JSON roster.'],
  ['iam.client.binding.create', 'Assign access', 'Bind a subject to a role at a scope node.'],
  ['iam.client.binding.read', 'View access', 'List who holds which role, and where.'],
  ['iam.client.binding.delete', 'Revoke access', 'Remove a grant.'],
  ['iam.client.svc.create', 'Create service account', 'Create a machine identity.'],
  ['iam.client.svc.read', 'View service accounts', 'List machine identities.'],
  ['iam.client.svc.rotate', 'Rotate service account secret', "Issue a new secret and invalidate the old one."],
  ['iam.client.svc.update', 'Revoke service account', 'Revoke or reactivate a machine identity.'],
  ['iam.client.audit.read', 'Read audit', "Read the tenant's own audit trail."],
];

/**
 * The client-tier keys the platform role also holds — see the header.
 *
 * Everything else in the client tier is a tenant's own business, and a platform
 * account holding it would be authority nobody granted through a binding.
 */
const PLATFORM_HELD_CLIENT_KEYS = [
  'iam.client.svc.create',
  'iam.client.svc.read',
  'iam.client.svc.rotate',
  'iam.client.svc.update',
] as const;

export class IamPermissionSeed1786406400017 implements MigrationInterface {
  name = 'IamPermissionSeed1786406400017';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Catalog writes are gated on the derived platform flag (migration 0008).
    // Transaction-local, so it is discarded at commit and the connection goes
    // back to the pool exactly as it was found.
    await queryRunner.query(`select set_config('app.is_platform_admin', 'true', true)`);

    const [{ id: applicationId }] = (await queryRunner.query(
      `insert into ${S}."application" (key, name, description, is_active)
       values ($1, $2, $3, true)
       on conflict (key) do update
         set name = excluded.name, description = excluded.description
       returning id`,
      [IAM_APPLICATION_KEY, IAM_APPLICATION_NAME, IAM_APPLICATION_DESCRIPTION],
    )) as { id: string }[];

    // `unnest` over three parallel arrays: one statement whatever the catalog's
    // size, and no path by which a key could reach the SQL as text.
    const seed = [...IAM_PLATFORM_PERMISSION_SEED, ...IAM_CLIENT_PERMISSION_SEED];
    await queryRunner.query(
      `insert into ${S}."permission" (application_id, key, name, description, is_active)
       select $1, p.key, p.name, p.description, true
         from unnest($2::text[], $3::text[], $4::text[]) as p(key, name, description)
       on conflict (application_id, key) do update
         set name = excluded.name,
             description = excluded.description,
             is_active = true`,
      [
        applicationId,
        seed.map(([key]) => key),
        seed.map(([, name]) => name),
        seed.map(([, , description]) => description),
      ],
    );

    // ── the platform tier ────────────────────────────────────────────────
    const [platform] = (await queryRunner.query(
      `select id from ${S}."client" where slug = $1`,
      [PLATFORM_CLIENT_SLUG],
    )) as { id: string }[];

    if (platform !== undefined) {
      await this.grant(queryRunner, platform.id, applicationId, PLATFORM_ROLE_NAME, [
        ...IAM_PLATFORM_PERMISSION_SEED.map(([key]) => key),
        ...PLATFORM_HELD_CLIENT_KEYS,
      ]);
    }

    // ── every tenant that already has an administrator ───────────────────
    //
    // Read under the platform flag, which the `client` policy's `using` arm
    // admits across tenants (0007). The *writes* below do not inherit that —
    // hence one pass per client with its own context.
    const tenants = (await queryRunner.query(
      `select distinct r.client_id as id
         from ${S}."role" r
        where r.name = $1 and r.is_system
          and r.client_id <> coalesce($2::uuid, '00000000-0000-0000-0000-000000000000'::uuid)`,
      [CLIENT_ADMIN_ROLE_NAME, platform?.id ?? null],
    )) as { id: string }[];

    const clientKeys = IAM_CLIENT_PERMISSION_SEED.map(([key]) => key);
    for (const tenant of tenants) {
      await this.grant(
        queryRunner,
        tenant.id,
        applicationId,
        CLIENT_ADMIN_ROLE_NAME,
        clientKeys,
      );
    }
  }

  /**
   * Enables the `iam` application for one client and maps `keys` onto its named
   * system role, inside that client's own RLS context.
   *
   * The context switch is what makes the `with check` arms of migrations 0007
   * and 0009 pass; it is restored to the platform's own view afterwards so that
   * the next iteration's catalog read is unaffected.
   */
  private async grant(
    queryRunner: QueryRunner,
    clientId: string,
    applicationId: string,
    roleName: string,
    keys: readonly string[],
  ): Promise<void> {
    await queryRunner.query(`select set_config('app.current_client_id', $1, true)`, [
      clientId,
    ]);

    await queryRunner.query(
      `insert into ${S}."client_application" (client_id, application_id, enabled)
       values ($1, $2, true)
       on conflict (client_id, application_id) do update set enabled = true`,
      [clientId, applicationId],
    );

    await queryRunner.query(
      `insert into ${S}."role_permission" (role_id, permission_id)
       select r.id, p.id
         from ${S}."role" r
         join ${S}."permission" p
           on p.application_id = $3 and p.key = any($4::text[])
        where r.client_id = $1 and r.name = $2 and r.is_system
       on conflict do nothing`,
      [clientId, roleName, applicationId, [...keys]],
    );

    await queryRunner.query(`select set_config('app.current_client_id', '', true)`);
  }

  /**
   * Removes the mappings and the catalog entry.
   *
   * `role_permission` cascades from `permission` (migration 0004), so deleting
   * the permissions takes every grant of them with it — which is the point: a
   * reverted seed must not leave a role claiming keys that no longer exist. The
   * `client_application` rows stay, because enabling an application for a tenant
   * is a decision an operator may have made for their own reasons and this
   * migration is not the only thing that could have made it.
   */
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`select set_config('app.is_platform_admin', 'true', true)`);
    await queryRunner.query(`delete from ${S}."application" where key = $1`, [
      IAM_APPLICATION_KEY,
    ]);
  }
}
