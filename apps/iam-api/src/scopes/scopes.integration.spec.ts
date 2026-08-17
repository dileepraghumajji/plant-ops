/**
 * The Session 16 Definition of Done: **a deep tree built, renamed, moved and
 * guarded over HTTP**, including a move that races binding inserts into the same
 * subtree (Doc 01 §3.5, Doc 06 §6, Doc 07 §7, Doc 04 §7.1).
 *
 * Every claim this session makes is a claim about Postgres. That a path label is
 * id-derived even when the display name is `"Gate-3"`; that a rename leaves
 * `path` untouched; that one `subpath` statement rewrites a whole subtree
 * consistently; that `<@` coverage still holds afterwards; that a delete is
 * refused while bindings hang off the node; and — the one that matters most —
 * that the invalidation hook fires *after* the commit and not before. A fake
 * database can express none of them, so this suite runs against a real one:
 *
 *   pg_ctl start                # a local Postgres 17 (see .env)
 *   npm run migration:run
 *   npx nx test @plantops/iam-api
 *
 * **Destructive within its own fixtures only.** Every client it creates is
 * slugged `s16-…` and is removed afterwards with the rows that hang off it.
 *
 * ## The caller is a tenant's own client admin
 *
 * Unlike Sessions 13–15, this is a *client*-tier surface (Doc 06 §6): the
 * subject is a user of the tenant, logged in at `POST /auth/login`, and the
 * tenant comes from that token's `cid`. Nothing is asserted into the RLS context
 * by the suite — the second tenant exists precisely so that "another client's
 * node is invisible" is tested rather than assumed.
 *
 * ## Deliberate deviations from the shipped configuration
 *
 * - **Rate limiting is off.** These cases make dozens of calls, and `PATCH` is
 *   deliberately capped at ten a minute in production.
 * - **`GrantInvalidationService.publish` is spied on** in the ordering test, and
 *   the spy reads the database *on another connection* to see whether the move
 *   had committed by the time it ran. That is the assertion; the stub's own body
 *   is a log line and has nothing to prove.
 * - **Nothing else.** The interim permission rule, the validation pipe, the
 *   isolation level, the retry and the audit path are the shipped ones.
 */

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { loadEnv } from '@plantops/config';
import {
  IamErrorCode,
  MAX_SCOPE_TREE_DEPTH,
  SCOPE_PATH_LABEL_PREFIX,
  type IamErrorResponse,
  type ScopeNodeDTO,
  type ScopeTreeResponse,
  type TokenPairResponse,
} from '@plantops/contracts';
import {
  IAM_SCHEMA,
  IAM_SCHEMA_TEST_LOCK_ID,
  createMigrationDataSource,
  hashSecret,
  scopePathLabel,
} from '@plantops/db';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { DataSource } from 'typeorm';
import { AppModule } from '../app/app.module';
import { AUDIT_ACTIONS } from '../audit/audit-actions';
import { GrantInvalidationService } from '../authz/invalidation.service';
import { ENV } from '../config/config.module';
import { createTestApplication } from '../testing/app-harness';
import {
  grantIamClientAdmin,
  seedRootScopeNode,
} from '../testing/authorization.fixture';

const S = `"${IAM_SCHEMA}"`;

const PLACEHOLDER = /REPLACE_ME|[[\]<>]/;
const usable = (url: string | undefined) =>
  url !== undefined &&
  /^postgres(ql)?:\/\/\S+@\S+/.test(url.trim()) &&
  !PLACEHOLDER.test(url);

const configured =
  usable(process.env['DATABASE_URL']) && usable(process.env['DATABASE_DIRECT_URL']);

const describeWithDb = configured ? describe : describe.skip;

const PASSWORD = 'correct-horse-battery-staple';

/** Everything this suite creates carries this prefix. */
const SLUG_PREFIX = 's16-';

/** One tenant, with the three identities the cases need. */
interface Tenant {
  clientId: string;
  slug: string;
  /** `is_client_admin` — the caller for almost every case. */
  adminEmail: string;
  adminUserId: string;
  /** An ordinary user, to prove the interim authorization refuses one. */
  memberEmail: string;
  /** A role, so bindings have something to bind. */
  roleId: string;
  /**
   * The tenant's root node, re-seeded before every case.
   *
   * Since Session 23 a client route is gated on an `iam.client.*` permission,
   * which is held through a binding — and a binding needs a node. A tenant with
   * an empty tree therefore has nowhere to authorize its own administrator from,
   * which is not a gap: `POST /iam/clients/:id/admins` creates the root *and*
   * the binding together, precisely so that this state never occurs in
   * production. The fixture seeds the same pair, and the cases below build the
   * rest of the tree beneath it over HTTP, as they always did.
   */
  rootId: string;
}

interface Fixture {
  acme: Tenant;
  /** A second tenant, whose nodes must be invisible to Acme's admin. */
  other: Tenant;
}

/** A node as the database has it — the shape the assertions are written against. */
interface NodeRow {
  id: string;
  parent_id: string | null;
  name: string;
  path: string;
}

describeWithDb(
  `scope tree APIs (${configured ? 'live' : 'skipped: no DATABASE_URL'})`,
  () => {
    let app: INestApplication;
    let baseUrl: string;
    let admin: DataSource;
    let fixture: Fixture;
    let invalidation: GrantInvalidationService;

    jest.setTimeout(180_000);

    beforeAll(async () => {
      const env = loadEnv();

      admin = createMigrationDataSource(env);
      await admin.initialize();
      await admin.query('select pg_advisory_lock($1)', [IAM_SCHEMA_TEST_LOCK_ID]);
      await purge(admin);

      const secretHash = await hashSecret(PASSWORD);
      fixture = {
        acme: await seedTenant(admin, 'acme', secretHash),
        other: await seedTenant(admin, 'other', secretHash),
      };

      const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(ENV)
        .useValue({ ...env, RATE_LIMIT_ENABLED: false })
        .compile();

      app = createTestApplication(moduleRef);
      await app.init();
      await app.listen(0);
      baseUrl = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
      invalidation = app.get(GrantInvalidationService);
    });

    afterAll(async () => {
      await app?.close();
      if (admin?.isInitialized) {
        await purge(admin);
        await admin.query('select pg_advisory_unlock($1)', [IAM_SCHEMA_TEST_LOCK_ID]);
        await admin.destroy();
      }
    });

    beforeEach(async () => {
      jest.restoreAllMocks();
      // A clean tree before every case. The tenants themselves are seeded once:
      // logging in is the slowest thing here (argon2id, by design).
      await clearTrees(admin, [fixture.acme, fixture.other]);
    });

    // ── the wire ──────────────────────────────────────────────────────────

    const login = async (email: string, slug: string): Promise<string> => {
      const response = await fetch(`${baseUrl}/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, password: PASSWORD, client_slug: slug }),
      });
      expect(response.status).toBe(200);
      return ((await response.json()) as TokenPairResponse).access_token;
    };

    const asAdmin = (tenant: Tenant = fixture.acme) =>
      login(tenant.adminEmail, tenant.slug);

    const call = (
      token: string,
      method: string,
      path: string,
      body?: unknown,
    ): Promise<Response> =>
      fetch(`${baseUrl}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });

    const errorCodeOf = async (response: Response): Promise<string> =>
      ((await response.json()) as IamErrorResponse).error.code;

    /** Creates a node and asserts the 201, returning the DTO. */
    const created = async (
      token: string,
      body: Record<string, unknown>,
    ): Promise<ScopeNodeDTO> => {
      const response = await call(token, 'POST', '/iam/scopes', body);
      expect(response.status).toBe(201);
      return (await response.json()) as ScopeNodeDTO;
    };

    /**
     * Group → Plant → Department → Gate, plus a second group to move into.
     *
     * The names are deliberately hostile: every one of them would be illegal or
     * mangled as an ltree label (Doc 01 §3.5).
     */
    /** The tenant's seeded root, as the API reports it. */
    const rootOf = async (token: string): Promise<ScopeNodeDTO> => {
      const response = await call(token, 'GET', '/iam/scopes');
      expect(response.status).toBe(200);
      const [root] = ((await response.json()) as ScopeTreeResponse).tree;
      expect(root).toBeDefined();
      return root as ScopeNodeDTO;
    };

    const buildTree = async (token: string) => {
      const group = await rootOf(token);
      const otherGroup = await created(token, {
        parent_id: group.id,
        kind: 'group',
        name: 'Acme Group — West',
      });
      const plant = await created(token, {
        parent_id: group.id,
        kind: 'plant',
        name: 'Plant B',
      });
      const department = await created(token, {
        parent_id: plant.id,
        kind: 'department',
        name: 'Dispatch & Logistics',
      });
      const gate = await created(token, {
        parent_id: department.id,
        kind: 'gate',
        name: 'Gate-3',
      });

      return { group, otherGroup, plant, department, gate };
    };

    // ── inspection, through the owner connection ──────────────────────────

    const nodesOf = async (tenant: Tenant): Promise<NodeRow[]> => {
      await elevate(admin, tenant.clientId);
      return (await admin.query(
        `select id, parent_id, name, path::text as path
           from ${S}."scope_node" where client_id = $1 order by path`,
        [tenant.clientId],
      )) as NodeRow[];
    };

    const pathOf = async (tenant: Tenant, id: string): Promise<string | null> => {
      await elevate(admin, tenant.clientId);
      const rows = (await admin.query(
        `select path::text as path from ${S}."scope_node" where id = $1`,
        [id],
      )) as { path: string }[];
      return rows[0]?.path ?? null;
    };

    /**
     * How many nodes are still structurally wrong.
     *
     * The whole-tree invariant, in one statement: a node's path is its parent's
     * path plus its own id-derived label, and a root's path is that label alone.
     * Anything a rewrite got wrong — a shifted label, a missed descendant, a
     * half-applied move — shows up here as a non-zero count, which is exactly
     * what the concurrency case needs and what no per-row assertion could catch.
     */
    const brokenNodes = async (tenant: Tenant): Promise<number> => {
      await elevate(admin, tenant.clientId);
      const rows = (await admin.query(
        `select count(*)::int as broken
           from ${S}."scope_node" c
           left join ${S}."scope_node" p on p.id = c.parent_id
          where c.client_id = $1
            and c.path::text <> coalesce(p.path::text || '.', '')
                                 || ('${SCOPE_PATH_LABEL_PREFIX}' || replace(c.id::text, '-', ''))`,
        [tenant.clientId],
      )) as { broken: number }[];
      return rows[0]?.broken ?? 0;
    };

    /** Bindings anchored anywhere in the subtree at `path` — the `<@` coverage test. */
    const bindingsUnder = async (tenant: Tenant, path: string): Promise<number> => {
      await elevate(admin, tenant.clientId);
      const rows = (await admin.query(
        `select count(*)::int as total
           from ${S}."role_binding" rb
           join ${S}."scope_node" sn on sn.id = rb.scope_node_id
          where rb.client_id = $1 and sn.path <@ $2::ltree`,
        [tenant.clientId, path],
      )) as { total: number }[];
      return rows[0]?.total ?? 0;
    };

    const auditFor = async (
      tenant: Tenant,
      action: string,
    ): Promise<Record<string, unknown>[]> => {
      await elevate(admin, tenant.clientId);
      const rows = (await admin.query(
        `select payload from ${S}."audit_trail"
          where client_id = $1 and action = $2
          order by created_at asc, id asc`,
        [tenant.clientId, action],
      )) as { payload: Record<string, unknown> }[];
      return rows.map((row) => row.payload);
    };

    // ── the tree, built over HTTP ─────────────────────────────────────────

    describe('building the tree', () => {
      it('derives every label from the node id, never from its display name', async () => {
        const token = await asAdmin();
        const tree = await buildTree(token);

        // The acceptance criterion, stated twice: what the path *is*, and what
        // it demonstrably is not. Every one of these names would break or mangle
        // an ltree label, and none of them appears in a path.
        expect(tree.group.path).toBe(scopePathLabel(tree.group.id));
        expect(tree.plant.path).toBe(
          `${scopePathLabel(tree.group.id)}.${scopePathLabel(tree.plant.id)}`,
        );
        expect(tree.gate.path).toBe(
          [tree.group, tree.plant, tree.department, tree.gate]
            .map((node) => scopePathLabel(node.id))
            .join('.'),
        );

        for (const node of Object.values(tree)) {
          expect(node.path).toMatch(/^n_[0-9a-f]{32}(\.n_[0-9a-f]{32})*$/);
        }
        for (const name of ['Plant B', 'Gate-3', 'Dispatch', 'Logistics', 'West']) {
          expect(tree.gate.path).not.toContain(name);
        }

        expect(await brokenNodes(fixture.acme)).toBe(0);
      });

      it('reports depth and assembles the tree GET returns', async () => {
        const token = await asAdmin();
        const tree = await buildTree(token);

        const response = await call(token, 'GET', '/iam/scopes');
        expect(response.status).toBe(200);
        const body = (await response.json()) as ScopeTreeResponse;

        expect(body.client_id).toBe(fixture.acme.clientId);
        expect(body.tree).toHaveLength(1);

        const [root] = body.tree;
        expect(root.id).toBe(tree.group.id);
        expect(root.depth).toBe(1);
        // Ordered by name: "Acme Group — West" before "Plant B".
        expect(root.children.map((child) => child.name)).toEqual([
          'Acme Group — West',
          'Plant B',
        ]);

        const plant = root.children[1];
        expect(plant.depth).toBe(2);
        expect(plant.children[0].children[0]).toMatchObject({
          id: tree.gate.id,
          name: 'Gate-3',
          depth: 4,
          children: [],
        });
      });

      it('refuses a second root, and a parent from another tenant', async () => {
        const token = await asAdmin();
        const { group } = await buildTree(token);
        expect(group.parent_id).toBeNull();

        const second = await call(token, 'POST', '/iam/scopes', {
          kind: 'group',
          name: 'A rival root',
        });
        expect(second.status).toBe(409);
        expect(await errorCodeOf(second)).toBe(IamErrorCode.CONFLICT);

        // The other tenant's root exists, and is invisible: the answer is the
        // same 409 an id that exists nowhere would get, so the response cannot
        // be used to discover what another client's tree contains (Doc 06 §2).
        const otherToken = await asAdmin(fixture.other);
        const foreign = await rootOf(otherToken);

        const across = await call(token, 'POST', '/iam/scopes', {
          parent_id: foreign.id,
          kind: 'plant',
          name: 'Smuggled',
        });
        const missing = await call(token, 'POST', '/iam/scopes', {
          parent_id: randomUUID(),
          kind: 'plant',
          name: 'Nowhere',
        });

        expect(across.status).toBe(409);
        // Identical down to the wording — only the `requestId` differs, which is
        // per-request by construction and carries nothing about the target.
        const bodyOf = async (response: Response) => {
          const { code, message } = ((await response.json()) as IamErrorResponse).error;
          return { code, message };
        };
        expect(await bodyOf(across)).toEqual(await bodyOf(missing));
      });

      it('stops at the documented maximum depth', async () => {
        const token = await asAdmin();
        let parent = await rootOf(token);

        for (let depth = 2; depth <= MAX_SCOPE_TREE_DEPTH; depth++) {
          parent = await created(token, {
            parent_id: parent.id,
            kind: 'department',
            name: `Level ${depth}`,
          });
        }
        expect(parent.depth).toBe(MAX_SCOPE_TREE_DEPTH);

        const overflow = await call(token, 'POST', '/iam/scopes', {
          parent_id: parent.id,
          kind: 'gate',
          name: 'One too deep',
        });
        expect(overflow.status).toBe(409);
      });
    });

    // ── rename: one column, and nothing else ──────────────────────────────

    describe('renaming', () => {
      it('changes the name and leaves every path untouched', async () => {
        const token = await asAdmin();
        const tree = await buildTree(token);
        const before = await nodesOf(fixture.acme);

        const published = jest.spyOn(invalidation, 'publish');

        const response = await call(token, 'PATCH', `/iam/scopes/${tree.plant.id}`, {
          name: 'Plant B (South)',
        });
        expect(response.status).toBe(200);
        const updated = (await response.json()) as ScopeNodeDTO;

        expect(updated.name).toBe('Plant B (South)');
        expect(updated.path).toBe(tree.plant.path);

        // Every path in the tenant, not merely the renamed node's: the point of
        // the id-derived label is that a rename cannot disturb what is beneath.
        const after = await nodesOf(fixture.acme);
        expect(after.map((node) => node.path)).toEqual(before.map((node) => node.path));

        // And therefore nothing to invalidate — the Doc 04 §7 row for a scope
        // change is conditioned on the path moving, which a rename never does.
        expect(published).not.toHaveBeenCalled();

        const [record] = await auditFor(fixture.acme, AUDIT_ACTIONS.SCOPE_NODE_RENAMED);
        expect(record).toMatchObject({
          before: 'Plant B',
          after: 'Plant B (South)',
          path: tree.plant.path,
        });
      });

      it('audits nothing when the name is resubmitted unchanged', async () => {
        const token = await asAdmin();
        const tree = await buildTree(token);

        const response = await call(token, 'PATCH', `/iam/scopes/${tree.plant.id}`, {
          name: 'Plant B',
        });

        expect(response.status).toBe(200);
        expect(await auditFor(fixture.acme, AUDIT_ACTIONS.SCOPE_NODE_RENAMED)).toEqual(
          [],
        );
      });
    });

    // ── move: the subtree rewrite (Doc 07 §7, Doc 04 §7.1) ────────────────

    describe('moving a subtree', () => {
      it('rewrites the whole subtree in one shot, preserving each node`s own label', async () => {
        const token = await asAdmin();
        const tree = await buildTree(token);

        const response = await call(token, 'PATCH', `/iam/scopes/${tree.plant.id}`, {
          parent_id: tree.otherGroup.id,
        });
        expect(response.status).toBe(200);
        const moved = (await response.json()) as ScopeNodeDTO;

        const label = (node: { id: string }) => scopePathLabel(node.id);
        expect(moved.parent_id).toBe(tree.otherGroup.id);
        expect(moved.path).toBe(`${tree.otherGroup.path}.${label(tree.plant)}`);
        expect(moved.depth).toBe(3);

        // The descendants came with it, each keeping its own trailing label —
        // the property migration 0003's check constraint pins per row, asserted
        // here across the subtree.
        expect(await pathOf(fixture.acme, tree.department.id)).toBe(
          `${moved.path}.${label(tree.department)}`,
        );
        expect(await pathOf(fixture.acme, tree.gate.id)).toBe(
          `${moved.path}.${label(tree.department)}.${label(tree.gate)}`,
        );
        // The nodes that did not move did not move.
        expect(await pathOf(fixture.acme, tree.otherGroup.id)).toBe(tree.otherGroup.path);
        expect(await brokenNodes(fixture.acme)).toBe(0);
      });

      it('keeps coverage working: bindings under the subtree follow it', async () => {
        const token = await asAdmin();
        const tree = await buildTree(token);
        await insertBinding(admin, fixture.acme, tree.gate.id);
        await insertBinding(admin, fixture.acme, tree.department.id);

        expect(await bindingsUnder(fixture.acme, tree.plant.path)).toBe(2);

        const response = await call(token, 'PATCH', `/iam/scopes/${tree.plant.id}`, {
          parent_id: tree.otherGroup.id,
        });
        expect(response.status).toBe(200);
        const moved = (await response.json()) as ScopeNodeDTO;

        // The same two bindings, now covered by the new group and no longer by
        // the old one. This is the whole meaning of "access follows the tree".
        expect(await bindingsUnder(fixture.acme, moved.path)).toBe(2);
        expect(await bindingsUnder(fixture.acme, tree.otherGroup.path)).toBe(2);
        // Three at the root: the same two, plus the administrator's own grant
        // there — the binding that authorized this move (Session 23).
        expect(await bindingsUnder(fixture.acme, tree.group.path)).toBe(3);
      });

      it('publishes the invalidation only after the move has committed', async () => {
        const token = await asAdmin();
        const tree = await buildTree(token);
        await insertBinding(admin, fixture.acme, tree.gate.id);

        // The assertion that matters (Doc 04 §7.1 rule 3): what a *different*
        // connection could see at the moment the hook ran. Before the commit it
        // would still read the pre-move path, and a reader repopulating its
        // cache then would re-poison it with a path that no longer exists.
        const observed: { pathVisibleElsewhere: string | null; subjects: number }[] = [];
        jest
          .spyOn(invalidation, 'publish')
          .mockImplementation(async (_clientId, subjects) => {
            observed.push({
              pathVisibleElsewhere: await pathOf(fixture.acme, tree.plant.id),
              subjects: subjects.length,
            });
          });

        const response = await call(token, 'PATCH', `/iam/scopes/${tree.plant.id}`, {
          parent_id: tree.otherGroup.id,
        });
        expect(response.status).toBe(200);
        const moved = (await response.json()) as ScopeNodeDTO;

        expect(observed).toHaveLength(1);
        expect(observed[0].pathVisibleElsewhere).toBe(moved.path);
        expect(observed[0].pathVisibleElsewhere).not.toBe(tree.plant.path);
        // Captured pre-rewrite, from bindings under the old prefix.
        expect(observed[0].subjects).toBe(1);

        const [record] = await auditFor(fixture.acme, AUDIT_ACTIONS.SCOPE_NODE_MOVED);
        expect(record).toMatchObject({
          before_path: tree.plant.path,
          after_path: moved.path,
          before_parent_id: tree.group.id,
          after_parent_id: tree.otherGroup.id,
          // The plant, its department and its gate — one statement, three rows.
          nodes_moved: 3,
          subjects_invalidated: 1,
        });
      });

      it('refuses to move a node beneath itself or its own descendant', async () => {
        const token = await asAdmin();
        const tree = await buildTree(token);

        for (const parentId of [tree.plant.id, tree.gate.id]) {
          const response = await call(token, 'PATCH', `/iam/scopes/${tree.plant.id}`, {
            parent_id: parentId,
          });
          expect(response.status).toBe(409);
          expect(await errorCodeOf(response)).toBe(IamErrorCode.CONFLICT);
        }

        // Refused *before* the rewrite, which is the point: a cycle detected
        // halfway through would leave a subtree pointing at nothing.
        expect(await pathOf(fixture.acme, tree.plant.id)).toBe(tree.plant.path);
        expect(await brokenNodes(fixture.acme)).toBe(0);
      });

      it('refuses a new parent belonging to another tenant', async () => {
        const token = await asAdmin();
        const tree = await buildTree(token);
        const foreign = await rootOf(await asAdmin(fixture.other));

        const response = await call(token, 'PATCH', `/iam/scopes/${tree.plant.id}`, {
          parent_id: foreign.id,
        });

        expect(response.status).toBe(409);
        expect(await pathOf(fixture.acme, tree.plant.id)).toBe(tree.plant.path);
      });

      /**
       * Doc 04 §7.1's isolation rule, exercised rather than asserted: binding
       * inserts into the moving subtree, each on its own connection and its own
       * transaction, fired simultaneously with the move.
       *
       * What is claimed is not that a particular interleaving occurs — that is
       * the scheduler's business — but that **no interleaving leaves the tree
       * inconsistent**: whichever order the transactions take, every path is
       * still its parent's path plus its own label, and every binding written is
       * still covered by the subtree it was written into.
       */
      it('stays consistent when binding inserts race the move', async () => {
        const token = await asAdmin();
        const tree = await buildTree(token);

        // One per node of the moving subtree, and no more: `role_binding` is
        // unique on (subject, role, node), so a repeat would be a 409 about the
        // fixture rather than anything this case is testing.
        const targets = [tree.gate.id, tree.department.id, tree.plant.id];
        const [response] = await Promise.all([
          call(token, 'PATCH', `/iam/scopes/${tree.plant.id}`, {
            parent_id: tree.otherGroup.id,
          }),
          ...targets.map((id) => insertBinding(admin, fixture.acme, id)),
        ]);

        expect(response.status).toBe(200);
        const moved = (await response.json()) as ScopeNodeDTO;

        expect(await brokenNodes(fixture.acme)).toBe(0);
        // Every binding inserted lands under the moved plant wherever it now
        // hangs — a binding that attached to a half-rewritten path set would be
        // missing from this count.
        expect(await bindingsUnder(fixture.acme, moved.path)).toBe(targets.length);
        // And nothing is left behind at the path the subtree used to occupy —
        // no row still carries a prefix that the move retired.
        expect(await bindingsUnder(fixture.acme, tree.plant.path)).toBe(0);
      });
    });

    // ── delete: guarded, never cascading ──────────────────────────────────

    describe('deleting', () => {
      it('refuses a node that still has children', async () => {
        const token = await asAdmin();
        const tree = await buildTree(token);

        const response = await call(token, 'DELETE', `/iam/scopes/${tree.plant.id}`);

        expect(response.status).toBe(409);
        const body = (await response.json()) as IamErrorResponse;
        expect(body.error.code).toBe(IamErrorCode.CONFLICT);
        expect(body.error.message).toContain('child node');
        expect(await pathOf(fixture.acme, tree.department.id)).not.toBeNull();
      });

      it('refuses a node with bindings, and says so', async () => {
        const token = await asAdmin();
        const tree = await buildTree(token);
        await insertBinding(admin, fixture.acme, tree.gate.id);

        const response = await call(token, 'DELETE', `/iam/scopes/${tree.gate.id}`);

        expect(response.status).toBe(409);
        const body = (await response.json()) as IamErrorResponse;
        // "Clear message" is the acceptance criterion: an operator has to learn
        // what is in the way, which is grants rather than structure.
        expect(body.error.message).toContain('role binding');
        expect(body.error.message).toContain('Gate-3');
      });

      it('removes a clean leaf, and audits it', async () => {
        const token = await asAdmin();
        const tree = await buildTree(token);

        const response = await call(token, 'DELETE', `/iam/scopes/${tree.gate.id}`);

        expect(response.status).toBe(204);
        expect(await pathOf(fixture.acme, tree.gate.id)).toBeNull();

        const [record] = await auditFor(fixture.acme, AUDIT_ACTIONS.SCOPE_NODE_DELETED);
        expect(record).toMatchObject({
          name: 'Gate-3',
          kind: 'gate',
          path: tree.gate.path,
        });
      });
    });

    // ── who may do any of this ────────────────────────────────────────────

    describe('authorization and tenant isolation', () => {
      it('refuses an ordinary user of the tenant', async () => {
        const token = await login(fixture.acme.memberEmail, fixture.acme.slug);

        const response = await call(token, 'POST', '/iam/scopes', {
          kind: 'group',
          name: 'Not mine to make',
        });

        expect(response.status).toBe(403);
        expect(await errorCodeOf(response)).toBe(IamErrorCode.PERMISSION_DENIED);
      });

      it('refuses an unauthenticated caller', async () => {
        const response = await fetch(`${baseUrl}/iam/scopes`);
        expect(response.status).toBe(401);
      });

      it('shows each tenant only its own tree', async () => {
        const acmeToken = await asAdmin();
        const otherToken = await asAdmin(fixture.other);
        const mine = await buildTree(acmeToken);
        const theirs = await rootOf(otherToken);

        const response = await call(otherToken, 'GET', '/iam/scopes');
        const body = (await response.json()) as ScopeTreeResponse;

        expect(body.client_id).toBe(fixture.other.clientId);
        expect(body.tree.map((node) => node.id)).toEqual([theirs.id]);

        // And a node that exists — in another tenant — is a 404, not a 403: RLS
        // makes it invisible rather than forbidden, so nothing distinguishes it
        // from an id that never existed (Doc 06 §2).
        const patch = await call(otherToken, 'PATCH', `/iam/scopes/${mine.plant.id}`, {
          name: 'Renamed by a stranger',
        });
        const remove = await call(otherToken, 'DELETE', `/iam/scopes/${mine.gate.id}`);

        expect(patch.status).toBe(404);
        expect(remove.status).toBe(404);
        expect(await pathOf(fixture.acme, mine.plant.id)).toBe(mine.plant.path);
      });
    });
  },
);

/**
 * Platform context on the owner connection.
 *
 * Session-scoped (`false`) rather than transaction-local, because these queries
 * run outside a transaction and the connection is this suite's alone.
 */
async function elevate(admin: DataSource, clientId: string): Promise<void> {
  await admin.query(`select set_config('app.is_platform_admin', 'true', false)`);
  await admin.query(`select set_config('app.current_client_id', $1, false)`, [clientId]);
}

/**
 * One tenant with an admin, an ordinary member and a role.
 *
 * Seeded directly rather than through `POST /iam/clients/:id/admins`, so this
 * suite's subject does not depend on Session 15's endpoint — and so that no root
 * scope node exists yet: building one over HTTP is the first thing these cases
 * do.
 */
async function seedTenant(
  admin: DataSource,
  label: string,
  secretHash: string,
): Promise<Tenant> {
  const suffix = randomUUID().slice(0, 8);
  const tenant: Tenant = {
    clientId: randomUUID(),
    slug: `${SLUG_PREFIX}${label}-${suffix}`,
    adminEmail: `admin-${label}-${suffix}@example.test`,
    adminUserId: randomUUID(),
    memberEmail: `member-${label}-${suffix}@example.test`,
    roleId: randomUUID(),
    // Replaced by `authorizeAdmin` below, and again before every case.
    rootId: '',
  };

  await elevate(admin, tenant.clientId);
  await admin.query(
    `insert into ${S}."client" (id, name, slug, status) values ($1, $2, $3, 'active')`,
    [tenant.clientId, `Session 16 ${label} ${suffix}`, tenant.slug],
  );

  for (const [id, email, isAdmin] of [
    [tenant.adminUserId, tenant.adminEmail, true],
    [randomUUID(), tenant.memberEmail, false],
  ] as const) {
    await admin.query(
      `insert into ${S}."user" (id, client_id, email, full_name, status, is_client_admin)
       values ($1, $2, $3, 'Session 16 Fixture', 'active', $4)`,
      [id, tenant.clientId, email, isAdmin],
    );
    await admin.query(
      `insert into ${S}."user_identity" (client_id, user_id, provider, secret_hash)
       values ($1, $2, 'password', $3)`,
      [tenant.clientId, id, secretHash],
    );
  }

  await admin.query(
    `insert into ${S}."role" (id, client_id, name, description)
     values ($1, $2, 'Session 16 Role', 'Something for a binding to reference')`,
    [tenant.roleId, tenant.clientId],
  );

  await authorizeAdmin(admin, tenant);
  return tenant;
}

/**
 * Re-seeds the tenant's root node and the administrator's grant over it.
 *
 * Called from `seedTenant` and again from `clearTrees`, because clearing the
 * tree necessarily clears the binding that the next case's very first request
 * is authorized by.
 */
async function authorizeAdmin(admin: DataSource, tenant: Tenant): Promise<void> {
  const root = await seedRootScopeNode(admin, tenant.clientId, 'Fixture Root');
  tenant.rootId = root.id;
  await grantIamClientAdmin(admin, tenant.clientId, root.id, {
    userId: tenant.adminUserId,
  });
}

/**
 * A binding at `scopeNodeId`, on its **own** connection and transaction.
 *
 * A query runner rather than `admin.query`, and transaction-local
 * `set_config(…, true)` rather than the session-wide `elevate`, because the
 * concurrency case fires several of these at once: session settings applied to
 * whichever pooled connection answered last would not be the ones the insert
 * runs under, and the insert would fail the tenant policy for reasons that have
 * nothing to do with what is being tested.
 */
async function insertBinding(
  admin: DataSource,
  tenant: Tenant,
  scopeNodeId: string,
): Promise<void> {
  const runner = admin.createQueryRunner();
  try {
    await runner.connect();
    await runner.startTransaction();
    await runner.query(`select set_config('app.is_platform_admin', 'true', true)`);
    await runner.query(`select set_config('app.current_client_id', $1, true)`, [
      tenant.clientId,
    ]);
    await runner.query(
      `insert into ${S}."role_binding" (client_id, user_id, role_id, scope_node_id)
       values ($1, $2, $3, $4)`,
      [tenant.clientId, tenant.adminUserId, tenant.roleId, scopeNodeId],
    );
    await runner.commitTransaction();
  } catch (error) {
    // Without this the connection goes back to the pool inside an aborted
    // transaction, and every later query on it fails with "current transaction
    // is aborted" — which would report this helper's bug as a failure of
    // whatever ran next.
    if (runner.isTransactionActive) {
      await runner.rollbackTransaction().catch(() => undefined);
    }
    throw error;
  } finally {
    await runner.release();
  }
}

/**
 * Removes one tenant's whole tree, leaves first.
 *
 * `scope_node.parent_id` is `on delete restrict` (migration 0003) and a single
 * `delete` gives Postgres no order to respect, so this peels one level at a time
 * until nothing is left. That is the same guard the delete endpoint reports as a
 * 409 — a fair reminder that the API's refusal is not the only thing standing
 * there.
 */
async function deleteTree(admin: DataSource, clientId: string): Promise<void> {
  for (;;) {
    const removed = (await admin.query(
      `with pruned as (
         delete from ${S}."scope_node" sn
          where sn.client_id = $1
            and not exists (
              select 1 from ${S}."scope_node" c where c.parent_id = sn.id
            )
         returning sn.id
       )
       select count(*)::int as total from pruned`,
      [clientId],
    )) as { total: number }[];

    if ((removed[0]?.total ?? 0) === 0) return;
  }
}

/** Empties both tenants' trees, and their audit rows, between cases. */
async function clearTrees(admin: DataSource, tenants: readonly Tenant[]): Promise<void> {
  for (const tenant of tenants) {
    await elevate(admin, tenant.clientId);
    // Bindings first — they reference the nodes about to go.
    await admin.query(`delete from ${S}."role_binding" where client_id = $1`, [
      tenant.clientId,
    ]);
    await deleteTree(admin, tenant.clientId);
    await admin.query(`delete from ${S}."audit_trail" where client_id = $1`, [
      tenant.clientId,
    ]);
    // The tree is what the admin's own authorization hangs off, so putting one
    // back is part of clearing it.
    await authorizeAdmin(admin, tenant);
  }
}

/** Every `s16-` tenant and everything hanging off it. */
async function purge(admin: DataSource): Promise<void> {
  await admin.query(`select set_config('app.is_platform_admin', 'true', false)`);
  const clients = (await admin.query(
    `select id from ${S}."client" where slug like $1`,
    [`${SLUG_PREFIX}%`],
  )) as { id: string }[];

  for (const { id } of clients) {
    await elevate(admin, id);
    for (const statement of [
      `delete from ${S}."role_binding" where client_id = $1`,
      `delete from ${S}."session" where client_id = $1`,
      `delete from ${S}."password_reset_token" where client_id = $1`,
      `delete from ${S}."user_identity" where client_id = $1`,
      `delete from ${S}."user" where client_id = $1`,
      `delete from ${S}."role" where client_id = $1`,
      // Session 23: the fixture enables the `iam` application for every
      // tenant it authorizes, and `client` is referenced with `on delete
      // restrict` (migration 0003).
      `delete from ${S}."client_application" where client_id = $1`,
    ]) {
      await admin.query(statement, [id]);
    }
    await deleteTree(admin, id);
    await admin.query(`delete from ${S}."audit_trail" where client_id = $1`, [id]);
    await admin.query(`delete from ${S}."client" where id = $1`, [id]);
  }
}
