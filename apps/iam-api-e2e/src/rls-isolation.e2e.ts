/**
 * **RLS isolation — the last line, proven against data the API itself created.**
 *
 * Doc 08 §7 asks for one property above all the others: *a cross-tenant read
 * must fail at the database even with a coding mistake*. Doc 07 §6 is where the
 * policies are specified; `libs/db`'s `rls-isolation.integration.spec.ts`
 * already proves them against rows that suite inserts itself with SQL.
 *
 * This file proves the same thing about **the running system**. Two tenants are
 * onboarded through the real API — `POST /iam/clients`, `/admins`, `/scopes`,
 * `/roles`, `/users`, `/role-bindings` — and then the database is asked, on the
 * app role, with deliberately unfiltered queries, whether it will hand one
 * tenant's rows to the other. The difference from the `libs/db` suite is not the
 * assertions; it is the provenance of the rows. A policy that is right about
 * hand-inserted fixtures and wrong about what the service writes (a column the
 * service leaves null, a table a later migration forgot to enable) is a bug
 * neither suite alone can see.
 *
 * Half the file is therefore SQL and half is HTTP, and the pairing is the point:
 * the same isolation is asserted at the layer that enforces it and at the layer
 * a caller can reach.
 *
 *   pg_ctl start && redis-server && npm run migration:run
 *   npx nx e2e @plantops/iam-api-e2e
 *
 * **Destructive within its own fixtures only** — every client it creates is
 * slugged `e2e-rls-…` and is removed and rebuilt on each run.
 */

import { IamErrorCode } from '@plantops/contracts';
import type { Client } from 'pg';
import { as, type Caller } from './support/api';
import {
  connectAppRole,
  expectRejection,
  one,
  rows,
  S,
  withRlsContext,
} from './support/database';
import {
  callerFor,
  seedTwoTenants,
  type TwoTenants,
} from './support/two-tenant-fixture';

const PREFIX = 'e2e-rls-';

describe('RLS isolation, end to end', () => {
  let fixture: TwoTenants;
  let app: Client;
  let alphaAdmin: Caller;
  let betaAdmin: Caller;

  beforeAll(async () => {
    fixture = await seedTwoTenants(PREFIX);
    app = await connectAppRole();
    alphaAdmin = await callerFor(fixture.alpha, fixture.alpha.admin);
    betaAdmin = await callerFor(fixture.beta, fixture.beta.admin);
  });

  afterAll(async () => {
    await app?.end();
  });

  /**
   * Run under the owning role, or with `force row level security` lifted, every
   * assertion below passes while every policy is inert (Doc 07 §5.1). None of
   * them mean anything until this block does.
   */
  describe('the connection under test can actually be filtered', () => {
    it('is not a superuser and does not bypass row-level security', async () => {
      const role = await one<{
        rolname: string;
        rolsuper: boolean;
        rolbypassrls: boolean;
      }>(
        app,
        `select rolname, rolsuper, rolbypassrls from pg_roles where rolname = current_user`,
      );

      expect(role.rolsuper).toBe(false);
      expect(role.rolbypassrls).toBe(false);
    });

    it('owns none of the iam tables — ownership exempts a role from its own policies', async () => {
      const owned = await rows<{ tablename: string }>(
        app,
        `select tablename from pg_tables
          where schemaname = 'iam' and tableowner = current_user`,
      );

      expect(owned).toEqual([]);
    });

    it('faces tables that FORCE row-level security', async () => {
      const unforced = await rows<{ relname: string }>(
        app,
        `select c.relname
           from pg_class c join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'iam'
            and c.relkind = 'r'
            and c.relforcerowsecurity = false`,
      );

      // `audit_trail` is the documented exception (Session 5): its
      // SECURITY DEFINER writer inserts through the owner path, and the app
      // role is blocked there by privilege rather than by policy — which the
      // append-only block below proves directly.
      expect(unforced.map((table) => table.relname)).toEqual(['audit_trail']);
    });
  });

  /**
   * The queries here are written **wrong on purpose** — no `where client_id =`
   * anywhere. That is the claim: the database refuses to leak even when the
   * application forgets to filter.
   */
  describe('an unfiltered read sees one tenant only (Doc 07 §6)', () => {
    const unfiltered = (client: Client, table: string) =>
      rows<{ client_id: string }>(client, `select client_id from ${S}."${table}"`);

    it.each(['role', 'user', 'scope_node', 'role_binding', 'service_account'])(
      'returns only the context tenant’s %s rows',
      async (table) => {
        const seen = await withRlsContext(
          app,
          { clientId: fixture.alpha.clientId },
          () => unfiltered(app, table),
        );

        expect(seen.length).toBeGreaterThan(0);
        expect([...new Set(seen.map((row) => row.client_id))]).toEqual([
          fixture.alpha.clientId,
        ]);
      },
    );

    it('returns nothing at all with no context set', async () => {
      const seen = await withRlsContext(app, {}, () => unfiltered(app, 'user'));

      expect(seen).toEqual([]);
    });

    it('returns nothing when the context is an empty string', async () => {
      const seen = await withRlsContext(app, { clientId: '' }, () =>
        unfiltered(app, 'user'),
      );

      expect(seen).toEqual([]);
    });

    it('hides another tenant’s role composition, which hangs off no client_id of its own', async () => {
      // `role_permission` has no `client_id`; migration 0009 reaches through to
      // the parent role. A join table that forgot to is the classic hole.
      const visible = await withRlsContext(
        app,
        { clientId: fixture.alpha.clientId },
        () =>
          rows<{ role_id: string }>(
            app,
            `select rp.role_id from ${S}."role_permission" rp`,
          ),
      );

      expect(visible.length).toBeGreaterThan(0);
      expect(
        visible.some((row) => row.role_id === fixture.beta.operatorRoleId),
      ).toBe(false);
    });

    it('lets a platform context read across both tenants', async () => {
      // `client` is the one tenant table keyed by its own `id` rather than a
      // `client_id`, so this case names the column instead of reusing the
      // unfiltered helper above.
      const seen = await withRlsContext(app, { platformAdmin: true }, () =>
        rows<{ id: string }>(app, `select id from ${S}."client"`),
      );
      const ids = new Set(seen.map((row) => row.id));

      expect(ids.has(fixture.alpha.clientId)).toBe(true);
      expect(ids.has(fixture.beta.clientId)).toBe(true);
    });

    it('shows a tenant context only its own client row', async () => {
      const seen = await withRlsContext(
        app,
        { clientId: fixture.alpha.clientId },
        () => rows<{ id: string }>(app, `select id from ${S}."client"`),
      );

      expect(seen.map((row) => row.id)).toEqual([fixture.alpha.clientId]);
    });
  });

  describe('the asymmetric `with check` on writes (Doc 07 §6)', () => {
    it('refuses a tenant a row under another tenant', async () => {
      const failure = await expectRejection(
        app,
        { clientId: fixture.alpha.clientId },
        `insert into ${S}."role" (client_id, name) values ($1, $2)`,
        [fixture.beta.clientId, 'Smuggled'],
      );

      expect(failure.message).toMatch(/row-level security/i);
    });

    it('refuses even a platform context a row under a named tenant', async () => {
      // Reading across tenants and writing across them are different powers;
      // Doc 07 §6 grants the first and withholds the second.
      const failure = await expectRejection(
        app,
        { platformAdmin: true, clientId: fixture.alpha.clientId },
        `insert into ${S}."role" (client_id, name) values ($1, $2)`,
        [fixture.beta.clientId, 'Smuggled by platform'],
      );

      expect(failure.message).toMatch(/row-level security/i);
    });

    it('allows a tenant its own row', async () => {
      const inserted = await withRlsContext(
        app,
        { clientId: fixture.alpha.clientId },
        () =>
          rows<{ id: string }>(
            app,
            `insert into ${S}."role" (client_id, name) values ($1, $2) returning id`,
            [fixture.alpha.clientId, 'Written by the isolation suite'],
          ),
      );

      // Rolled back by `withRlsContext`; the assertion is that it was permitted.
      expect(inserted).toHaveLength(1);
    });
  });

  /**
   * Doc 10 §1: the trail is append-only and its actor is not the caller's to
   * choose. The app role is blocked here by *privilege* — it has no INSERT on
   * the table at all — which is why `audit_trail` is the one table without
   * FORCE above.
   */
  describe('audit_trail is unforgeable from the app role (Doc 07 §6, Doc 10 §1)', () => {
    it.each([
      [
        'INSERT',
        `insert into ${S}."audit_trail" (actor_type, action) values ('platform', 'forged')`,
      ],
      ['UPDATE', `update ${S}."audit_trail" set action = 'rewritten'`],
      ['DELETE', `delete from ${S}."audit_trail"`],
      ['TRUNCATE', `truncate ${S}."audit_trail"`],
    ])('refuses a direct %s', async (_verb, sql) => {
      const failure = await expectRejection(
        app,
        { clientId: fixture.alpha.clientId },
        sql,
      );

      expect(failure.message).toMatch(/permission denied|row-level security/i);
    });

    it('shows a tenant only its own rows, and the API wrote plenty', async () => {
      const seen = await withRlsContext(
        app,
        { clientId: fixture.alpha.clientId },
        () =>
          rows<{ client_id: string }>(
            app,
            `select client_id from ${S}."audit_trail"`,
          ),
      );

      // The fixture's own provisioning produced these — nothing was inserted by
      // hand, which is what makes this a statement about the running service.
      expect(seen.length).toBeGreaterThan(0);
      expect([...new Set(seen.map((row) => row.client_id))]).toEqual([
        fixture.alpha.clientId,
      ]);
    });
  });

  /**
   * The same isolation, asked of the layer a caller can actually reach. A 403
   * or a 404 that differs by whether the row exists is a cross-tenant existence
   * oracle, and Doc 06 §2 forbids it.
   */
  describe('over HTTP, the tenants cannot see each other', () => {
    it('lists only its own roles', async () => {
      const listed = await alphaAdmin.get<{ data: { id: string }[] }>(
        '/iam/roles?limit=100',
      );

      expect(listed.status).toBe(200);
      const ids = listed.data.data.map((role) => role.id);
      expect(ids).toContain(fixture.alpha.operatorRoleId);
      expect(ids).not.toContain(fixture.beta.operatorRoleId);
    });

    it('lists only its own users', async () => {
      const listed = await alphaAdmin.get<{ data: { email: string }[] }>(
        '/iam/users?limit=100',
      );

      expect(listed.status).toBe(200);
      const emails = listed.data.data.map((user) => user.email);
      expect(emails).toContain(fixture.alpha.operator.email);
      expect(emails.every((email) => email.endsWith(`${fixture.alpha.slug}.test`))).toBe(
        true,
      );
    });

    it('answers 404 — not 403 — for another tenant’s user, so existence does not leak', async () => {
      const found = await alphaAdmin.get(`/iam/users/${fixture.beta.operator.id}`);

      expect(found.status).toBe(404);
    });

    it('refuses to bind another tenant’s role, and says nothing about it', async () => {
      const attempt = await alphaAdmin.post<{ error: { code: string } }>(
        '/iam/role-bindings',
        {
          user_id: fixture.alpha.outsider.id,
          role_id: fixture.beta.operatorRoleId,
          scope_node_id: fixture.alpha.plantA.id,
        },
      );

      expect([403, 404, 409]).toContain(attempt.status);
      expect(attempt.data.error.code).not.toBe(IamErrorCode.INTERNAL_ERROR);
      expect(JSON.stringify(attempt.data)).not.toContain(fixture.beta.slug);
    });

    it('refuses to bind a subject into another tenant’s tree', async () => {
      const attempt = await alphaAdmin.post('/iam/role-bindings', {
        user_id: fixture.alpha.outsider.id,
        role_id: fixture.alpha.operatorRoleId,
        scope_node_id: fixture.beta.plantA.id,
      });

      expect([403, 404, 409]).toContain(attempt.status);
    });

    it('gives each tenant its own scope tree and no view of the other’s', async () => {
      const alphaTree = await alphaAdmin.get<{ tree: { id: string }[] }>('/iam/scopes');
      const betaTree = await betaAdmin.get<{ tree: { id: string }[] }>('/iam/scopes');

      expect(alphaTree.data.tree.map((node) => node.id)).toEqual([
        fixture.alpha.root.id,
      ]);
      expect(betaTree.data.tree.map((node) => node.id)).toEqual([
        fixture.beta.root.id,
      ]);
    });

    it('scopes the audit read to the caller’s tenant', async () => {
      const trail = await alphaAdmin.get<{
        data: { client_id: string | null }[];
      }>('/iam/audit?limit=100');

      expect(trail.status).toBe(200);
      expect(trail.data.data.length).toBeGreaterThan(0);
      expect(
        trail.data.data.every((row) => row.client_id === fixture.alpha.clientId),
      ).toBe(true);
    });

    it('refuses an unauthenticated caller before any of this matters', async () => {
      const anonymous = await as(undefined).get<{ error: { code: string } }>(
        '/iam/roles',
      );

      expect(anonymous.status).toBe(401);
      expect(anonymous.data.error.code).toBe(IamErrorCode.AUTH_REQUIRED);
    });
  });
});
