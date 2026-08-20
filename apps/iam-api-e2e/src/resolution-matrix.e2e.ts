/**
 * **The resolution correctness matrix** — WHO × WHAT × WHERE, over HTTP
 * (Doc 04 §4–6, Doc 06 §11).
 *
 * Doc 08 §7 names four properties this file has to hold down: *ancestor
 * coverage, minimisation, expiry, disabled applications, and deny-by-default*.
 * Each of the cases below is one row of that matrix, and each one is asked of
 * the running service through `GET /iam/permissions/resolve` and
 * `POST /iam/permissions/check` — never of `ResolverService` directly.
 *
 * ## Why over HTTP, when `authz.integration.spec.ts` already covers the algebra
 *
 * Because resolution reaching a caller passes through four things the unit
 * suite replaces or skips: the guard, the RLS context the interceptor installs,
 * the **real** Redis cache, and JSON serialisation. A resolver that is right and
 * a cache that keys on the wrong tenant produce a correct function and an
 * incorrect system, and only one of those is what a customer gets. The last
 * block below exists for exactly that: it asks the same question twice, once
 * cold and once warm, and requires the same answer.
 *
 * ## The subjects, and what each one is for
 *
 * From `two-tenant-fixture.ts`, per tenant:
 *
 * | subject | bindings | proves |
 * |---|---|---|
 * | `operator` | `dc.create` at Plant A **and** at Gate A11 | minimisation — the descendant must be dropped |
 * | `approver` | `dc.approve` at the root, `dc.create` at Plant A | per-permission independent minimisation; the create/approve asymmetry |
 * | `machine` | `dc.create` at Gate A11 | a service account resolves exactly like a person |
 * | `outsider` | none | deny-by-default |
 * | `admin` | every `iam.client.*` at the root | the tenant's own console |
 */

import { as, expectOk, type Caller } from './support/api';
import {
  callerFor,
  machineToken,
  PERM,
  platform,
  seedTwoTenants,
  type TwoTenants,
} from './support/two-tenant-fixture';

const PREFIX = 'e2e-resolve-';

interface Grants {
  permissions: string[];
  scopes: Record<string, string[]>;
}

describe('resolution correctness matrix', () => {
  let fixture: TwoTenants;
  let admin: Caller;
  let operator: Caller;
  let approver: Caller;
  let outsider: Caller;
  let machine: Caller;

  beforeAll(async () => {
    fixture = await seedTwoTenants(PREFIX);
    admin = await callerFor(fixture.alpha, fixture.alpha.admin);
    operator = await callerFor(fixture.alpha, fixture.alpha.operator);
    approver = await callerFor(fixture.alpha, fixture.alpha.approver);
    outsider = await callerFor(fixture.alpha, fixture.alpha.outsider);
    machine = as(await machineToken(fixture.alpha.machine));
  });

  const grantsFor = async (caller: Caller, query = ''): Promise<Grants> =>
    expectOk(await caller.get<Grants>(`/iam/permissions/resolve${query}`), 'resolve');

  const allowed = async (
    caller: Caller,
    permission: string,
    scopeNodeId: string,
  ): Promise<boolean> =>
    expectOk(
      await caller.post<{ allowed: boolean }>('/iam/permissions/check', {
        permission,
        scopeNodeId,
      }),
      'check',
    ).allowed;

  describe('deny by default (Doc 04 §9)', () => {
    it('gives a subject with no bindings nothing at all', async () => {
      const grants = await grantsFor(outsider);

      expect(grants).toEqual({ permissions: [], scopes: {} });
    });

    it('refuses that subject at every node in their own tenant', async () => {
      for (const node of [
        fixture.alpha.root,
        fixture.alpha.plantA,
        fixture.alpha.gateA11,
      ]) {
        expect(await allowed(outsider, PERM.CREATE, node.id)).toBe(false);
      }
    });

    it('refuses a permission no application has ever registered', async () => {
      expect(
        await allowed(admin, 'nothing.ever.registered', fixture.alpha.root.id),
      ).toBe(false);
    });
  });

  describe('coverage follows the tree (Doc 04 §5)', () => {
    it('covers the bound node itself', async () => {
      expect(await allowed(operator, PERM.CREATE, fixture.alpha.plantA.id)).toBe(
        true,
      );
    });

    it('covers every node beneath the bound one — the whole point of ltree', async () => {
      for (const node of [fixture.alpha.deptA1, fixture.alpha.gateA11]) {
        expect(await allowed(operator, PERM.CREATE, node.id)).toBe(true);
      }
    });

    it('does not cover an ancestor of the bound node', async () => {
      // Access flows down, never up: a plant manager is not a group director.
      expect(await allowed(operator, PERM.CREATE, fixture.alpha.root.id)).toBe(
        false,
      );
    });

    it('does not cover a sibling plant or anything under it', async () => {
      for (const node of [fixture.alpha.plantB, fixture.alpha.gateB1]) {
        expect(await allowed(operator, PERM.CREATE, node.id)).toBe(false);
      }
    });

    it('answers false — not 404 — for a node in the other tenant', async () => {
      // A 404 here would be an existence oracle: "no such node" and "not yours"
      // must be indistinguishable (Doc 06 §2).
      const response = await operator.post<{ allowed: boolean }>(
        '/iam/permissions/check',
        { permission: PERM.CREATE, scopeNodeId: fixture.beta.plantA.id },
      );

      expect(response.status).toBe(200);
      expect(response.data.allowed).toBe(false);
    });
  });

  describe('permissions do not imply one another (Doc 04 §5)', () => {
    it('holds approve at the root without holding create there', async () => {
      expect(await allowed(approver, PERM.APPROVE, fixture.alpha.root.id)).toBe(
        true,
      );
      expect(await allowed(approver, PERM.CREATE, fixture.alpha.root.id)).toBe(
        false,
      );
    });

    it('holds create only where create was granted', async () => {
      expect(await allowed(approver, PERM.CREATE, fixture.alpha.gateA11.id)).toBe(
        true,
      );
      expect(await allowed(approver, PERM.CREATE, fixture.alpha.plantB.id)).toBe(
        false,
      );
    });

    it('grants nobody the third permission the catalogue registered', async () => {
      // `visitor.read` exists, is active, and is mapped to a role bound to
      // nobody — so no subject in the fixture may hold it anywhere.
      for (const caller of [operator, approver, machine]) {
        expect(await allowed(caller, PERM.VISITOR, fixture.alpha.gateA11.id)).toBe(
          false,
        );
      }
    });
  });

  describe('minimal covering sets (Doc 04 §4)', () => {
    it('drops a descendant path when an ancestor is present', async () => {
      // The operator is bound at Plant A *and* at Gate A11 beneath it. Both
      // bindings are real; only one path is informative.
      const grants = await grantsFor(operator);

      expect(grants.permissions).toEqual([PERM.CREATE]);
      expect(grants.scopes[PERM.CREATE]).toEqual([fixture.alpha.plantA.path]);
    });

    it('minimises each permission independently', async () => {
      const grants = await grantsFor(approver);

      expect(new Set(grants.permissions)).toEqual(
        new Set([PERM.CREATE, PERM.APPROVE]),
      );
      expect(grants.scopes[PERM.APPROVE]).toEqual([fixture.alpha.root.path]);
      expect(grants.scopes[PERM.CREATE]).toEqual([fixture.alpha.plantA.path]);
    });

    it('keeps sibling subtrees as separate covering paths', async () => {
      const spare = expectOk(
        await admin.post<{ id: string }>('/iam/role-bindings', {
          user_id: fixture.alpha.operator.id,
          role_id: fixture.alpha.operatorRoleId,
          scope_node_id: fixture.alpha.plantB.id,
        }),
        'bind operator at Plant B',
      );

      try {
        const grants = await grantsFor(operator);

        // Neither covers the other, so neither may be dropped.
        expect(new Set(grants.scopes[PERM.CREATE])).toEqual(
          new Set([fixture.alpha.plantA.path, fixture.alpha.plantB.path]),
        );
        expect(await allowed(operator, PERM.CREATE, fixture.alpha.gateB1.id)).toBe(
          true,
        );
      } finally {
        await admin.del(`/iam/role-bindings/${spare.id}`);
      }
    });
  });

  describe('a machine identity resolves exactly like a person (Doc 01 §4.5)', () => {
    it('gets the permissions of the role it is bound to', async () => {
      const grants = await grantsFor(machine);

      expect(grants.permissions).toEqual([PERM.CREATE]);
      expect(grants.scopes[PERM.CREATE]).toEqual([fixture.alpha.gateA11.path]);
    });

    it('is bounded by the same tree', async () => {
      expect(await allowed(machine, PERM.CREATE, fixture.alpha.gateA11.id)).toBe(
        true,
      );
      expect(await allowed(machine, PERM.CREATE, fixture.alpha.plantA.id)).toBe(
        false,
      );
    });
  });

  describe('expiry (Doc 01 §4.5)', () => {
    it('honours a binding that has not expired yet', async () => {
      const binding = expectOk(
        await admin.post<{ id: string; expired: boolean }>('/iam/role-bindings', {
          user_id: fixture.alpha.outsider.id,
          role_id: fixture.alpha.approverRoleId,
          scope_node_id: fixture.alpha.plantB.id,
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        }),
        'bind with a future expiry',
      );

      try {
        expect(binding.expired).toBe(false);
        expect(await allowed(outsider, PERM.APPROVE, fixture.alpha.plantB.id)).toBe(
          true,
        );
      } finally {
        await admin.del(`/iam/role-bindings/${binding.id}`);
      }
    });

    it('ignores one that has lapsed, but still lists it', async () => {
      const binding = expectOk(
        await admin.post<{ id: string }>('/iam/role-bindings', {
          user_id: fixture.alpha.outsider.id,
          role_id: fixture.alpha.approverRoleId,
          scope_node_id: fixture.alpha.plantB.id,
          // Two seconds is the shortest honest way to age a row through the
          // API: the DTO takes a future timestamp, so the alternative is
          // reaching into the table, which would stop testing the endpoint.
          expires_at: new Date(Date.now() + 2_000).toISOString(),
        }),
        'bind with a near expiry',
      );

      try {
        await new Promise((resolve) => setTimeout(resolve, 3_500));

        expect(await allowed(outsider, PERM.APPROVE, fixture.alpha.plantB.id)).toBe(
          false,
        );
        expect((await grantsFor(outsider)).permissions).toEqual([]);

        // Expired is not deleted — the row stays visible for audit and history,
        // flagged rather than hidden (Doc 06 §9).
        const listed = expectOk(
          await admin.get<{ data: { id: string; expired: boolean }[] }>(
            `/iam/role-bindings?user_id=${fixture.alpha.outsider.id}&limit=50`,
          ),
          'list bindings',
        );
        const row = listed.data.find((entry) => entry.id === binding.id);
        expect(row?.expired).toBe(true);
      } finally {
        await admin.del(`/iam/role-bindings/${binding.id}`);
      }
    });
  });

  describe('an application that has stopped granting (Doc 04 §7)', () => {
    it('drops its permissions while it is disabled for the tenant, and restores them', async () => {
      const platformCaller = await platform();

      expect(
        (
          await platformCaller.patch(
            `/iam/clients/${fixture.alpha.clientId}/applications/${fixture.opsApplicationId}`,
            { enabled: false },
          )
        ).status,
      ).toBe(200);

      try {
        // The bindings are untouched — Doc 02 §3 is explicit that a disabled
        // application's mappings are inert, not deleted. What changes is what
        // they grant.
        expect((await grantsFor(operator)).permissions).toEqual([]);
        expect(await allowed(operator, PERM.CREATE, fixture.alpha.gateA11.id)).toBe(
          false,
        );

        // And only for this tenant.
        const betaOperator = await callerFor(fixture.beta, fixture.beta.operator);
        expect((await grantsFor(betaOperator)).permissions).toEqual([PERM.CREATE]);
      } finally {
        expect(
          (
            await platformCaller.patch(
              `/iam/clients/${fixture.alpha.clientId}/applications/${fixture.opsApplicationId}`,
              { enabled: true },
            )
          ).status,
        ).toBe(200);
      }

      expect((await grantsFor(operator)).permissions).toEqual([PERM.CREATE]);
    });
  });

  describe('?applicationId= (Doc 06 §11)', () => {
    it('returns only that application’s slice', async () => {
      const slice = await grantsFor(
        admin,
        `?applicationId=${fixture.opsApplicationId}`,
      );

      // The tenant administrator holds forty `iam.client.*` permissions and no
      // `e2e-ops` ones, so the ops slice of their grants is empty while the
      // unfiltered answer is not.
      expect(slice.permissions).toEqual([]);
      expect((await grantsFor(admin)).permissions.length).toBeGreaterThan(0);
    });

    it('returns the ops slice for somebody who actually holds ops permissions', async () => {
      const slice = await grantsFor(
        operator,
        `?applicationId=${fixture.opsApplicationId}`,
      );

      expect(slice.permissions).toEqual([PERM.CREATE]);
    });

    it('refuses an applicationId that is not a uuid', async () => {
      const response = await operator.get('/iam/permissions/resolve?applicationId=nope');

      expect(response.status).toBe(400);
    });
  });

  describe('cross-tenant (Doc 02 §6)', () => {
    it('never leaks the other tenant’s grants into a subject’s answer', async () => {
      const alphaGrants = await grantsFor(operator);
      const paths = Object.values(alphaGrants.scopes).flat();

      expect(paths.length).toBeGreaterThan(0);
      expect(
        paths.some((path) => path.startsWith(fixture.beta.root.path)),
      ).toBe(false);
    });

    it('gives the same-named subject in each tenant its own answer', async () => {
      const betaOperator = await callerFor(fixture.beta, fixture.beta.operator);

      expect((await grantsFor(operator)).scopes[PERM.CREATE]).toEqual([
        fixture.alpha.plantA.path,
      ]);
      expect((await grantsFor(betaOperator)).scopes[PERM.CREATE]).toEqual([
        fixture.beta.plantA.path,
      ]);
    });
  });

  /**
   * The cache is a real Redis here, which is what makes this block worth
   * writing: a resolver that is correct and a cache keyed on the wrong subject
   * or the wrong tenant is a system that is wrong, and every unit test of the
   * resolver passes.
   */
  describe('the cached answer is the same answer (Doc 04 §6)', () => {
    it('is stable across repeated resolves', async () => {
      const first = await grantsFor(operator);
      const second = await grantsFor(operator);
      const third = await grantsFor(operator);

      expect(second).toEqual(first);
      expect(third).toEqual(first);
    });

    it('does not answer one subject from another’s entry', async () => {
      // Warm both, interleaved, then read both again: a cache key missing the
      // subject would show up here and nowhere else.
      await grantsFor(operator);
      await grantsFor(approver);

      expect((await grantsFor(operator)).permissions).toEqual([PERM.CREATE]);
      expect(new Set((await grantsFor(approver)).permissions)).toEqual(
        new Set([PERM.CREATE, PERM.APPROVE]),
      );
    });

    it('does not answer one tenant from another’s entry', async () => {
      const betaApprover = await callerFor(fixture.beta, fixture.beta.approver);

      await grantsFor(approver);
      const beta = await grantsFor(betaApprover);

      expect(beta.scopes[PERM.APPROVE]).toEqual([fixture.beta.root.path]);
    });
  });

  describe('introspection agrees with the token (Doc 06 §11)', () => {
    it('reports a live token with its subject and tenant', async () => {
      const token = operator.token as string;
      const claims = expectOk(
        await operator.post<{
          active: boolean;
          sub: string;
          cid: string;
          sty: string;
        }>('/iam/introspect', { token }),
        'introspect',
      );

      expect(claims.active).toBe(true);
      expect(claims.sub).toBe(fixture.alpha.operator.id);
      expect(claims.cid).toBe(fixture.alpha.clientId);
      expect(claims.sty).toBe('user');
    });

    it('reports anything that is not a token as inactive, never as an error', async () => {
      const response = await operator.post<{ active: boolean }>('/iam/introspect', {
        token: 'not-a-token',
      });

      expect(response.status).toBe(200);
      expect(response.data.active).toBe(false);
    });
  });
});
