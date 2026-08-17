/**
 * `POST /iam/clients/:id/admins` — the first client admin (Doc 06 §5,
 * Doc 02 §3 step 3, Doc 09 §2.2).
 *
 * ## Why four rows are one endpoint
 *
 * This is the tenant's own chicken-and-egg, and the same one migration 0011
 * solves for the platform: a client admin operates entirely self-service
 * (Doc 02 §4), but every self-service call is authorized by a binding that only
 * a client admin could have created. Somebody outside the tenant has to write
 * the first one.
 *
 * "The first one" is not a single row. An access grant in this system is
 * WHO × (role → WHAT) × WHERE (Doc 01 §4.5), so the minimum viable administrator
 * is four rows that are worthless apart:
 *
 * 1. a **user**, with a password identity so they can log in at all;
 * 2. a **root `scope_node`** — the WHERE, and the top of the org tree the admin
 *    will build beneath it (Doc 06 §6);
 * 3. a **system `role`**, `is_system = true` so a tenant cannot rename or delete
 *    the thing that grants them administration;
 * 4. a **`role_binding`** tying the three together at the root, which is what
 *    makes the grant cover the whole tenant by subtree coverage.
 *
 * They are created in one request transaction, so a failure anywhere leaves a
 * tenant with no half-provisioned administrator — which would be worse than none
 * at all, since the endpoint is idempotent enough to be retried but a stray user
 * without a binding is a login that succeeds and can do nothing.
 *
 * ## The role's permissions are the IAM's own catalog
 *
 * Since Session 23 the role is mapped to every active `iam.client.*` permission
 * — ordinary `role_permission` rows, over the IAM's ordinary registry entry, so
 * a tenant administrator's authority is a grant like every other grant in the
 * system and is revoked by unmapping or unbinding rather than by a special case
 * (Doc 02 §14: "there is no privileged bypass path"). See
 * {@link ClientAdminService.grantIamClientPermissions}.
 *
 * `user.is_client_admin` is still set, and no longer decides anything: Doc 01
 * §3.6 calls it a "shortcut flag; still enforced via permissions", and the
 * permissions now exist. What reads it is the console, to decide which of the
 * two experiences of Doc 09 §1 to render.
 *
 * ## Re-running it
 *
 * The root node and the role are **adopted** when they already exist rather than
 * duplicated — a second admin for the same tenant joins the same tree under the
 * same role. Only the user is genuinely new each time, and a repeated email is
 * the 409 the per-client unique index promises. Nothing about that is a
 * concession: Doc 09 §2.2 puts this behind a *Admins* tab, and an organisation
 * with two administrators is ordinary.
 */

import { Injectable } from '@nestjs/common';
import type { ClientAdminDTO } from '@plantops/contracts';
import {
  IAM_SCHEMA,
  hashSecret,
  scopePathLabel,
  withProvisioningTenant,
} from '@plantops/db';
import { randomUUID } from 'node:crypto';
import { AUDIT_ACTIONS } from '../audit/audit-actions';
import { AuditService } from '../audit/audit.service';
import {
  IAM_APPLICATION_KEY,
  IAM_CLIENT_PERMISSION_PREFIX,
} from '../authz/iam-permissions';
import { IamException } from '../common/iam.exception';
import { entityManager } from '../common/transaction-context';
import { rethrowAsConflict } from '../registry/conflict';
import { ClientsService } from './clients.service';

const S = `"${IAM_SCHEMA}"`;

/**
 * The name of the seeded client-admin role, and the counterpart of migration
 * 0011's `PLATFORM_ROLE_NAME`.
 *
 * A constant rather than a request field: `unique (client_id, name)` makes the
 * name the thing a re-run adopts, so a caller who could choose it could
 * accidentally create a second, differently-named administration role for the
 * same tenant and leave the first one orphaned.
 */
export const CLIENT_ADMIN_ROLE_NAME = 'Client Admin';

const CLIENT_ADMIN_ROLE_DESCRIPTION =
  'Tenant administration. Permissions arrive with the IAM manifest.';

export interface CreateClientAdminInput {
  email: string;
  full_name: string;
  password: string;
  phone?: string;
  scope_name?: string;
}

interface UserRow {
  id: string;
  email: string;
  full_name: string;
  created_at: Date;
}

interface ScopeRow {
  id: string;
  name: string;
  path: string;
}

interface RoleRow {
  id: string;
  name: string;
}

@Injectable()
export class ClientAdminService {
  constructor(
    private readonly clients: ClientsService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Creates the tenant's initial administrator (Doc 06 §5).
   *
   * The password is hashed **before** the provisioning context is entered.
   * argon2id is deliberately expensive — tens of milliseconds of memory-hard
   * work — and there is no reason to hold a switched RLS context open across it.
   *
   * @throws {IamException} 404 when the client does not exist, 409 when the
   * email is already taken inside it.
   */
  async create(clientId: string, input: CreateClientAdminInput): Promise<ClientAdminDTO> {
    const client = await this.clients.findRow(clientId);
    if (client === null) throw IamException.notFound('The client');

    const secretHash = await hashSecret(input.password);
    const manager = entityManager();

    return withProvisioningTenant(manager, clientId, async () => {
      const scope = await this.rootScopeNode(clientId, input.scope_name ?? client.name);
      const role = await this.adminRole(clientId);
      await this.grantIamClientPermissions(clientId, role);

      let users: UserRow[];
      try {
        users = (await manager.query(
          `insert into ${S}."user" (client_id, email, full_name, phone, status, is_client_admin)
           values ($1, $2, $3, $4, 'active', true)
           returning id, email, full_name, created_at`,
          [clientId, input.email, input.full_name, input.phone ?? null],
        )) as UserRow[];
      } catch (error) {
        rethrowAsConflict(
          error,
          `A user with the email "${input.email}" already exists in this client`,
        );
      }

      const user = users[0];

      // Credentials live on their own row so an admin list query never carries a
      // hash through it (Doc 01 §4.6). One identity, `provider = 'password'`,
      // which is what `auth_lookup_password_identity` reads at login.
      await manager.query(
        `insert into ${S}."user_identity" (client_id, user_id, provider, secret_hash)
         values ($1, $2, 'password', $3)`,
        [clientId, user.id, secretHash],
      );

      const [binding] = (await manager.query(
        `insert into ${S}."role_binding" (client_id, user_id, role_id, scope_node_id)
         values ($1, $2, $3, $4)
         returning id`,
        [clientId, user.id, role.id, scope.id],
      )) as { id: string }[];

      // The password is not in any of these payloads, and could not be: the
      // redaction boundary denies the key outright (Doc 10 §8, `redact.ts`).
      await this.audit.record(
        AUDIT_ACTIONS.USER_CREATED,
        { type: 'user', id: user.id },
        { email: user.email, full_name: user.full_name, is_client_admin: true },
      );
      await this.audit.record(
        AUDIT_ACTIONS.ROLE_BINDING_CREATED,
        { type: 'role_binding', id: binding.id },
        {
          user_id: user.id,
          role_id: role.id,
          role_name: role.name,
          scope_node_id: scope.id,
          scope_node_path: scope.path,
        },
      );

      return {
        client_id: clientId,
        user_id: user.id,
        email: user.email,
        full_name: user.full_name,
        role_id: role.id,
        role_name: role.name,
        scope_node_id: scope.id,
        scope_node_name: scope.name,
        scope_node_path: scope.path,
        role_binding_id: binding.id,
        created_at: user.created_at.toISOString(),
      };
    });
  }

  /**
   * The client's root scope node, creating it if the tenant has none.
   *
   * The id is generated here and the ltree label built from it with
   * `scopePathLabel` — the shared definition of Doc 01 §3.5's rule, which
   * migration 0003's check constraint independently enforces. Doing it in that
   * order is what keeps a display name out of `path`: there is no step at which
   * the name is available to whatever builds the label.
   *
   * `kind = 'group'` because Doc 02 §4 describes the tree as Group → Plant →
   * Department → Gate and the root is the organisation itself.
   */
  private async rootScopeNode(clientId: string, name: string): Promise<ScopeRow> {
    const manager = entityManager();

    const [existing] = (await manager.query(
      `select id, name, path::text as path
         from ${S}."scope_node"
        where client_id = $1 and parent_id is null
        order by created_at asc, id asc
        limit 1`,
      [clientId],
    )) as ScopeRow[];

    if (existing !== undefined) return existing;

    const id = randomUUID();
    const [created] = (await manager.query(
      `insert into ${S}."scope_node" (id, client_id, parent_id, kind, name, path)
       values ($1, $2, null, 'group', $3, $4::ltree)
       returning id, name, path::text as path`,
      [id, clientId, name, scopePathLabel(id)],
    )) as ScopeRow[];

    await this.audit.record(
      AUDIT_ACTIONS.SCOPE_NODE_CREATED,
      { type: 'scope_node', id: created.id },
      { name: created.name, kind: 'group', path: created.path, parent_id: null },
    );

    return created;
  }

  /**
   * The tenant's system client-admin role, creating it if absent.
   *
   * Selected before inserting rather than upserted on `(client_id, name)`,
   * because the two cases audit differently and `role.created` must mean a role
   * was created. A concurrent second call would fail the unique index instead of
   * silently adopting — a 409 on a race that should not happen, which is the
   * honest answer.
   */
  private async adminRole(clientId: string): Promise<RoleRow> {
    const manager = entityManager();

    const [existing] = (await manager.query(
      `select id, name from ${S}."role" where client_id = $1 and name = $2`,
      [clientId, CLIENT_ADMIN_ROLE_NAME],
    )) as RoleRow[];

    if (existing !== undefined) return existing;

    let created: RoleRow;
    try {
      [created] = (await manager.query(
        `insert into ${S}."role" (client_id, name, description, is_system)
         values ($1, $2, $3, true)
         returning id, name`,
        [clientId, CLIENT_ADMIN_ROLE_NAME, CLIENT_ADMIN_ROLE_DESCRIPTION],
      )) as RoleRow[];
    } catch (error) {
      rethrowAsConflict(
        error,
        `The "${CLIENT_ADMIN_ROLE_NAME}" role is already being created for this client`,
      );
    }

    await this.audit.record(
      AUDIT_ACTIONS.ROLE_CREATED,
      { type: 'role', id: created.id },
      { name: created.name, is_system: true },
    );

    return created;
  }

  /**
   * Gives the tenant's administration role the `iam.client.*` permissions, and
   * enables the IAM for the tenant so they are not inert.
   *
   * This is the sentence this file used to end on as a promise — *"the day the
   * manifest lands, this role gets its mappings through the same
   * `PUT /roles/:id/permissions` every other role uses"* — kept, and kept here
   * rather than left to an operator. Since Session 23 every client route is
   * gated on one of these keys, so a tenant provisioned without them would have
   * an administrator who can log in and do nothing: the exact "stray user
   * without a binding" this endpoint's atomicity exists to rule out, one layer
   * up.
   *
   * `iam.platform.*` is deliberately excluded. The two tiers are the boundary
   * Doc 02 §1 draws, and it is enforced by which keys land here — a tenant
   * administers itself and nothing above it.
   *
   * Both statements are idempotent, because this endpoint is: a second
   * administrator for the same tenant adopts the same role, and re-running must
   * not double-map anything or re-announce an enablement that already happened.
   * `role_permission.set` is audited only when something actually moved, so the
   * trail says "this role's grants changed" when they did and stays quiet when
   * they did not.
   */
  private async grantIamClientPermissions(
    clientId: string,
    role: RoleRow,
  ): Promise<void> {
    const manager = entityManager();

    await manager.query(
      `insert into ${S}."client_application" (client_id, application_id, enabled)
       select $1, a.id, true from ${S}."application" a where a.key = $2
       on conflict (client_id, application_id) do nothing`,
      [clientId, IAM_APPLICATION_KEY],
    );

    // Every *active* client-tier key of the IAM's catalog, matched by prefix
    // rather than by a list held here. The catalog is data (Doc 02 §8), so a key
    // added by a later manifest upload reaches the next tenant provisioned
    // without this file changing — and one deactivated stops being granted.
    const granted = (await manager.query(
      `insert into ${S}."role_permission" (role_id, permission_id)
       select $1, p.id
         from ${S}."permission" p
         join ${S}."application" a on a.id = p.application_id
        where a.key = $2 and p.is_active and p.key like $3
       on conflict do nothing
       returning permission_id`,
      [role.id, IAM_APPLICATION_KEY, `${IAM_CLIENT_PERMISSION_PREFIX}%`],
    )) as { permission_id: string }[];

    if (granted.length === 0) return;

    await this.audit.record(
      AUDIT_ACTIONS.ROLE_PERMISSION_SET,
      { type: 'role', id: role.id },
      {
        role_name: role.name,
        added: granted.length,
        source: `${IAM_APPLICATION_KEY} client-tier catalog`,
      },
    );
  }
}
