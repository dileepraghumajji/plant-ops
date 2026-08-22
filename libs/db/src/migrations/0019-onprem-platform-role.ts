/**
 * 0019 — the restricted on-prem platform role, and the identity that holds it
 * (roadmap Session 45, Doc 11 §6.4).
 *
 * On a client's own hardware nothing can be withheld technically: they hold the
 * database, the box and the credentials. Doc 11 §6.2 accepts that and takes the
 * productive move instead — make platform access *unnecessary*, and give them
 * the part of the platform tier a single-tenant install legitimately needs,
 * which is visibility and nothing that writes to the catalog.
 *
 * ## The role is assembled from keys that already exist
 *
 * Every key below is seeded by migration 0017. No permission is invented here,
 * which is the property that keeps the console working with no change: it gates
 * screen by screen on individual permissions, so an ungranted action degrades to
 * a disabled control naming the key it wanted (Doc 09 §4).
 *
 * What is deliberately **not** granted is as much the point as what is:
 * `app.create`, `app.update`, `app.manifest`, `permission.create`, `nav.create`,
 * `nav.map` — the catalog belongs to the release (Doc 11 §6.3); `client.create`,
 * `client.update`, `client.app.enable`, `client.app.update` — the tenant comes
 * from the install and its entitlements from the licence; and
 * `client.admin.create`, which is genuinely needed and is deliberately not a
 * standing permission. That last one is `tools/break-glass-admin.ts`, a host
 * command gated on the bootstrap secret and audited distinctly (Doc 11 §12
 * decision 4).
 *
 * ## Two halves, and only one of them depends on the deployment mode
 *
 * **The role definition is created unconditionally.** A role nothing is bound to
 * grants nothing to anybody: authority in this system is a `role_binding`, and
 * `derivePlatformAdmin` (`rls-context.ts`) and `resolve()` both read bindings,
 * never role rows. So the definition is inert in a SaaS deployment, and creating
 * it there costs one row and buys two things worth more than the row: the
 * migration does not branch on the environment for the part that describes *what
 * the product is*, and `apps/iam-api-e2e/src/onprem-role.e2e.ts` can bind a
 * subject to the real role rather than to a re-declaration of it.
 *
 * **The identity that holds it is created only in `single_tenant` mode**, which
 * is the acceptance criterion's "a SaaS deployment is unaffected" — no subject,
 * no authority. Reading `DEPLOYMENT_MODE` from `process.env` here follows
 * migration 0011, which reads `PLATFORM_BOOTSTRAP_SECRET` the same way and for
 * the same reason: a migration is the only step in an install with the database
 * privileges this needs, and it is handed the deployment's `.env`
 * (`deploy/docker-compose.prod.yml`, the `migrate` service).
 *
 * The cost of that is honest and documented in `deploy/README.md` §4: a database
 * migrated in `saas` mode and later switched to `single_tenant` has the role but
 * no operator, because migrations run once. Bundles ship pinned to one mode, so
 * the case is a re-configuration rather than an upgrade.
 *
 * ## Why the holder is a service account rather than a person
 *
 * Platform authority is derived from a binding **in the platform tenant**, and
 * `applyRlsContext` only looks for one when the token's `cid` is already the
 * platform client. In `single_tenant` mode `SingleTenantLoginMiddleware` refuses
 * any `client_slug` but the pinned one, so no human can hold a platform-tenant
 * session at all — a platform-tenant *user* would be an account that cannot log
 * in. A service account can: migration 0015 authenticates a `client_id is null`
 * account into the platform client, which is exactly how `platform-bootstrap`
 * works. So the on-prem operator reads through `/auth/token` and the API, not
 * through the console.
 *
 * ## Its secret is generated here and thrown away
 *
 * `key_hash` is NOT NULL, so the account needs *a* secret; it does not need one
 * anybody knows. A value taken from `.env` would put a second live credential on
 * disk beside the administrator's password, which Doc 11 §12 decision 8 already
 * names as a problem worth not repeating. So one is minted, hashed and dropped,
 * and the operator's usable credential is issued on demand through the ordinary
 * rotate endpoint — `./bootstrap.sh --onprem-credential`, printed once. Until
 * they ask for it the identity exists and authenticates as nobody.
 *
 * **Idempotent**, like every seed: each write is `on conflict` guarded, so a
 * replay against a database that already has the role changes nothing — and in
 * particular does not mint a second secret over a credential in use.
 */

import { randomBytes } from 'node:crypto';
import type { MigrationInterface, QueryRunner } from 'typeorm';
import { IAM_SCHEMA } from '../schema.js';
import { hashSecret } from '../secret-hash.js';
import { PLATFORM_CLIENT_SLUG } from './0011-bootstrap-seed.js';
import { IAM_APPLICATION_KEY } from './0017-iam-permission-seed.js';

const S = `"${IAM_SCHEMA}"`;

/** Name of the restricted platform role (Doc 11 §6.4). */
export const ONPREM_ROLE_NAME = 'On-Prem Operator';

const ONPREM_ROLE_DESCRIPTION =
  'Read-only platform visibility for a self-hosted installation. Grants no ' +
  'write to the application catalog, the tenant or its entitlements.';

/** Lookup key of the operator service account (`account_key`, Doc 03 §5). */
export const ONPREM_SERVICE_ACCOUNT_KEY = 'onprem-operator';

/** Display name of that account, as the platform console lists it. */
export const ONPREM_SERVICE_ACCOUNT_NAME = 'On-Prem Operator';

/**
 * Exactly what the role grants — Doc 11 §6.4's "Granted" table, and the closed
 * set `onprem-role.e2e.ts` asserts against.
 *
 * Every one is a `.read`. That is not a coincidence to be tidied up later: it is
 * the definition of the role, and a write key appearing here would make the
 * session's whole argument false.
 */
export const ONPREM_ROLE_PERMISSION_KEYS = [
  'iam.platform.app.read',
  'iam.platform.permission.read',
  'iam.platform.nav.read',
  'iam.platform.client.read',
  'iam.platform.client.app.read',
  'iam.platform.audit.read',
] as const;

/**
 * The two actions Session 45 adds to the trail (Doc 10 §4).
 *
 * `SEEDED` is written below. `BREAK_GLASS` is written by
 * `tools/break-glass-admin.ts`, which is a *host* command: it runs with the
 * database on one side and no Nest application on the other, so it cannot import
 * `apps/iam-api`'s catalog. `@plantops/db` is the one module both it and the app
 * can see, and `audit-actions.spec.ts` pins the two spellings together the same
 * way it does for migrations 0013–0016.
 */
export const ONPREM_AUDIT_ACTIONS = {
  /** This migration provisioning the operator identity. */
  SEEDED: 'platform.onprem_seeded',
  /** A host-level recovery of a locked-out client administrator (Doc 11 §6.4). */
  BREAK_GLASS: 'platform.break_glass',
} as const;

/** `DEPLOYMENT_MODE` value that provisions the operator identity. */
const SINGLE_TENANT_MODE = 'single_tenant';

export class OnPremPlatformRole1786406400019 implements MigrationInterface {
  name = 'OnPremPlatformRole1786406400019';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Transaction-local, as in 0011 and 0017: the runner applies each migration
    // in its own transaction, so the context is discarded at commit rather than
    // riding the pooled connection into whatever runs next.
    await queryRunner.query(`select set_config('app.is_platform_admin', 'true', true)`);

    const [platform] = (await queryRunner.query(
      `select id from ${S}."client" where slug = $1`,
      [PLATFORM_CLIENT_SLUG],
    )) as { id: string }[];

    // No platform tenant means 0011 was reverted, or this is a database the seed
    // never ran against. Nothing here has anywhere to live; a later replay of
    // 0011 does not re-run this, which is a limitation worth stating rather than
    // an error worth raising on an otherwise healthy migration.
    if (platform === undefined) return;

    // Writes to `role` and `role_permission` are checked against the tenant, not
    // against the platform flag (migrations 0007 and 0009), so the context has
    // to name the platform client itself.
    await queryRunner.query(`select set_config('app.current_client_id', $1, true)`, [
      platform.id,
    ]);

    const roleId = await this.ensureRole(queryRunner, platform.id);
    await this.grantReads(queryRunner, roleId);

    if ((process.env['DEPLOYMENT_MODE'] ?? '').trim() !== SINGLE_TENANT_MODE) {
      // A SaaS deployment stops here with a role bound to nobody. See the
      // header: that is a definition, not an authority.
      return;
    }

    await this.ensureOperator(queryRunner, platform.id, roleId);
  }

  /**
   * The role row, adopted when it is already there.
   *
   * `is_system` so the tenant cannot rename or delete it — the same protection
   * `Client Admin` and `Platform Admin` carry, and for the same reason: a role
   * an upgrade expects to find by name must still be findable by that name.
   */
  private async ensureRole(queryRunner: QueryRunner, clientId: string): Promise<string> {
    const [role] = (await queryRunner.query(
      `insert into ${S}."role" (client_id, name, description, is_system)
       values ($1, $2, $3, true)
       on conflict (client_id, name) do update
         set description = excluded.description, is_system = true
       returning id`,
      [clientId, ONPREM_ROLE_NAME, ONPREM_ROLE_DESCRIPTION],
    )) as { id: string }[];

    return role.id;
  }

  /**
   * Maps the six read permissions onto the role.
   *
   * Joined to the catalog by key rather than inserted by id, so a key that does
   * not exist maps nothing instead of failing — and `onprem-role.e2e.ts` asserts
   * the resulting set is exactly {@link ONPREM_ROLE_PERMISSION_KEYS}, which is
   * what turns "mapped nothing" from a silent hole into a red suite.
   *
   * `client_application` is not touched. Migration 0017 enables `iam` for the
   * platform client, and an operator who has since disabled it has made a
   * decision this seed has no business reversing.
   */
  private async grantReads(queryRunner: QueryRunner, roleId: string): Promise<void> {
    await queryRunner.query(
      `insert into ${S}."role_permission" (role_id, permission_id)
       select $1, p.id
         from ${S}."permission" p
         join ${S}."application" a on a.id = p.application_id
        where a.key = $2 and p.key = any($3::text[])
       on conflict do nothing`,
      [roleId, IAM_APPLICATION_KEY, [...ONPREM_ROLE_PERMISSION_KEYS]],
    );
  }

  /**
   * The identity that holds the role, in `single_tenant` mode only.
   *
   * `client_id` is null — platform-level per Doc 01 §3.7, exactly like
   * `platform-bootstrap` — while the binding's `client_id` is the platform
   * tenant, because `role_binding.client_id` is NOT NULL and the binding is what
   * makes the grant real.
   *
   * The secret is minted and discarded; see the header. The existing account is
   * looked up first and never updated, so a replay cannot overwrite the hash of
   * a credential the operator has already rotated into use.
   */
  private async ensureOperator(
    queryRunner: QueryRunner,
    clientId: string,
    roleId: string,
  ): Promise<void> {
    const [existing] = (await queryRunner.query(
      `select id from ${S}."service_account" where key = $1`,
      [ONPREM_SERVICE_ACCOUNT_KEY],
    )) as { id: string }[];

    // 32 bytes of CSPRNG output, hashed with the same argon2id hasher every
    // other credential in the system uses, and never returned to anyone. The
    // plaintext leaves scope with this statement.
    const created =
      existing === undefined
        ? ((await queryRunner.query(
            `insert into ${S}."service_account" (client_id, name, key, key_hash, status)
             values (null, $1, $2, $3, 'active')
             on conflict (key) do nothing
             returning id`,
            [
              ONPREM_SERVICE_ACCOUNT_NAME,
              ONPREM_SERVICE_ACCOUNT_KEY,
              await hashSecret(randomBytes(32).toString('base64url')),
            ],
          )) as { id: string }[])
        : [];

    const accountId = existing?.id ?? created[0]?.id;
    if (accountId === undefined) return;

    const [rootScope] = (await queryRunner.query(
      `select id from ${S}."scope_node"
        where client_id = $1 and parent_id is null
        order by created_at asc, id asc
        limit 1`,
      [clientId],
    )) as { id: string }[];

    // 0011 creates it. Its absence means the platform tenant is half-seeded, and
    // a binding needs somewhere to hang.
    if (rootScope === undefined) return;

    const [binding] = (await queryRunner.query(
      `insert into ${S}."role_binding" (client_id, service_account_id, role_id, scope_node_id)
       values ($1, $2, $3, $4)
       on conflict do nothing
       returning id`,
      [clientId, accountId, roleId, rootScope.id],
    )) as { id: string }[];

    // Nothing was inserted: the binding is already there and this is a replay.
    // Auditing again would report a provisioning that did not happen.
    if (binding === undefined) return;

    // Through the same non-forgeable path as every other record: the function
    // stamps actor and tenant from the context set above (Doc 07 §6). The
    // payload names the identity and the role, and there is no secret in it to
    // name (Doc 10 §8).
    await queryRunner.query(
      `select ${S}.write_audit(
         '${ONPREM_AUDIT_ACTIONS.SEEDED}',
         'service_account',
         $1,
         jsonb_build_object(
           'account_key', '${ONPREM_SERVICE_ACCOUNT_KEY}',
           'role', '${ONPREM_ROLE_NAME}',
           'deployment_mode', '${SINGLE_TENANT_MODE}',
           'credential', 'not issued yet'
         )
       )`,
      [accountId],
    );
  }

  /**
   * Removes the binding, the identity and the role.
   *
   * The audit row stays: `platform.onprem_seeded` happened, and audit is
   * append-only (Doc 10 §1). Reverting the seed does not unmake the history of
   * it — the same argument 0011's `down` makes.
   */
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`select set_config('app.is_platform_admin', 'true', true)`);

    const [platform] = (await queryRunner.query(
      `select id from ${S}."client" where slug = $1`,
      [PLATFORM_CLIENT_SLUG],
    )) as { id: string }[];

    if (platform === undefined) return;

    await queryRunner.query(`select set_config('app.current_client_id', $1, true)`, [
      platform.id,
    ]);

    await queryRunner.query(
      `delete from ${S}."role_binding" rb
        using ${S}."role" r
        where rb.role_id = r.id
          and r.client_id = $1
          and r.name = $2`,
      [platform.id, ONPREM_ROLE_NAME],
    );
    await queryRunner.query(`delete from ${S}."service_account" where key = $1`, [
      ONPREM_SERVICE_ACCOUNT_KEY,
    ]);
    await queryRunner.query(`delete from ${S}."role" where client_id = $1 and name = $2`, [
      platform.id,
      ONPREM_ROLE_NAME,
    ]);
  }
}
