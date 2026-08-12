/**
 * Integration tests for the registry migrations against a real Postgres —
 * a constraint is only real once the database refuses the insert.
 *
 * Requires a database; skips loudly without one. See
 * `libs/db/src/testing/integration-harness.ts` for how to point it at a
 * scratch database, and for why the suite is destructive.
 */

import { MIGRATIONS_TABLE_NAME } from '../data-source.js';
import { IAM_SCHEMA } from '../schema.js';
import { connectHarness, describeWithDb, type IntegrationHarness } from '../testing/integration-harness.js';
import { migrations } from './index.js';

describeWithDb('registry migrations against Postgres', () => {
  let harness: IntegrationHarness;

  const query: IntegrationHarness['query'] = (sql, params) => harness.query(sql, params);
  const queryOne: IntegrationHarness['queryOne'] = (sql, params) =>
    harness.queryOne(sql, params);
  const expectFailure: IntegrationHarness['expectFailure'] = (sql, params) =>
    harness.expectFailure(sql, params);

  const newApplication = async (key: string): Promise<string> =>
    (
      await queryOne<{ id: string }>(
        `insert into ${IAM_SCHEMA}.application (key, name) values ($1, $2) returning id`,
        [key, key],
      )
    ).id;

  beforeAll(async () => {
    harness = await connectHarness();
    await harness.rebuild();
  }, 60_000);

  afterAll(async () => {
    await harness?.dispose();
  });

  describe('0001 — extensions, schema, enums', () => {
    it('installs ltree and pgcrypto', async () => {
      const rows = await query<{ extname: string }>(
        `select extname from pg_extension where extname in ('ltree', 'pgcrypto')`,
      );
      expect(rows.map((row) => row.extname).sort()).toEqual(['ltree', 'pgcrypto']);
    });

    it('leaves the ltree type resolvable from the connection search_path', async () => {
      // Presence in pg_extension is not enough: a managed host may install an
      // extension into a schema the connecting role does not search, and
      // Session 4's `scope_node.path ltree` column would then fail to resolve.
      const [row] = await query<{ covered: boolean }>(
        `select ('a.b.c'::ltree <@ 'a'::ltree) as covered`,
      );
      expect(row?.covered).toBe(true);
    });

    it('has gen_random_uuid available for the primary-key defaults', async () => {
      const [row] = await query<{ id: string }>(`select gen_random_uuid() as id`);
      expect(row?.id).toMatch(/^[0-9a-f-]{36}$/);
    });

    it('creates every enum up front, including ones no table uses yet', async () => {
      const rows = await query<{ typname: string }>(
        `select t.typname from pg_type t
           join pg_namespace n on n.oid = t.typnamespace
          where n.nspname = $1 and t.typtype = 'e'`,
        [IAM_SCHEMA],
      );
      expect(rows.map((row) => row.typname).sort()).toEqual([
        'audit_actor_type',
        'client_status',
        'identity_provider',
        'nav_node_kind',
        'scope_node_kind',
        'service_account_status',
        'user_status',
      ]);
    });
  });

  describe('0002 — registry tables', () => {
    it('creates the three catalog tables in the iam schema', async () => {
      const rows = await query<{ table_name: string }>(
        `select table_name from information_schema.tables where table_schema = $1`,
        [IAM_SCHEMA],
      );
      // A subset check: later migrations add the tenant, mapping and audit
      // tables to the same schema. The exact full set is asserted once, in
      // `tenant-tables.integration.spec.ts`.
      expect(rows.map((row) => row.table_name)).toEqual(
        expect.arrayContaining(['application', 'nav_node', 'permission']),
      );
    });

    it('applies the documented defaults', async () => {
      const id = await newApplication('defaults-app');
      const [navNode] = await query<{
        is_public: boolean;
        is_active: boolean;
        sort_order: number;
        route: string | null;
        parent_id: string | null;
      }>(
        `insert into ${IAM_SCHEMA}.nav_node (application_id, kind, key, label)
         values ($1, 'module', 'root', 'Root')
         returning is_public, is_active, sort_order, route, parent_id`,
        [id],
      );
      expect(navNode).toEqual({
        is_public: false,
        is_active: true,
        sort_order: 0,
        route: null,
        parent_id: null,
      });

      const [application] = await query<{ is_active: boolean; config: unknown }>(
        `select is_active, config from ${IAM_SCHEMA}.application where id = $1`,
        [id],
      );
      expect(application).toEqual({ is_active: true, config: {} });
    });

    it('stamps updated_at on write', async () => {
      const id = await newApplication('touch-app');
      const before = await queryOne<{ created_at: Date; updated_at: Date }>(
        `select created_at, updated_at from ${IAM_SCHEMA}.application where id = $1`,
        [id],
      );
      await query(`update ${IAM_SCHEMA}.application set name = 'Renamed' where id = $1`, [id]);
      const after = await queryOne<{ updated_at: Date }>(
        `select updated_at from ${IAM_SCHEMA}.application where id = $1`,
        [id],
      );
      expect(after.updated_at.getTime()).toBeGreaterThanOrEqual(
        before.updated_at.getTime(),
      );
    });
  });

  describe('unique(application_id, key) — Doc 01 §6.3', () => {
    it('rejects a duplicate permission key within one application', async () => {
      const id = await newApplication('perm-dup-app');
      await query(
        `insert into ${IAM_SCHEMA}.permission (application_id, key, name)
         values ($1, 'perm.dc.approve', 'Approve')`,
        [id],
      );
      const failure = await expectFailure(
        `insert into ${IAM_SCHEMA}.permission (application_id, key, name)
         values ($1, 'perm.dc.approve', 'Approve again')`,
        [id],
      );
      expect(failure.code).toBe('23505');
      expect(failure.message).toContain('permission_application_id_key_key');
    });

    it('allows the same permission key under a different application', async () => {
      const first = await newApplication('perm-scope-a');
      const second = await newApplication('perm-scope-b');
      const shared = 'shared.resource.action';
      await query(
        `insert into ${IAM_SCHEMA}.permission (application_id, key, name) values ($1, $2, 'A')`,
        [first, shared],
      );
      await expect(
        query(
          `insert into ${IAM_SCHEMA}.permission (application_id, key, name) values ($1, $2, 'B')`,
          [second, shared],
        ),
      ).resolves.toBeDefined();
    });

    it('rejects a duplicate nav_node key within one application', async () => {
      const id = await newApplication('nav-dup-app');
      await query(
        `insert into ${IAM_SCHEMA}.nav_node (application_id, kind, key, label)
         values ($1, 'menu', 'dc.create', 'New DC')`,
        [id],
      );
      const failure = await expectFailure(
        `insert into ${IAM_SCHEMA}.nav_node (application_id, kind, key, label)
         values ($1, 'menu', 'dc.create', 'New DC again')`,
        [id],
      );
      expect(failure.code).toBe('23505');
      expect(failure.message).toContain('nav_node_application_id_key_key');
    });

    it('keeps application.key globally unique', async () => {
      await newApplication('globally-unique');
      const failure = await expectFailure(
        `insert into ${IAM_SCHEMA}.application (key, name) values ('globally-unique', 'Clash')`,
      );
      expect(failure.code).toBe('23505');
    });
  });

  describe('nav_node tree integrity (Doc 01 §3.3)', () => {
    it('accepts only the three declared kinds', async () => {
      const id = await newApplication('nav-kind-app');
      for (const kind of ['module', 'menu', 'sub_menu']) {
        await query(
          `insert into ${IAM_SCHEMA}.nav_node (application_id, kind, key, label)
           values ($1, $2, $3, 'Node')`,
          [id, kind, `k-${kind}`],
        );
      }
      const failure = await expectFailure(
        `insert into ${IAM_SCHEMA}.nav_node (application_id, kind, key, label)
         values ($1, 'dashboard', 'k-bogus', 'Node')`,
        [id],
      );
      // 22P02 — invalid input value for enum.
      expect(failure.code).toBe('22P02');
    });

    it('links a child to its parent within the application', async () => {
      const id = await newApplication('nav-parent-app');
      const parent = await queryOne<{ id: string }>(
        `insert into ${IAM_SCHEMA}.nav_node (application_id, kind, key, label)
         values ($1, 'module', 'mod', 'Module') returning id`,
        [id],
      );
      const child = await queryOne<{ parent_id: string }>(
        `insert into ${IAM_SCHEMA}.nav_node (application_id, parent_id, kind, key, label)
         values ($1, $2, 'menu', 'mod.child', 'Child') returning parent_id`,
        [id, parent.id],
      );
      expect(child.parent_id).toBe(parent.id);
    });

    it('refuses a parent belonging to a different application', async () => {
      const owner = await newApplication('nav-cross-owner');
      const other = await newApplication('nav-cross-other');
      const foreignParent = await queryOne<{ id: string }>(
        `insert into ${IAM_SCHEMA}.nav_node (application_id, kind, key, label)
         values ($1, 'module', 'foreign', 'Foreign') returning id`,
        [other],
      );
      const failure = await expectFailure(
        `insert into ${IAM_SCHEMA}.nav_node (application_id, parent_id, kind, key, label)
         values ($1, $2, 'menu', 'stolen', 'Stolen')`,
        [owner, foreignParent.id],
      );
      // 23503 — foreign key violation on the composite (parent_id, application_id).
      expect(failure.code).toBe('23503');
    });

    it('refuses a node that parents itself', async () => {
      const id = await newApplication('nav-self-app');
      const node = await queryOne<{ id: string }>(
        `insert into ${IAM_SCHEMA}.nav_node (application_id, kind, key, label)
         values ($1, 'module', 'self', 'Self') returning id`,
        [id],
      );
      const failure = await expectFailure(
        `update ${IAM_SCHEMA}.nav_node set parent_id = id where id = $1`,
        [node.id],
      );
      expect(failure.code).toBe('23514');
      expect(failure.message).toContain('nav_node_parent_id_not_self');
    });

    it('takes the subtree with a deleted container', async () => {
      const id = await newApplication('nav-cascade-app');
      const root = await queryOne<{ id: string }>(
        `insert into ${IAM_SCHEMA}.nav_node (application_id, kind, key, label)
         values ($1, 'module', 'c.root', 'Root') returning id`,
        [id],
      );
      await query(
        `insert into ${IAM_SCHEMA}.nav_node (application_id, parent_id, kind, key, label)
         values ($1, $2, 'menu', 'c.leaf', 'Leaf')`,
        [id, root.id],
      );
      await query(`delete from ${IAM_SCHEMA}.nav_node where id = $1`, [root.id]);
      const remaining = await query(
        `select id from ${IAM_SCHEMA}.nav_node where application_id = $1`,
        [id],
      );
      expect(remaining).toHaveLength(0);
    });
  });

  describe('blank-key guards', () => {
    it.each([
      ['application', `insert into ${IAM_SCHEMA}.application (key, name) values ('   ', 'Blank')`],
    ])('rejects a whitespace-only key on %s', async (_table, sql) => {
      const failure = await expectFailure(sql);
      expect(failure.code).toBe('23514');
    });
  });

  describe('the chain reverts cleanly (Doc 07 §4)', () => {
    it('undoes every migration and leaves no iam schema behind', async () => {
      for (let i = 0; i < migrations.length; i += 1) {
        await harness.dataSource.undoLastMigration({ transaction: 'each' });
      }

      const schemas = await query<{ nspname: string }>(
        `select nspname from pg_namespace where nspname = $1`,
        [IAM_SCHEMA],
      );
      expect(schemas).toHaveLength(0);

      const applied = await query<{ name: string }>(
        `select name from "${MIGRATIONS_TABLE_NAME}"`,
      );
      expect(applied).toHaveLength(0);
    }, 60_000);

    it('re-applies from scratch afterwards', async () => {
      const applied = await harness.dataSource.runMigrations({ transaction: 'each' });
      expect(applied.map((migration) => migration.name)).toEqual(
        [...migrations].map((migration) => migration.name),
      );
    }, 60_000);
  });
});
