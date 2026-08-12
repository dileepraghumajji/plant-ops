/**
 * 0011 — the platform bootstrap seed (Doc 07 §8, Doc 00 §5.0).
 *
 * Chicken-and-egg: the first platform admin cannot be created through the
 * authorized API, because authorizing the call would require the identity the
 * call creates. So it is seeded here, once, and audited as `platform.bootstrap`.
 *
 * What it creates, and why each piece is needed:
 *
 * - **A platform `client`** (slug `platform`). Doc 04 §10 calls the platform
 *   scope "outside any client tree", but `role_binding.client_id`,
 *   `role.client_id` and `scope_node.client_id` are all NOT NULL (Doc 01), so
 *   the platform's own authority has to hang off *some* tenant row. A dedicated
 *   one keeps it out of every customer tree, which is what §10 is protecting.
 * - **A root `scope_node`** — the platform scope root that `iam.platform.*` is
 *   bound at.
 * - **A `service_account` with a null `client_id`** — platform-level per
 *   Doc 01 §3.7. Its secret comes from the environment and is never written to
 *   the database, the audit payload, or the log.
 * - **A system `role` and a `role_binding`** tying the account to the platform
 *   root. The role carries no permissions yet: `iam.platform.*` arrives when the
 *   IAM seeds its own manifest through the real endpoint in Session 23. That is
 *   deliberate dogfooding, not an omission.
 *
 * **Idempotent.** Every insert is `on conflict do nothing` / guarded, so a
 * re-run is a no-op rather than a duplicate-key failure — the migration may be
 * replayed on an environment that already has the identity.
 *
 * **It sets its own RLS context.** Every table it writes carries
 * `force row level security` (Doc 07 §5.1), which applies to the owner running
 * migrations too. Without the platform context below, each insert would be
 * refused by its own `with check`.
 */

import type { MigrationInterface, QueryRunner } from 'typeorm';
import { IAM_SCHEMA } from '../schema.js';
import { hashSecret } from '../secret-hash.js';

const S = `"${IAM_SCHEMA}"`;

/** Slug of the tenant row that carries platform-level authority. */
export const PLATFORM_CLIENT_SLUG = 'platform';

/** Name of the seeded platform role. */
export const PLATFORM_ROLE_NAME = 'Platform Admin';

/** Lookup key of the seeded platform service account (`account_key`, Doc 03 §5). */
export const PLATFORM_SERVICE_ACCOUNT_KEY = 'platform-bootstrap';

/** Env var carrying the one-time bootstrap secret (Doc 07 §8). */
export const BOOTSTRAP_SECRET_ENV = 'PLATFORM_BOOTSTRAP_SECRET';

export class BootstrapSeed1786406400011 implements MigrationInterface {
  name = 'BootstrapSeed1786406400011';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const secret = process.env[BOOTSTRAP_SECRET_ENV];
    if (secret === undefined || secret.trim().length === 0) {
      throw new Error(
        `${BOOTSTRAP_SECRET_ENV} is required to seed the platform identity (Doc 07 §8). ` +
          'Provide it out of band and rotate it immediately after first use.',
      );
    }

    // Platform context for the seed. Transaction-local (`true`), which is both
    // correct and self-cleaning: the runner applies each migration inside a
    // transaction (`migrationsTransactionMode: 'each'`), so every statement
    // below shares this context and it is discarded at commit. Session-scoped
    // settings would linger on the connection and silently re-tenant whatever
    // ran next on it.
    await queryRunner.query(`select set_config('app.is_platform_admin', 'true', true)`);

    // The platform tenant is its own chicken-and-egg: `client`'s policy is
    // `with check (id = app.current_client_id)`, so the context must already
    // name the row being inserted. The id is therefore chosen *before* the
    // insert and the context set to it — which is also what makes the seed
    // re-runnable, since an existing row's id is adopted instead.
    const existing = (await queryRunner.query(
      `select id from ${S}."client" where slug = '${PLATFORM_CLIENT_SLUG}'`,
    )) as { id: string }[];

    const [{ id: clientId }] =
      existing.length > 0
        ? existing
        : ((await queryRunner.query(`select gen_random_uuid() as id`)) as { id: string }[]);

    await queryRunner.query(`select set_config('app.current_client_id', $1, true)`, [
      clientId,
    ]);

    await queryRunner.query(`
      insert into ${S}."client" (id, name, slug, status)
      values ($1, 'Platform', '${PLATFORM_CLIENT_SLUG}', 'active')
      on conflict (id) do nothing
    `, [clientId]);

    // Root scope node. Its ltree label is id-derived (Doc 01 §3.5), so the id
    // is generated first and the path built from it.
    const [{ id: rootScopeId }] = (await queryRunner.query(`
      with existing as (
        select id from ${S}."scope_node"
         where client_id = $1 and parent_id is null
         limit 1
      ), created as (
        insert into ${S}."scope_node" (id, client_id, parent_id, kind, name, path)
        select _id, $1, null, 'group', 'Platform',
               ('n_' || replace(_id::text, '-', ''))::ltree
          from (select gen_random_uuid() as _id) g
         where not exists (select 1 from existing)
        returning id
      )
      select id from existing union all select id from created
    `, [clientId])) as { id: string }[];

    const [{ id: roleId }] = (await queryRunner.query(`
      insert into ${S}."role" (client_id, name, description, is_system)
      values ($1, '${PLATFORM_ROLE_NAME}',
              'Platform-wide authority. Permissions arrive with the IAM manifest.', true)
      on conflict (client_id, name) do update set is_system = true
      returning id
    `, [clientId])) as { id: string }[];

    // The secret is hashed before it reaches SQL, and never stored, echoed or
    // audited in the clear. argon2id via the shared hasher (Doc 03 §7) — the
    // same function Sessions 8 and 11 use for passwords and service-account
    // secrets, so there is exactly one hashing path in the system and
    // `verifySecret()` is all Session 11 needs to authenticate this account.
    const keyHash = await hashSecret(secret);

    const [{ id: serviceAccountId }] = (await queryRunner.query(`
      insert into ${S}."service_account" (client_id, name, key, key_hash, status)
      values (null, 'Platform Bootstrap', '${PLATFORM_SERVICE_ACCOUNT_KEY}',
              $1, 'active')
      on conflict (key) do update set status = 'active'
      returning id
    `, [keyHash])) as { id: string }[];

    await queryRunner.query(`
      insert into ${S}."role_binding" (client_id, service_account_id, role_id, scope_node_id)
      values ($1, $2, $3, $4)
      on conflict do nothing
    `, [clientId, serviceAccountId, roleId, rootScopeId]);

    // Audited through the same non-forgeable path everything else uses — the
    // function stamps actor and tenant from the context set above (Doc 07 §6).
    // The payload names the identity but never the secret (Doc 10 §8).
    await queryRunner.query(`
      select ${S}.write_audit(
        'platform.bootstrap',
        'service_account',
        $1,
        jsonb_build_object(
          'client_slug', '${PLATFORM_CLIENT_SLUG}',
          'account_key', '${PLATFORM_SERVICE_ACCOUNT_KEY}',
          'role', '${PLATFORM_ROLE_NAME}'
        )
      )
    `, [serviceAccountId]);

    // No explicit reset: the settings are transaction-local, so they vanish at
    // commit and the connection is handed back exactly as it was found.
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // The audit row is deliberately not removed — `platform.bootstrap` happened,
    // and audit is append-only (Doc 10 §1). Reverting the seed does not unmake
    // the history of it.
    await queryRunner.query(`select set_config('app.is_platform_admin', 'true', true)`);
    const rows = (await queryRunner.query(
      `select id from ${S}."client" where slug = '${PLATFORM_CLIENT_SLUG}'`,
    )) as { id: string }[];

    if (rows[0] !== undefined) {
      const clientId = rows[0].id;
      await queryRunner.query(`select set_config('app.current_client_id', $1, false)`, [
        clientId,
      ]);
      await queryRunner.query(`delete from ${S}."role_binding" where client_id = $1`, [
        clientId,
      ]);
      await queryRunner.query(
        `delete from ${S}."service_account" where key = '${PLATFORM_SERVICE_ACCOUNT_KEY}'`,
      );
      await queryRunner.query(`delete from ${S}."role" where client_id = $1`, [clientId]);
      await queryRunner.query(`delete from ${S}."scope_node" where client_id = $1`, [
        clientId,
      ]);
      await queryRunner.query(`delete from ${S}."client" where id = $1`, [clientId]);
    }
  }
}
