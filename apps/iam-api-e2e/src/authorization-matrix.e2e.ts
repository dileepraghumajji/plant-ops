/**
 * **The authorization matrix** — every class of subject against every class of
 * endpoint, on the running system (Doc 04 §8–9, Doc 06 §2, Doc 10 §3).
 *
 * The one question here is *did they get through*, and it is the one question
 * every other suite in the workspace stops asking: they seed an authorized
 * caller and then test whether the feature works. The failure this file exists
 * to catch is invisible to all of them, because **a route that admits somebody
 * it should not is a route that works**.
 *
 * `apps/iam-api/src/authz/authorization.integration.spec.ts` asks the same
 * question in-process. What this adds is the deployed shape: the guard resolving
 * on its own `QueryRunner` (ADR 0001) against a real Postgres *and* a real
 * grants cache, denial auditing surviving a request that is about to 403, and
 * the decorators actually reaching the routes the webpack bundle registered.
 *
 * ## The six subjects
 *
 * | | holds |
 * |---|---|
 * | anonymous | nothing, and no token |
 * | platform | `iam.platform.*` at the platform root (migration 0011's bootstrap account) |
 * | admin | `iam.client.*` at their tenant root |
 * | plant admin | `iam.client.*` at **Plant A only** |
 * | member | nothing |
 * | machine | `e2e-ops.dc.create` at Gate A11, and nothing of the IAM's |
 *
 * The plant admin is what makes the WHERE dimension testable at the routing
 * layer. `PERMISSION_DENIED` and `SCOPE_DENIED` are different answers to
 * different questions (Doc 06 §2), and a matrix with only "everything" and
 * "nothing" subjects could not tell them apart.
 */

import { IamErrorCode } from '@plantops/contracts';
import { anonymous, as, expectOk, type Caller } from './support/api';
import {
  callerFor,
  machineToken,
  platform,
  seedTwoTenants,
  type TwoTenants,
} from './support/two-tenant-fixture';

const PREFIX = 'e2e-authz-';

/** The three endpoint classes of Doc 06, one representative route each way. */
interface Route {
  name: string;
  call: (caller: Caller, fixture: TwoTenants) => Promise<{ status: number }>;
}

const PLATFORM_ROUTES: Route[] = [
  { name: 'GET /iam/applications', call: (c) => c.get('/iam/applications?limit=5') },
  { name: 'GET /iam/clients', call: (c) => c.get('/iam/clients?limit=5') },
  {
    name: 'POST /iam/applications',
    call: (c) =>
      c.post('/iam/applications', {
        key: `e2e-probe-${Math.random().toString(36).slice(2, 8)}`,
        name: 'Probe',
      }),
  },
];

const CLIENT_ROUTES: Route[] = [
  { name: 'GET /iam/users', call: (c) => c.get('/iam/users?limit=5') },
  { name: 'GET /iam/roles', call: (c) => c.get('/iam/roles?limit=5') },
  { name: 'GET /iam/scopes', call: (c) => c.get('/iam/scopes') },
  { name: 'GET /iam/role-bindings', call: (c) => c.get('/iam/role-bindings?limit=5') },
];

/**
 * The one route Doc 06 §12 gives to *both* tiers under `iam.*.audit.read`:
 * `@RequirePermission([CLIENT_AUDIT_READ, PLATFORM_AUDIT_READ])`. Either key
 * opens it, and what separates the tiers is the rows RLS then returns, not the
 * gate — so it is listed apart from `CLIENT_ROUTES`, whose "and the platform
 * account is refused" case would be wrong about it.
 */
const DUAL_TIER_ROUTES: Route[] = [
  { name: 'GET /iam/audit', call: (c) => c.get('/iam/audit?limit=5') },
];

/** Routes any authenticated subject may call about *itself* (Doc 06 §3, §11). */
const SELF_ROUTES: Route[] = [
  { name: 'GET /iam/whoami', call: (c) => c.get('/iam/whoami') },
  { name: 'GET /auth/sessions', call: (c) => c.get('/auth/sessions') },
  {
    name: 'GET /iam/permissions/resolve',
    call: (c) => c.get('/iam/permissions/resolve'),
  },
  { name: 'GET /iam/navigation', call: (c) => c.get('/iam/navigation') },
];

describe('authorization matrix', () => {
  let fixture: TwoTenants;
  let admin: Caller;
  let plantAdmin: Caller;
  let member: Caller;
  let machine: Caller;

  beforeAll(async () => {
    fixture = await seedTwoTenants(PREFIX);
    admin = await callerFor(fixture.alpha, fixture.alpha.admin);
    plantAdmin = await callerFor(fixture.alpha, fixture.alpha.plantAdmin);
    member = await callerFor(fixture.alpha, fixture.alpha.outsider);
    machine = as(await machineToken(fixture.alpha.machine));
  });

  describe('no token, no access (Doc 04 §9)', () => {
    it.each([
      ...PLATFORM_ROUTES,
      ...CLIENT_ROUTES,
      ...DUAL_TIER_ROUTES,
      ...SELF_ROUTES,
    ])(
      '$name answers 401 AUTH_REQUIRED',
      async ({ call }) => {
        const response = (await call(anonymous, fixture)) as {
          status: number;
          data: { error: { code: string } };
        };

        expect(response.status).toBe(401);
        expect(response.data.error.code).toBe(IamErrorCode.AUTH_REQUIRED);
      },
    );

    it('still serves the two routes that are deliberately public', async () => {
      expect((await anonymous.get('/health')).status).toBe(200);
      expect((await anonymous.get('/iam/.well-known/jwks.json')).status).toBe(200);
    });
  });

  describe('the platform tier', () => {
    it.each(PLATFORM_ROUTES)('admits the platform account to $name', async ({ call }) => {
      const response = await call(await platform(), fixture);

      expect(response.status).toBeLessThan(400);
    });

    it.each(PLATFORM_ROUTES)(
      'refuses a client administrator $name with PERMISSION_DENIED',
      async ({ call }) => {
        const response = (await call(admin, fixture)) as {
          status: number;
          data: { error: { code: string } };
        };

        expect(response.status).toBe(403);
        expect(response.data.error.code).toBe(IamErrorCode.PERMISSION_DENIED);
      },
    );

    it.each(PLATFORM_ROUTES)('refuses an ordinary member $name', async ({ call }) => {
      expect((await call(member, fixture)).status).toBe(403);
    });

    it.each(PLATFORM_ROUTES)('refuses a machine identity $name', async ({ call }) => {
      // The service account holds `e2e-ops.dc.create` and nothing of the IAM's.
      // Being a machine grants nothing on its own (Doc 03 §5).
      expect((await call(machine, fixture)).status).toBe(403);
    });
  });

  describe('the client tier', () => {
    it.each([...CLIENT_ROUTES, ...DUAL_TIER_ROUTES])(
      'admits the tenant administrator to $name',
      async ({ call }) => {
        expect((await call(admin, fixture)).status).toBeLessThan(400);
      },
    );

    it.each([...CLIENT_ROUTES, ...DUAL_TIER_ROUTES])(
      'refuses an ordinary member $name with PERMISSION_DENIED',
      async ({ call }) => {
        const response = (await call(member, fixture)) as {
          status: number;
          data: { error: { code: string } };
        };

        expect(response.status).toBe(403);
        expect(response.data.error.code).toBe(IamErrorCode.PERMISSION_DENIED);
      },
    );

    it.each([...CLIENT_ROUTES, ...DUAL_TIER_ROUTES])(
      'refuses a machine identity $name',
      async ({ call }) => {
        expect((await call(machine, fixture)).status).toBe(403);
      },
    );

    it.each(CLIENT_ROUTES)(
      'refuses the platform account $name — the tiers are separate namespaces',
      async ({ call }) => {
        // Doc 02 §1: `iam.platform.*` and `iam.client.*` are two namespaces, and
        // holding one is not holding the other. A platform administrator
        // onboards tenants; they do not administer inside one.
        expect((await call(await platform(), fixture)).status).toBe(403);
      },
    );

    it.each(DUAL_TIER_ROUTES)(
      'admits the platform account to $name, which is the documented exception',
      async ({ call }) => {
        expect((await call(await platform(), fixture)).status).toBeLessThan(400);
      },
    );
  });

  describe('the self tier — anyone authenticated, about themselves', () => {
    it.each(SELF_ROUTES)('admits an ordinary member to $name', async ({ call }) => {
      expect((await call(member, fixture)).status).toBeLessThan(400);
    });

    it('answers a member’s resolve with their (empty) grants rather than a 403', async () => {
      const grants = expectOk(
        await member.get<{ permissions: string[] }>('/iam/permissions/resolve'),
        'resolve as a member',
      );

      // Deny-by-default is an *answer*, not a refusal: the console needs to
      // render "no screens granted", which it cannot do from a 403.
      expect(grants.permissions).toEqual([]);
    });

    it('gives a machine identity its own grants too', async () => {
      const grants = expectOk(
        await machine.get<{ permissions: string[] }>('/iam/permissions/resolve'),
        'resolve as a machine',
      );

      expect(grants.permissions).toEqual(['e2e-ops.dc.create']);
    });
  });

  /**
   * The WHERE dimension at the routing layer. The plant administrator holds
   * every client permission there is — so anything they are refused, they are
   * refused for scope and nothing else.
   */
  describe('scope, separately from permission (Doc 04 §5, Doc 06 §2)', () => {
    it('admits them beneath their own plant', async () => {
      const response = await plantAdmin.patch(
        `/iam/scopes/${fixture.alpha.deptA1.id}`,
        { name: 'Dispatch (renamed by the plant admin)' },
      );

      expect(response.status).toBe(200);
    });

    it('refuses them outside it with SCOPE_DENIED, not PERMISSION_DENIED', async () => {
      const response = await plantAdmin.patch<{ error: { code: string } }>(
        `/iam/scopes/${fixture.alpha.plantB.id}`,
        { name: 'Plant B (renamed by somebody who should not)' },
      );

      expect(response.status).toBe(403);
      expect(response.data.error.code).toBe(IamErrorCode.SCOPE_DENIED);
    });

    it('refuses them a binding at a node they do not cover', async () => {
      const response = await plantAdmin.post<{ error: { code: string } }>(
        '/iam/role-bindings',
        {
          user_id: fixture.alpha.outsider.id,
          role_id: fixture.alpha.operatorRoleId,
          scope_node_id: fixture.alpha.plantB.id,
        },
      );

      expect(response.status).toBe(403);
      expect(response.data.error.code).toBe(IamErrorCode.SCOPE_DENIED);
    });

    it('lets them grant inside their own subtree', async () => {
      const created = await plantAdmin.post<{ id: string }>('/iam/role-bindings', {
        user_id: fixture.alpha.outsider.id,
        role_id: fixture.alpha.visitorRoleId,
        scope_node_id: fixture.alpha.gateA11.id,
      });

      expect(created.status).toBe(201);
      await admin.del(`/iam/role-bindings/${created.data.id}`);
    });

    it('gives a member the ordinary PERMISSION_DENIED at the same node', async () => {
      // Same request, same node, different subject: the distinction between the
      // two 403s is about *which* half of the check failed, and it has to hold.
      const response = await member.patch<{ error: { code: string } }>(
        `/iam/scopes/${fixture.alpha.deptA1.id}`,
        { name: 'Nope' },
      );

      expect(response.status).toBe(403);
      expect(response.data.error.code).toBe(IamErrorCode.PERMISSION_DENIED);
    });
  });

  describe('a 403 reveals nothing about the other tenant (Doc 02 §6)', () => {
    it('refuses a cross-tenant scope target without confirming it exists', async () => {
      const response = await admin.patch<{ error: { message: string } }>(
        `/iam/scopes/${fixture.beta.plantA.id}`,
        { name: 'Reaching across' },
      );

      expect([403, 404]).toContain(response.status);
      expect(JSON.stringify(response.data)).not.toContain(fixture.beta.slug);
      expect(JSON.stringify(response.data)).not.toContain('Plant A');
    });

    it('answers identically for a scope node that simply does not exist', async () => {
      const missing = await admin.patch<{ error: { code: string } }>(
        `/iam/scopes/00000000-0000-4000-8000-000000000000`,
        { name: 'Reaching into nothing' },
      );
      const foreign = await admin.patch<{ error: { code: string } }>(
        `/iam/scopes/${fixture.beta.plantA.id}`,
        { name: 'Reaching across' },
      );

      // Different statuses here would be an existence oracle across tenants.
      expect(missing.status).toBe(foreign.status);
      expect(missing.data.error.code).toBe(foreign.data.error.code);
    });
  });

  /**
   * Doc 10 §3: a denial is an event, and the trail is where it lives. The
   * guard has no transaction of its own to attach to — `recordDenial` commits
   * on a separate connection precisely so the 403 it is about cannot roll it
   * back — which is a property only a real database can demonstrate.
   */
  describe('denials are audited (Doc 10 §3–4)', () => {
    it('records a permission denial with the attempted permission', async () => {
      expect((await member.get('/iam/users?limit=1')).status).toBe(403);

      const trail = await waitForAudit('authz.permission_denied');
      expect(trail).toBeDefined();
      expect(JSON.stringify(trail?.payload)).toMatch(/iam\.client\.user/);
    });

    it('records a scope denial distinctly from a permission denial', async () => {
      expect(
        (
          await plantAdmin.patch(`/iam/scopes/${fixture.alpha.plantB.id}`, {
            name: 'Still not allowed',
          })
        ).status,
      ).toBe(403);

      const trail = await waitForAudit('authz.scope_denied');
      expect(trail).toBeDefined();
      expect(trail?.action).toBe('authz.scope_denied');
    });

    it('survives the request it refused — the 403 does not roll it back', async () => {
      const before = await countAudit('authz.permission_denied');

      expect((await member.get('/iam/roles?limit=1')).status).toBe(403);
      expect((await member.get('/iam/roles?limit=1')).status).toBe(403);

      await waitForCount('authz.permission_denied', before + 2);
    });
  });

  /* ── audit helpers ────────────────────────────────────────────────────── */

  interface AuditRow {
    action: string;
    payload: Record<string, unknown>;
    created_at: string;
  }

  async function auditRows(action: string): Promise<AuditRow[]> {
    const trail = expectOk(
      await admin.get<{ data: AuditRow[] }>(
        `/iam/audit?action=${encodeURIComponent(action)}&limit=100`,
      ),
      `read audit for ${action}`,
    );
    return trail.data;
  }

  const countAudit = async (action: string): Promise<number> =>
    (await auditRows(action)).length;

  /**
   * `recordDenial` runs on its own connection and is not awaited by the
   * response, so the row can land a moment after the 403 the caller already
   * has. Polling rather than sleeping keeps the common case instant.
   */
  async function waitForAudit(action: string): Promise<AuditRow | undefined> {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const [row] = await auditRows(action);
      if (row !== undefined) return row;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return undefined;
  }

  async function waitForCount(action: string, atLeast: number): Promise<void> {
    const deadline = Date.now() + 10_000;
    let seen = 0;
    while (Date.now() < deadline) {
      seen = await countAudit(action);
      if (seen >= atLeast) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`Expected ≥${atLeast} ${action} rows; saw ${seen}.`);
  }
});
