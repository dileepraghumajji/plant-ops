/**
 * Integration tests for the tenant, mapping and audit migrations (0003–0006)
 * against a real Postgres.
 *
 * Every invariant in Doc 01 §6 and Doc 07 §9 gets a test here, and each one is
 * written as a *failing insert*: a constraint that has never been observed to
 * refuse anything is a comment. The two that matter most —
 * `role_binding`'s subject XOR and its expression unique index — are the
 * reason this file exists.
 *
 * Requires a database; skips loudly without one. See
 * `libs/db/src/testing/integration-harness.ts`.
 */

import { scopePathLabel } from '../entities/index.js';
import { IAM_SCHEMA } from '../schema.js';
import {
  connectHarness,
  describeWithDb,
  type IntegrationHarness,
} from '../testing/integration-harness.js';
import { PERFORMANCE_INDEX_NAMES } from './0006-indexes.js';

const S = IAM_SCHEMA;

/** Distinct suffix for slugs, keys and emails, so fixtures never collide. */
let counter = 0;
const uid = (): string => `${(counter += 1)}${Math.random().toString(36).slice(2, 8)}`;

describeWithDb('tenant, mapping and audit migrations against Postgres', () => {
  let harness: IntegrationHarness;

  const query: IntegrationHarness['query'] = (sql, params) => harness.query(sql, params);
  const queryOne: IntegrationHarness['queryOne'] = (sql, params) =>
    harness.queryOne(sql, params);
  const expectFailure: IntegrationHarness['expectFailure'] = (sql, params) =>
    harness.expectFailure(sql, params);

  // ── fixture builders ───────────────────────────────────────────────────

  const newClient = async (): Promise<string> =>
    (
      await queryOne<{ id: string }>(
        `insert into ${S}."client" (name, slug) values ($1, $2) returning id`,
        [`Client ${uid()}`, `c-${uid()}`],
      )
    ).id;

  const newApplication = async (): Promise<string> =>
    (
      await queryOne<{ id: string }>(
        `insert into ${S}.application (key, name) values ($1, $1) returning id`,
        [`app-${uid()}`],
      )
    ).id;

  const newPermission = async (applicationId: string): Promise<string> =>
    (
      await queryOne<{ id: string }>(
        `insert into ${S}.permission (application_id, key, name) values ($1, $2, $2) returning id`,
        [applicationId, `perm.${uid()}`],
      )
    ).id;

  /**
   * Inserts a scope node with the id-derived path migration 0003 demands,
   * built from the same `scopePathLabel` the service layer will use.
   */
  const newScopeNode = async (
    clientId: string,
    parentId: string | null = null,
    kind = 'plant',
  ): Promise<string> => {
    const { id } = await queryOne<{ id: string }>(`select gen_random_uuid() as id`);
    const label = scopePathLabel(id);
    const path =
      parentId === null
        ? label
        : `${
            (
              await queryOne<{ path: string }>(
                `select path::text as path from ${S}.scope_node where id = $1`,
                [parentId],
              )
            ).path
          }.${label}`;
    await query(
      `insert into ${S}.scope_node (id, client_id, parent_id, kind, name, path)
       values ($1, $2, $3, $4, $5, $6::ltree)`,
      [id, clientId, parentId, parentId === null ? 'group' : kind, `Node ${uid()}`, path],
    );
    return id;
  };

  const newUser = async (clientId: string): Promise<string> =>
    (
      await queryOne<{ id: string }>(
        `insert into ${S}."user" (client_id, email, full_name) values ($1, $2, 'Test User') returning id`,
        [clientId, `u-${uid()}@example.test`],
      )
    ).id;

  const newRole = async (clientId: string): Promise<string> =>
    (
      await queryOne<{ id: string }>(
        `insert into ${S}."role" (client_id, name) values ($1, $2) returning id`,
        [clientId, `Role ${uid()}`],
      )
    ).id;

  const newServiceAccount = async (clientId: string | null = null): Promise<string> =>
    (
      await queryOne<{ id: string }>(
        `insert into ${S}.service_account (client_id, name, key, key_hash)
         values ($1, $2, $3, 'hash') returning id`,
        [clientId, `Service ${uid()}`, `svc-${uid()}`],
      )
    ).id;

  /** A client with a root node, a plant beneath it, a user and a role. */
  const newTenant = async () => {
    const clientId = await newClient();
    const rootId = await newScopeNode(clientId);
    const plantId = await newScopeNode(clientId, rootId);
    return {
      clientId,
      rootId,
      plantId,
      userId: await newUser(clientId),
      roleId: await newRole(clientId),
    };
  };

  const bind = (
    clientId: string,
    subject: { userId?: string | null; serviceAccountId?: string | null },
    roleId: string,
    scopeNodeId: string,
  ) =>
    query(
      `insert into ${S}.role_binding (client_id, user_id, service_account_id, role_id, scope_node_id)
       values ($1, $2, $3, $4, $5)`,
      [
        clientId,
        subject.userId ?? null,
        subject.serviceAccountId ?? null,
        roleId,
        scopeNodeId,
      ],
    );

  beforeAll(async () => {
    harness = await connectHarness();
    await harness.rebuild();
    // A constraint suite, not an isolation suite — see the method's comment.
    await harness.relaxForcedRowSecurity();
  }, 60_000);

  afterAll(async () => {
    await harness?.dispose();
  });

  // ── schema completeness ────────────────────────────────────────────────

  describe('the schema is complete (Doc 01 §1)', () => {
    it('creates every table of the data model and nothing else', async () => {
      const rows = await query<{ table_name: string }>(
        `select table_name from information_schema.tables where table_schema = $1`,
        [S],
      );
      expect(rows.map((row) => row.table_name).sort()).toEqual([
        'application',
        'audit_trail',
        'client',
        'client_application',
        'menu_permission',
        'nav_node',
        'permission',
        'role',
        'role_binding',
        'role_permission',
        'scope_node',
        'service_account',
        'session',
        'user',
        'user_identity',
      ]);
    });

    it('gives every tenant-owned table a client_id for RLS to key off', async () => {
      // Doc 01 §6.6 — Session 5's policies are written against this column;
      // a table missing it silently drops out of tenant isolation.
      const tenantOwned = [
        'scope_node',
        'user',
        'role',
        'role_binding',
        'user_identity',
        'session',
      ];
      const rows = await query<{ table_name: string; is_nullable: string }>(
        `select table_name, is_nullable from information_schema.columns
          where table_schema = $1 and column_name = 'client_id' and table_name = any($2)`,
        [S, tenantOwned],
      );
      expect(rows.map((row) => row.table_name).sort()).toEqual([...tenantOwned].sort());
      expect(rows.every((row) => row.is_nullable === 'NO')).toBe(true);
    });
  });

  // ── the two role_binding invariants ────────────────────────────────────

  describe('role_binding subject XOR (Doc 01 §6.1, Doc 07 §9)', () => {
    it('accepts a user binding', async () => {
      const { clientId, userId, roleId, plantId } = await newTenant();
      await expect(bind(clientId, { userId }, roleId, plantId)).resolves.toBeDefined();
    });

    it('accepts a service-account binding', async () => {
      const { clientId, roleId, plantId } = await newTenant();
      const serviceAccountId = await newServiceAccount(clientId);
      await expect(
        bind(clientId, { serviceAccountId }, roleId, plantId),
      ).resolves.toBeDefined();
    });

    it('rejects a binding with no subject', async () => {
      const { clientId, roleId, plantId } = await newTenant();
      const failure = await expectFailure(
        `insert into ${S}.role_binding (client_id, role_id, scope_node_id)
         values ($1, $2, $3)`,
        [clientId, roleId, plantId],
      );
      expect(failure.code).toBe('23514');
      expect(failure.message).toContain('role_binding_subject_xor');
    });

    it('rejects a binding with both subjects', async () => {
      const { clientId, userId, roleId, plantId } = await newTenant();
      const serviceAccountId = await newServiceAccount(clientId);
      const failure = await expectFailure(
        `insert into ${S}.role_binding (client_id, user_id, service_account_id, role_id, scope_node_id)
         values ($1, $2, $3, $4, $5)`,
        [clientId, userId, serviceAccountId, roleId, plantId],
      );
      expect(failure.code).toBe('23514');
      expect(failure.message).toContain('role_binding_subject_xor');
    });
  });

  describe('role_binding duplicate prevention (Doc 01 §6.7)', () => {
    it('rejects the same user, role and node twice', async () => {
      const { clientId, userId, roleId, plantId } = await newTenant();
      await bind(clientId, { userId }, roleId, plantId);
      const failure = await expectFailure(
        `insert into ${S}.role_binding (client_id, user_id, role_id, scope_node_id)
         values ($1, $2, $3, $4)`,
        [clientId, userId, roleId, plantId],
      );
      expect(failure.code).toBe('23505');
      expect(failure.message).toContain('role_binding_subject_role_scope_key');
    });

    it('rejects the same service account, role and node twice', async () => {
      // The index keys on `coalesce(user_id, service_account_id)`, so the
      // service-account arm has to be covered too — a subject is a subject.
      const { clientId, roleId, plantId } = await newTenant();
      const serviceAccountId = await newServiceAccount(clientId);
      await bind(clientId, { serviceAccountId }, roleId, plantId);
      const failure = await expectFailure(
        `insert into ${S}.role_binding (client_id, service_account_id, role_id, scope_node_id)
         values ($1, $2, $3, $4)`,
        [clientId, serviceAccountId, roleId, plantId],
      );
      expect(failure.code).toBe('23505');
    });

    it('permits the same subject and role at an ancestor and a descendant', async () => {
      // Doc 01 §4.5 — redundant but harmless; resolution dedupes the covering
      // paths rather than the database forbidding the binding.
      const { clientId, userId, roleId, rootId, plantId } = await newTenant();
      await bind(clientId, { userId }, roleId, rootId);
      await expect(bind(clientId, { userId }, roleId, plantId)).resolves.toBeDefined();
    });

    it('permits two subjects to hold the same role at the same node', async () => {
      const { clientId, userId, roleId, plantId } = await newTenant();
      const otherUserId = await newUser(clientId);
      await bind(clientId, { userId }, roleId, plantId);
      await expect(
        bind(clientId, { userId: otherUserId }, roleId, plantId),
      ).resolves.toBeDefined();
    });

    it('permits one subject to hold two roles at the same node', async () => {
      const { clientId, userId, roleId, plantId } = await newTenant();
      const otherRoleId = await newRole(clientId);
      await bind(clientId, { userId }, roleId, plantId);
      await expect(
        bind(clientId, { userId }, otherRoleId, plantId),
      ).resolves.toBeDefined();
    });
  });

  describe('role_binding cannot reach across tenants (Doc 02 §6)', () => {
    it('refuses a role belonging to another client', async () => {
      const own = await newTenant();
      const other = await newTenant();
      const failure = await expectFailure(
        `insert into ${S}.role_binding (client_id, user_id, role_id, scope_node_id)
         values ($1, $2, $3, $4)`,
        [own.clientId, own.userId, other.roleId, own.plantId],
      );
      expect(failure.code).toBe('23503');
    });

    it('refuses a scope node belonging to another client', async () => {
      const own = await newTenant();
      const other = await newTenant();
      const failure = await expectFailure(
        `insert into ${S}.role_binding (client_id, user_id, role_id, scope_node_id)
         values ($1, $2, $3, $4)`,
        [own.clientId, own.userId, own.roleId, other.plantId],
      );
      expect(failure.code).toBe('23503');
    });

    it('refuses a user belonging to another client', async () => {
      const own = await newTenant();
      const other = await newTenant();
      const failure = await expectFailure(
        `insert into ${S}.role_binding (client_id, user_id, role_id, scope_node_id)
         values ($1, $2, $3, $4)`,
        [own.clientId, other.userId, own.roleId, own.plantId],
      );
      expect(failure.code).toBe('23503');
    });
  });

  // ── scope_node ─────────────────────────────────────────────────────────

  describe('scope_node paths (Doc 01 §3.5, Doc 07 §7)', () => {
    it('stores path as a real ltree, not text', async () => {
      const row = await queryOne<{ data_type: string; udt_name: string }>(
        `select data_type, udt_name from information_schema.columns
          where table_schema = $1 and table_name = 'scope_node' and column_name = 'path'`,
        [S],
      );
      // A text path is explicitly not an acceptable substitute (Doc 01 §3.5).
      expect(row.udt_name).toBe('ltree');
      expect(row.data_type).toBe('USER-DEFINED');
    });

    it('answers subtree coverage with <@', async () => {
      const clientId = await newClient();
      const rootId = await newScopeNode(clientId);
      const plantId = await newScopeNode(clientId, rootId);
      const gateId = await newScopeNode(clientId, plantId, 'gate');
      const otherPlantId = await newScopeNode(clientId, rootId);

      const covered = await query<{ id: string }>(
        `select id from ${S}.scope_node
          where path <@ (select path from ${S}.scope_node where id = $1)`,
        [plantId],
      );
      const ids = covered.map((row) => row.id);
      // A binding at the plant reaches its gates and nothing sideways.
      expect(ids).toContain(plantId);
      expect(ids).toContain(gateId);
      expect(ids).not.toContain(otherPlantId);
      expect(ids).not.toContain(rootId);
    });

    it('refuses a path whose own label is not id-derived', async () => {
      // The hostile case from Doc 01 §3.5: a display name in the path would
      // both mangle the ltree and make a rename rewrite every path beneath it.
      const clientId = await newClient();
      const failure = await expectFailure(
        `insert into ${S}.scope_node (client_id, kind, name, path)
         values ($1, 'group', 'Plant B', 'plantB'::ltree)`,
        [clientId],
      );
      expect(failure.code).toBe('23514');
      expect(failure.message).toContain('scope_node_path_label_is_id_derived');
    });

    it('refuses a root stored below depth one', async () => {
      const clientId = await newClient();
      const { id } = await queryOne<{ id: string }>(`select gen_random_uuid() as id`);
      const failure = await expectFailure(
        `insert into ${S}.scope_node (id, client_id, kind, name, path)
         values ($1, $2, 'group', 'Orphan', $3::ltree)`,
        [id, clientId, `n_deadbeef.${scopePathLabel(id)}`],
      );
      expect(failure.code).toBe('23514');
      expect(failure.message).toContain('scope_node_root_is_depth_one');
    });

    it('refuses a parent belonging to another client', async () => {
      const own = await newClient();
      const other = await newClient();
      const foreignRoot = await newScopeNode(other);
      const { id } = await queryOne<{ id: string }>(`select gen_random_uuid() as id`);
      const failure = await expectFailure(
        `insert into ${S}.scope_node (id, client_id, parent_id, kind, name, path)
         values ($1, $2, $3, 'plant', 'Stolen', $4::ltree)`,
        [id, own, foreignRoot, `n_deadbeef.${scopePathLabel(id)}`],
      );
      expect(failure.code).toBe('23503');
    });

    it('renames without touching the path', async () => {
      const clientId = await newClient();
      const rootId = await newScopeNode(clientId);
      const before = await queryOne<{ path: string }>(
        `select path::text as path from ${S}.scope_node where id = $1`,
        [rootId],
      );
      await query(`update ${S}.scope_node set name = 'Renamed Plant' where id = $1`, [
        rootId,
      ]);
      const after = await queryOne<{ path: string }>(
        `select path::text as path from ${S}.scope_node where id = $1`,
        [rootId],
      );
      // The whole point of id-derived labels: no cached grant is invalidated.
      expect(after.path).toBe(before.path);
    });
  });

  describe('scope_node deletion (Doc 07 §9)', () => {
    it('refuses to delete a node that still carries a binding', async () => {
      const { clientId, userId, roleId, plantId } = await newTenant();
      await bind(clientId, { userId }, roleId, plantId);
      const failure = await expectFailure(
        `delete from ${S}.scope_node where id = $1`,
        [plantId],
      );
      // Doc 06 §6 turns this restrict into the 409 the API returns.
      expect(failure.code).toBe('23503');
    });

    it('refuses to delete a node that still has children', async () => {
      const clientId = await newClient();
      const rootId = await newScopeNode(clientId);
      await newScopeNode(clientId, rootId);
      const failure = await expectFailure(`delete from ${S}.scope_node where id = $1`, [
        rootId,
      ]);
      expect(failure.code).toBe('23503');
    });

    it('deletes a leaf with no bindings', async () => {
      const clientId = await newClient();
      const rootId = await newScopeNode(clientId);
      const leafId = await newScopeNode(clientId, rootId, 'gate');
      await expect(
        query(`delete from ${S}.scope_node where id = $1`, [leafId]),
      ).resolves.toBeDefined();
    });
  });

  // ── per-tenant uniqueness ──────────────────────────────────────────────

  describe('unique(client_id, email) on user (Doc 07 §9)', () => {
    it('rejects the same email twice within one client', async () => {
      const clientId = await newClient();
      const email = `dup-${uid()}@example.test`;
      await query(
        `insert into ${S}."user" (client_id, email, full_name) values ($1, $2, 'First')`,
        [clientId, email],
      );
      const failure = await expectFailure(
        `insert into ${S}."user" (client_id, email, full_name) values ($1, $2, 'Second')`,
        [clientId, email],
      );
      expect(failure.code).toBe('23505');
      expect(failure.message).toContain('user_client_id_email_key');
    });

    it('allows the same email under two different clients', async () => {
      // Doc 01 §3.6 — intended: users are tenant-scoped and login is by
      // (client_slug, email), so there is no global user identity.
      const first = await newClient();
      const second = await newClient();
      const email = `shared-${uid()}@example.test`;
      await query(
        `insert into ${S}."user" (client_id, email, full_name) values ($1, $2, 'A')`,
        [first, email],
      );
      await expect(
        query(
          `insert into ${S}."user" (client_id, email, full_name) values ($1, $2, 'B')`,
          [second, email],
        ),
      ).resolves.toBeDefined();
    });

    it('rejects a non-lowercased email, so the uniqueness is case-insensitive', async () => {
      const clientId = await newClient();
      const failure = await expectFailure(
        `insert into ${S}."user" (client_id, email, full_name) values ($1, $2, 'Mixed')`,
        [clientId, `Mixed-${uid()}@Example.test`],
      );
      expect(failure.code).toBe('23514');
      expect(failure.message).toContain('user_email_is_lowercase');
    });

    it('defaults a new user to active', async () => {
      const clientId = await newClient();
      const row = await queryOne<{ status: string; is_client_admin: boolean }>(
        `insert into ${S}."user" (client_id, email, full_name) values ($1, $2, 'Fresh')
         returning status, is_client_admin`,
        [clientId, `fresh-${uid()}@example.test`],
      );
      expect(row).toEqual({ status: 'active', is_client_admin: false });
    });

    it('accepts each of the three account states (Doc 03 §8)', async () => {
      const clientId = await newClient();
      for (const status of ['active', 'locked', 'disabled']) {
        await expect(
          query(
            `insert into ${S}."user" (client_id, email, full_name, status)
             values ($1, $2, 'Stateful', $3)`,
            [clientId, `${status}-${uid()}@example.test`, status],
          ),
        ).resolves.toBeDefined();
      }
    });
  });

  describe('unique(client_id, name) on role (Doc 07 §9)', () => {
    it('rejects a duplicate role name within one client', async () => {
      const clientId = await newClient();
      await query(`insert into ${S}."role" (client_id, name) values ($1, 'Supervisor')`, [
        clientId,
      ]);
      const failure = await expectFailure(
        `insert into ${S}."role" (client_id, name) values ($1, 'Supervisor')`,
        [clientId],
      );
      expect(failure.code).toBe('23505');
      expect(failure.message).toContain('role_client_id_name_key');
    });

    it('allows the same role name in two clients', async () => {
      const first = await newClient();
      const second = await newClient();
      await query(`insert into ${S}."role" (client_id, name) values ($1, 'Supervisor')`, [
        first,
      ]);
      await expect(
        query(`insert into ${S}."role" (client_id, name) values ($1, 'Supervisor')`, [
          second,
        ]),
      ).resolves.toBeDefined();
    });
  });

  describe('client', () => {
    it('keeps slug globally unique', async () => {
      const slug = `slug-${uid()}`;
      await query(`insert into ${S}."client" (name, slug) values ('A', $1)`, [slug]);
      const failure = await expectFailure(
        `insert into ${S}."client" (name, slug) values ('B', $1)`,
        [slug],
      );
      expect(failure.code).toBe('23505');
    });

    it('rejects a slug that is not lowercase kebab-case', async () => {
      // It is half of a typed login credential (Doc 03 §3).
      for (const slug of ['Acme Corp', 'ACME', '-acme', 'acme-', 'ac--me']) {
        const failure = await expectFailure(
          `insert into ${S}."client" (name, slug) values ('Acme', $1)`,
          [slug],
        );
        expect(failure.code).toBe('23514');
      }
    });

    it('defaults to active with an empty config', async () => {
      const row = await queryOne<{ status: string; config: unknown }>(
        `insert into ${S}."client" (name, slug) values ('Defaults', $1)
         returning status, config`,
        [`d-${uid()}`],
      );
      expect(row).toEqual({ status: 'active', config: {} });
    });

    it('refuses to delete a client that still owns rows', async () => {
      // Tenants are suspended, never deleted (Doc 01 §3.4).
      const { clientId } = await newTenant();
      const failure = await expectFailure(`delete from ${S}."client" where id = $1`, [
        clientId,
      ]);
      expect(failure.code).toBe('23503');
    });
  });

  describe('service_account (Doc 01 §3.7, Doc 03 §5)', () => {
    it('allows a null client_id — that is a platform-level account', async () => {
      const id = await newServiceAccount(null);
      const row = await queryOne<{ client_id: string | null; status: string }>(
        `select client_id, status from ${S}.service_account where id = $1`,
        [id],
      );
      expect(row).toEqual({ client_id: null, status: 'active' });
    });

    it('keeps the lookup key globally unique', async () => {
      // `POST /auth/token` carries no tenant, so the key must resolve alone.
      const key = `svc-${uid()}`;
      await query(
        `insert into ${S}.service_account (name, key, key_hash) values ('A', $1, 'h')`,
        [key],
      );
      const failure = await expectFailure(
        `insert into ${S}.service_account (name, key, key_hash) values ('B', $1, 'h')`,
        [key],
      );
      expect(failure.code).toBe('23505');
    });

    it('requires a key hash — a secretless account cannot authenticate', async () => {
      const failure = await expectFailure(
        `insert into ${S}.service_account (name, key, key_hash) values ('A', $1, '  ')`,
        [`svc-${uid()}`],
      );
      expect(failure.code).toBe('23514');
    });
  });

  // ── mapping tables ─────────────────────────────────────────────────────

  describe('client_application (Doc 01 §4.1)', () => {
    it('is keyed by (client_id, application_id) and defaults to enabled', async () => {
      const clientId = await newClient();
      const applicationId = await newApplication();
      const row = await queryOne<{ enabled: boolean; config: unknown }>(
        `insert into ${S}.client_application (client_id, application_id)
         values ($1, $2) returning enabled, config`,
        [clientId, applicationId],
      );
      expect(row).toEqual({ enabled: true, config: {} });

      const failure = await expectFailure(
        `insert into ${S}.client_application (client_id, application_id) values ($1, $2)`,
        [clientId, applicationId],
      );
      expect(failure.code).toBe('23505');
    });

    it('survives a disable as a row, not a delete (Doc 02 §7)', async () => {
      const clientId = await newClient();
      const applicationId = await newApplication();
      await query(
        `insert into ${S}.client_application (client_id, application_id, config)
         values ($1, $2, '{"seats": 5}'::jsonb)`,
        [clientId, applicationId],
      );
      await query(
        `update ${S}.client_application set enabled = false
          where client_id = $1 and application_id = $2`,
        [clientId, applicationId],
      );
      const row = await queryOne<{ enabled: boolean; config: { seats: number } }>(
        `select enabled, config from ${S}.client_application
          where client_id = $1 and application_id = $2`,
        [clientId, applicationId],
      );
      expect(row.enabled).toBe(false);
      expect(row.config).toEqual({ seats: 5 });
    });
  });

  describe('role_permission and menu_permission (Doc 01 §4.3–4.4)', () => {
    it('rejects the same permission twice on one role', async () => {
      const clientId = await newClient();
      const roleId = await newRole(clientId);
      const permissionId = await newPermission(await newApplication());
      await query(
        `insert into ${S}.role_permission (role_id, permission_id) values ($1, $2)`,
        [roleId, permissionId],
      );
      const failure = await expectFailure(
        `insert into ${S}.role_permission (role_id, permission_id) values ($1, $2)`,
        [roleId, permissionId],
      );
      expect(failure.code).toBe('23505');
    });

    it('cascades role_permission when the role is deleted (Doc 07 §9)', async () => {
      const clientId = await newClient();
      const roleId = await newRole(clientId);
      await query(
        `insert into ${S}.role_permission (role_id, permission_id) values ($1, $2)`,
        [roleId, await newPermission(await newApplication())],
      );
      await query(`delete from ${S}."role" where id = $1`, [roleId]);
      const remaining = await query(
        `select role_id from ${S}.role_permission where role_id = $1`,
        [roleId],
      );
      expect(remaining).toHaveLength(0);
    });

    it('cascades bindings when the role is deleted', async () => {
      const { clientId, userId, roleId, plantId } = await newTenant();
      await bind(clientId, { userId }, roleId, plantId);
      await query(`delete from ${S}."role" where id = $1`, [roleId]);
      const remaining = await query(
        `select id from ${S}.role_binding where role_id = $1`,
        [roleId],
      );
      expect(remaining).toHaveLength(0);
    });

    it('maps several permissions to one nav node — OR semantics (Doc 05 §3)', async () => {
      const applicationId = await newApplication();
      const navNodeId = (
        await queryOne<{ id: string }>(
          `insert into ${S}.nav_node (application_id, kind, key, label)
           values ($1, 'menu', $2, 'Menu') returning id`,
          [applicationId, `nav.${uid()}`],
        )
      ).id;
      for (let i = 0; i < 2; i += 1) {
        await query(
          `insert into ${S}.menu_permission (nav_node_id, permission_id) values ($1, $2)`,
          [navNodeId, await newPermission(applicationId)],
        );
      }
      const rows = await query(
        `select permission_id from ${S}.menu_permission where nav_node_id = $1`,
        [navNodeId],
      );
      expect(rows).toHaveLength(2);

      await query(`delete from ${S}.nav_node where id = $1`, [navNodeId]);
      expect(
        await query(`select permission_id from ${S}.menu_permission where nav_node_id = $1`, [
          navNodeId,
        ]),
      ).toHaveLength(0);
    });
  });

  describe('user_identity (Doc 01 §4.6, Doc 03 §7)', () => {
    const newIdentity = (clientId: string, userId: string, provider = 'password') =>
      query(
        `insert into ${S}.user_identity (client_id, user_id, provider, secret_hash)
         values ($1, $2, $3, 'argon2id-hash')`,
        [clientId, userId, provider],
      );

    it('holds one identity per provider per user', async () => {
      const clientId = await newClient();
      const userId = await newUser(clientId);
      await newIdentity(clientId, userId);
      const failure = await expectFailure(
        `insert into ${S}.user_identity (client_id, user_id, provider, secret_hash)
         values ($1, $2, 'password', 'another-hash')`,
        [clientId, userId],
      );
      expect(failure.code).toBe('23505');
      expect(failure.message).toContain('user_identity_user_id_provider_key');
    });

    it('refuses a password identity with no secret hash', async () => {
      const clientId = await newClient();
      const userId = await newUser(clientId);
      const failure = await expectFailure(
        `insert into ${S}.user_identity (client_id, user_id, provider) values ($1, $2, 'password')`,
        [clientId, userId],
      );
      expect(failure.code).toBe('23514');
      expect(failure.message).toContain('user_identity_password_has_secret');
    });

    it('refuses a client_id that disagrees with the user’s', async () => {
      const clientId = await newClient();
      const other = await newClient();
      const userId = await newUser(clientId);
      const failure = await expectFailure(
        `insert into ${S}.user_identity (client_id, user_id, provider, secret_hash)
         values ($1, $2, 'password', 'h')`,
        [other, userId],
      );
      expect(failure.code).toBe('23503');
    });

    it('follows the user into deletion', async () => {
      const clientId = await newClient();
      const userId = await newUser(clientId);
      await newIdentity(clientId, userId);
      await query(`delete from ${S}."user" where id = $1`, [userId]);
      expect(
        await query(`select id from ${S}.user_identity where user_id = $1`, [userId]),
      ).toHaveLength(0);
    });
  });

  describe('session (Doc 01 §4.7, Doc 03 §6)', () => {
    const newSession = (clientId: string, userId: string, hash: string) =>
      queryOne<{ id: string }>(
        `insert into ${S}."session" (client_id, user_id, refresh_token_hash, expires_at)
         values ($1, $2, $3, now() + interval '7 days') returning id`,
        [clientId, userId, hash],
      );

    it('requires exactly one subject', async () => {
      const clientId = await newClient();
      const failure = await expectFailure(
        `insert into ${S}."session" (client_id, expires_at) values ($1, now() + interval '1 day')`,
        [clientId],
      );
      expect(failure.code).toBe('23514');
      expect(failure.message).toContain('session_subject_xor');
    });

    it('keeps the refresh-token hash unique across sessions', async () => {
      const clientId = await newClient();
      const hash = `hash-${uid()}`;
      await newSession(clientId, await newUser(clientId), hash);
      const failure = await expectFailure(
        `insert into ${S}."session" (client_id, user_id, refresh_token_hash, expires_at)
         values ($1, $2, $3, now() + interval '1 day')`,
        [clientId, await newUser(clientId), hash],
      );
      expect(failure.code).toBe('23505');
    });

    it('allows many sessions with no refresh token — service tokens (Doc 03 §5)', async () => {
      // The unique index is partial, so ephemeral sessions do not collide.
      const clientId = await newClient();
      for (let i = 0; i < 2; i += 1) {
        await expect(
          query(
            `insert into ${S}."session" (client_id, user_id, expires_at)
             values ($1, $2, now() + interval '5 minutes')`,
            [clientId, await newUser(clientId)],
          ),
        ).resolves.toBeDefined();
      }
    });

    it('refuses a session that expires before it was issued', async () => {
      const clientId = await newClient();
      const failure = await expectFailure(
        `insert into ${S}."session" (client_id, user_id, expires_at)
         values ($1, $2, now() - interval '1 hour')`,
        [clientId, await newUser(clientId)],
      );
      expect(failure.code).toBe('23514');
      expect(failure.message).toContain('session_expires_after_issued');
    });

    it('is revoked by stamping revoked_at, and survives it', async () => {
      const clientId = await newClient();
      const userId = await newUser(clientId);
      const { id } = await newSession(clientId, userId, `hash-${uid()}`);
      await query(`update ${S}."session" set revoked_at = now() where id = $1`, [id]);
      const row = await queryOne<{ revoked_at: Date | null }>(
        `select revoked_at from ${S}."session" where id = $1`,
        [id],
      );
      expect(row.revoked_at).not.toBeNull();
    });
  });

  // ── audit_trail ────────────────────────────────────────────────────────

  describe('audit_trail is insert-only in shape (Doc 01 §6.5, Doc 10 §1)', () => {
    it('has no updated_at column', async () => {
      const rows = await query<{ column_name: string }>(
        `select column_name from information_schema.columns
          where table_schema = $1 and table_name = 'audit_trail'`,
        [S],
      );
      const names = rows.map((row) => row.column_name);
      expect(names).toContain('created_at');
      expect(names).not.toContain('updated_at');
    });

    it('has no update trigger, unlike every other table', async () => {
      // Its absence is the point: there is no update path to stamp.
      const triggers = await query<{ tgname: string }>(
        `select t.tgname from pg_trigger t
           join pg_class c on c.oid = t.tgrelid
           join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = $1 and c.relname = 'audit_trail' and not t.tgisinternal`,
        [S],
      );
      expect(triggers).toHaveLength(0);
    });

    it('holds no foreign keys — audit outlives what it describes', async () => {
      const constraints = await query<{ conname: string }>(
        `select con.conname from pg_constraint con
           join pg_class c on c.oid = con.conrelid
           join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = $1 and c.relname = 'audit_trail' and con.contype = 'f'`,
        [S],
      );
      expect(constraints).toHaveLength(0);
    });

    it('records a platform action with a null client_id', async () => {
      const row = await queryOne<{ client_id: string | null; payload: unknown }>(
        `insert into ${S}.audit_trail (actor_type, action)
         values ('platform', 'platform.bootstrap') returning client_id, payload`,
      );
      expect(row).toEqual({ client_id: null, payload: {} });
    });

    it('rejects a blank action', async () => {
      const failure = await expectFailure(
        `insert into ${S}.audit_trail (actor_type, action) values ('platform', '   ')`,
      );
      expect(failure.code).toBe('23514');
    });

    it('rejects a target id with no target type', async () => {
      const failure = await expectFailure(
        `insert into ${S}.audit_trail (actor_type, action, target_id)
         values ('user', 'role.created', gen_random_uuid())`,
      );
      expect(failure.code).toBe('23514');
      expect(failure.message).toContain('audit_trail_target_is_typed');
    });

    it('accepts each actor type of Doc 01 §4.8', async () => {
      for (const actorType of ['user', 'service_account', 'platform']) {
        await expect(
          query(
            `insert into ${S}.audit_trail (actor_type, action) values ($1, 'test.action')`,
            [actorType],
          ),
        ).resolves.toBeDefined();
      }
    });
  });

  // ── indexes ────────────────────────────────────────────────────────────

  describe('indexes (Doc 07 §10)', () => {
    it('creates every index migration 0006 declares', async () => {
      const rows = await query<{ indexname: string }>(
        `select indexname from pg_indexes where schemaname = $1`,
        [S],
      );
      const present = new Set(rows.map((row) => row.indexname));
      for (const name of PERFORMANCE_INDEX_NAMES) {
        expect(present.has(name)).toBe(true);
      }
    });

    it('indexes scope_node.path with GiST, not btree', async () => {
      // btree cannot answer `<@`, so the wrong access method here silently
      // turns every resolve into a sequential scan of the org tree.
      const row = await queryOne<{ amname: string }>(
        `select am.amname from pg_class i
           join pg_am am on am.oid = i.relam
           join pg_namespace n on n.oid = i.relnamespace
          where n.nspname = $1 and i.relname = 'scope_node_path_gist'`,
        [S],
      );
      expect(row.amname).toBe('gist');
    });
  });
});
