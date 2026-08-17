/**
 * What a live suite's fixture tenant needs in order to be *authorized* since
 * Session 23.
 *
 * Before the `PermissionGuard`, a suite could seed a user with
 * `is_client_admin = true` and call any client route. That flag decided nothing
 * about access any more (Doc 01 §3.6 always called it a shortcut "still enforced
 * via permissions"), so every fixture now has to grant what production grants:
 * a role carrying the IAM's own `iam.client.*` permissions, bound to the subject
 * at a scope node, with the `iam` application enabled for the tenant.
 *
 * That is exactly what `POST /iam/clients/:id/admins` does for a real tenant.
 * The suites seed it directly rather than calling that endpoint for the reason
 * each of their headers already gives — a suite about the scope tree should not
 * fail because Session 15's provisioning endpoint changed — so the same four
 * facts are assembled here, once, instead of in eight fixture functions that
 * would drift.
 *
 * ## The role is separate from whatever the suite's own tests use
 *
 * {@link IAM_ADMIN_ROLE_NAME} is nobody's subject. Suites count permissions on
 * their own roles, list them, delete them and assert on the results; folding
 * forty `iam.client.*` mappings into one of those would change the answers to
 * questions that have nothing to do with authorization.
 *
 * ## Everything runs on the owner connection, elevated
 *
 * These writes are the ones a request could not make — `client_application` and
 * `role_permission` both have `with check` arms naming
 * `app.current_client_id` (migrations 0007 and 0009), so the context is switched
 * per tenant, exactly as migration 0017 and `withProvisioningTenant` do.
 *
 * Test-only, and excluded from `tsconfig.app.json` — nothing here ships.
 */

import { IAM_SCHEMA, scopePathLabel } from '@plantops/db';
import { randomUUID } from 'node:crypto';
import type { DataSource } from 'typeorm';

const S = `"${IAM_SCHEMA}"`;

/** The application key migration 0017 registers the IAM under. */
const IAM_APPLICATION_KEY = 'iam';

/** Every client-tier key of that catalog. */
const CLIENT_PERMISSION_PREFIX = 'iam.client.';

/** The fixture-only role that carries them. */
export const IAM_ADMIN_ROLE_NAME = 'Fixture IAM Admin';

/** Who is being granted — exactly one of the two, as a `role_binding` requires. */
export interface FixtureSubject {
  userId?: string;
  serviceAccountId?: string;
}

/**
 * Points the owner connection at one tenant, with the platform flag set.
 *
 * Session-scoped (`false`) rather than transaction-local, because a fixture
 * makes many statements outside any transaction of its own; the suites'
 * teardown drops the tenants either way.
 */
async function elevate(admin: DataSource, clientId: string): Promise<void> {
  await admin.query(`select set_config('app.is_platform_admin', 'true', false)`);
  await admin.query(`select set_config('app.current_client_id', $1, false)`, [clientId]);
}

/**
 * A root `scope_node` for a tenant that has none, with an id-derived ltree
 * label (Doc 01 §3.5).
 *
 * The same node `POST /iam/clients/:id/admins` creates, and for the same
 * reason: a tenant whose tree is empty has nowhere to bind its administrator,
 * so nobody could ever create its first node. A suite that wants to build a tree
 * over HTTP still needs somewhere to stand.
 */
export async function seedRootScopeNode(
  admin: DataSource,
  clientId: string,
  name: string,
): Promise<{ id: string; path: string }> {
  await elevate(admin, clientId);

  const id = randomUUID();
  const [row] = (await admin.query(
    `insert into ${S}."scope_node" (id, client_id, parent_id, kind, name, path)
     values ($1, $2, null, 'group', $3, $4::ltree)
     returning id, path::text as path`,
    [id, clientId, name, scopePathLabel(id)],
  )) as { id: string; path: string }[];

  return row;
}

/**
 * Gives `subject` the IAM's client-tier permissions at `scopeNodeId`.
 *
 * Idempotent, so a suite may call it once per tenant per run and again after a
 * `beforeEach` purge without tripping the unique indexes.
 *
 * @returns the id of the fixture role, for suites that want to assert on it.
 */
export async function grantIamClientAdmin(
  admin: DataSource,
  clientId: string,
  scopeNodeId: string,
  subject: FixtureSubject,
): Promise<string> {
  await elevate(admin, clientId);

  await admin.query(
    `insert into ${S}."client_application" (client_id, application_id, enabled)
     select $1, a.id, true from ${S}."application" a where a.key = $2
     on conflict (client_id, application_id) do update set enabled = true`,
    [clientId, IAM_APPLICATION_KEY],
  );

  const [role] = (await admin.query(
    `insert into ${S}."role" (client_id, name, description, is_system)
     values ($1, $2, 'Session 23 authorization fixture', true)
     on conflict (client_id, name) do update set is_system = true
     returning id`,
    [clientId, IAM_ADMIN_ROLE_NAME],
  )) as { id: string }[];

  await admin.query(
    `insert into ${S}."role_permission" (role_id, permission_id)
     select $1, p.id
       from ${S}."permission" p
       join ${S}."application" a on a.id = p.application_id
      where a.key = $2 and p.is_active and p.key like $3
     on conflict do nothing`,
    [role.id, IAM_APPLICATION_KEY, `${CLIENT_PERMISSION_PREFIX}%`],
  );

  await admin.query(
    `insert into ${S}."role_binding"
       (client_id, user_id, service_account_id, role_id, scope_node_id)
     values ($1, $2, $3, $4, $5)
     on conflict do nothing`,
    [
      clientId,
      subject.userId ?? null,
      subject.serviceAccountId ?? null,
      role.id,
      scopeNodeId,
    ],
  );

  return role.id;
}
