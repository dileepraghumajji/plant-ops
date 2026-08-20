/**
 * **Cache invalidation — every row of the Doc 04 §7 table, against a real Redis.**
 *
 * The claim under test is a negative one, and it is the reason this file has to
 * exist outside `apps/iam-api`: *a grant change takes effect immediately, never
 * via TTL luck*. The grants cache lives for ten minutes (Doc 04 §6), so any
 * missing invalidation looks exactly like a working system for the length of a
 * test run and then quietly serves stale authority in production for up to ten
 * minutes after every change an administrator makes.
 *
 * `apps/iam-api/src/authz/invalidation.integration.spec.ts` proves the
 * *announcements* — it subscribes to `perms.invalidated` and checks who was
 * named. This file never looks at the channel. It warms the cache with a
 * resolve, makes the change through the API, resolves again, and requires the
 * answer to have moved. That is the property a customer has; the pub/sub message
 * is the mechanism, and a mechanism that fires while the entry survives is worth
 * nothing.
 *
 * Warming first is the whole method. A case that resolved only *after* the
 * change would pass against a cache that was never populated, never invalidated,
 * and never correct.
 *
 * Every case restores what it changed, because the fixture's shape is what the
 * next case assumes.
 */

import { as, expectOk, type Caller } from './support/api';
import {
  callerFor,
  machineToken,
  OPS_APPLICATION_KEY,
  PERM,
  platform,
  seedTwoTenants,
  type TwoTenants,
} from './support/two-tenant-fixture';

const PREFIX = 'e2e-inval-';

interface Grants {
  permissions: string[];
  scopes: Record<string, string[]>;
}

/** The manifest the fixture uploads, restored by the case that shrinks it. */
const FULL_OPS_MANIFEST = {
  key: OPS_APPLICATION_KEY,
  name: 'E2E Operations',
  permissions: [
    { key: PERM.CREATE, name: 'Create delivery challan' },
    { key: PERM.APPROVE, name: 'Approve delivery challan' },
    { key: PERM.VISITOR, name: 'Read visitors' },
  ],
  nav: [
    {
      kind: 'module',
      key: 'e2e-ops.root',
      label: 'E2E Operations',
      sortOrder: 10,
      children: [
        {
          kind: 'menu',
          key: 'e2e-ops.dc',
          label: 'Delivery challans',
          route: '/dc',
          sortOrder: 10,
          requires: [PERM.CREATE],
        },
        {
          kind: 'menu',
          key: 'e2e-ops.approvals',
          label: 'Approvals',
          route: '/approvals',
          sortOrder: 20,
          requires: [PERM.APPROVE],
        },
        {
          kind: 'menu',
          key: 'e2e-ops.help',
          label: 'Help',
          route: '/help',
          sortOrder: 30,
          isPublic: true,
        },
      ],
    },
  ],
};

describe('grant invalidation (Doc 04 §7)', () => {
  let fixture: TwoTenants;
  let admin: Caller;
  let operator: Caller;
  let member: Caller;

  beforeAll(async () => {
    fixture = await seedTwoTenants(PREFIX);
    admin = await callerFor(fixture.alpha, fixture.alpha.admin);
    operator = await callerFor(fixture.alpha, fixture.alpha.operator);
    member = await callerFor(fixture.alpha, fixture.alpha.outsider);
  });

  const grantsFor = async (caller: Caller): Promise<Grants> =>
    expectOk(await caller.get<Grants>('/iam/permissions/resolve'), 'resolve');

  /** Warms the subject's cache entry and returns what it was warmed with. */
  const warm = (caller: Caller): Promise<Grants> => grantsFor(caller);

  describe('role_binding created / deleted → that subject', () => {
    it('grants immediately on create and withdraws immediately on delete', async () => {
      expect((await warm(member)).permissions).toEqual([]);

      const binding = expectOk(
        await admin.post<{ id: string }>('/iam/role-bindings', {
          user_id: fixture.alpha.outsider.id,
          role_id: fixture.alpha.visitorRoleId,
          scope_node_id: fixture.alpha.plantB.id,
        }),
        'bind the member',
      );

      expect((await grantsFor(member)).permissions).toEqual([PERM.VISITOR]);

      expect((await admin.del(`/iam/role-bindings/${binding.id}`)).status).toBe(204);

      expect((await grantsFor(member)).permissions).toEqual([]);
    });
  });

  describe('role_permission changed → every subject bound to that role', () => {
    it('reaches a holder who is not the administrator making the change', async () => {
      expect((await warm(operator)).permissions).toEqual([PERM.CREATE]);

      const original = expectOk(
        await admin.get<{ permissions: { id: string }[] }>(
          `/iam/roles/${fixture.alpha.operatorRoleId}/permissions`,
        ),
        'read role permissions',
      );

      try {
        // Add a second key to the role the operator holds. Nothing about the
        // operator's own row changed — only the role's composition did, which is
        // the row of §7 that needs either a fan-out or a per-subject version.
        expectOk(
          await admin.put(`/iam/roles/${fixture.alpha.operatorRoleId}/permissions`, {
            permission_ids: [
              fixture.alpha.permissionIds[PERM.CREATE],
              fixture.alpha.permissionIds[PERM.VISITOR],
            ],
          }),
          'add a permission to the role',
        );

        expect(new Set((await grantsFor(operator)).permissions)).toEqual(
          new Set([PERM.CREATE, PERM.VISITOR]),
        );

        // And removing it again takes it away just as immediately.
        expectOk(
          await admin.put(`/iam/roles/${fixture.alpha.operatorRoleId}/permissions`, {
            permission_ids: [fixture.alpha.permissionIds[PERM.CREATE]],
          }),
          'remove it again',
        );

        expect((await grantsFor(operator)).permissions).toEqual([PERM.CREATE]);
      } finally {
        await admin.put(`/iam/roles/${fixture.alpha.operatorRoleId}/permissions`, {
          permission_ids: original.permissions.map((permission) => permission.id),
        });
      }
    });
  });

  describe('role deleted → every subject bound to that role', () => {
    it('withdraws the grant the deleted role carried', async () => {
      const role = expectOk(
        await admin.post<{ id: string }>('/iam/roles', { name: 'Doomed Role' }),
        'create a role',
      );
      expectOk(
        await admin.put(`/iam/roles/${role.id}/permissions`, {
          permission_ids: [fixture.alpha.permissionIds[PERM.VISITOR]],
        }),
        'map a permission',
      );
      expectOk(
        await admin.post('/iam/role-bindings', {
          user_id: fixture.alpha.outsider.id,
          role_id: role.id,
          scope_node_id: fixture.alpha.root.id,
        }),
        'bind the member to it',
      );

      expect((await warm(member)).permissions).toEqual([PERM.VISITOR]);

      expect((await admin.del(`/iam/roles/${role.id}`)).status).toBe(204);

      // The cascade removed the binding; the subject must hear about it even
      // though nothing addressed them by name.
      expect((await grantsFor(member)).permissions).toEqual([]);
    });
  });

  /**
   * Doc 04 §7.1 — the highest-risk concurrency case. What a caller can observe
   * is narrower than what §7.1 mandates (the ordering of commit and publish is
   * asserted in-process, where the channel is visible), but it is the part that
   * matters to them: after the move, coverage follows the new tree and the
   * cached paths are gone.
   */
  describe('scope_node moved → every subject with a binding in that subtree', () => {
    it('rewrites the covering path and answers coverage against the new tree', async () => {
      const before = await warm(operator);
      expect(before.scopes[PERM.CREATE]).toEqual([fixture.alpha.plantA.path]);

      // Plant A moves under Plant B. Every path beneath it is rewritten in one
      // statement (Doc 07 §7), and the operator's binding travels with it.
      expectOk(
        await admin.patch(`/iam/scopes/${fixture.alpha.plantA.id}`, {
          parent_id: fixture.alpha.plantB.id,
        }),
        'move Plant A under Plant B',
      );

      try {
        const after = await grantsFor(operator);
        const moved = after.scopes[PERM.CREATE];

        expect(moved).toHaveLength(1);
        expect(moved[0]).not.toBe(fixture.alpha.plantA.path);
        expect(moved[0].startsWith(`${fixture.alpha.plantB.path}.`)).toBe(true);

        // Gate A11 came along; Gate B1 is a sibling and did not.
        expect(await allows(operator, PERM.CREATE, fixture.alpha.gateA11.id)).toBe(
          true,
        );
        expect(await allows(operator, PERM.CREATE, fixture.alpha.gateB1.id)).toBe(
          false,
        );
      } finally {
        await admin.patch(`/iam/scopes/${fixture.alpha.plantA.id}`, {
          parent_id: fixture.alpha.root.id,
        });
      }

      expect((await grantsFor(operator)).scopes[PERM.CREATE]).toEqual([
        fixture.alpha.plantA.path,
      ]);
    });

    it('changes nothing on a rename, which changes no path', async () => {
      const before = await warm(operator);

      expectOk(
        await admin.patch(`/iam/scopes/${fixture.alpha.plantA.id}`, {
          name: 'Plant A (renamed)',
        }),
        'rename Plant A',
      );

      try {
        // Doc 01 §3.5: labels are id-derived, so a rename touches `name` and
        // nothing else. Grants that moved here would mean paths carry names.
        expect(await grantsFor(operator)).toEqual(before);
      } finally {
        await admin.patch(`/iam/scopes/${fixture.alpha.plantA.id}`, {
          name: 'Plant A',
        });
      }
    });
  });

  describe('user locked or disabled → that subject (and their sessions)', () => {
    it('ends the session the moment the account is locked', async () => {
      const victimCaller = await callerFor(fixture.alpha, fixture.alpha.approver);
      expect((await warm(victimCaller)).permissions.length).toBeGreaterThan(0);

      try {
        expectOk(
          await admin.patch(`/iam/users/${fixture.alpha.approver.id}`, {
            status: 'locked',
          }),
          'lock the approver',
        );

        // Revocation and grant invalidation are different mechanisms with the
        // same trigger; the caller sees the stricter of the two.
        expect((await victimCaller.get('/iam/permissions/resolve')).status).toBe(401);
      } finally {
        await admin.patch(`/iam/users/${fixture.alpha.approver.id}`, {
          status: 'active',
        });
      }

      const again = await callerFor(fixture.alpha, fixture.alpha.approver);
      expect((await grantsFor(again)).permissions.length).toBeGreaterThan(0);
    });
  });

  describe('service_account revoked → that subject', () => {
    it('stops the next exchange, and reactivating starts it again', async () => {
      const machine = as(await machineToken(fixture.alpha.machine));
      expect((await warm(machine)).permissions).toEqual([PERM.CREATE]);

      expectOk(
        await admin.patch(`/iam/service-accounts/${fixture.alpha.machine.id}`, {
          status: 'revoked',
        }),
        'revoke the machine',
      );

      try {
        // Doc 03 §5: the ephemeral `sid` cannot be revoked, so revocation bites
        // at the next exchange — which must be immediate, not TTL-bounded.
        const refused = await as(undefined).post('/auth/token', {
          account_key: fixture.alpha.machine.accountKey,
          account_secret: fixture.alpha.machine.accountSecret,
        });
        expect(refused.status).toBe(401);
      } finally {
        await admin.patch(`/iam/service-accounts/${fixture.alpha.machine.id}`, {
          status: 'active',
        });
      }

      expect(await machineToken(fixture.alpha.machine)).toEqual(expect.any(String));
    });
  });

  describe('client_application disabled or re-enabled → subjects of that client', () => {
    it('moves the whole application’s permissions with the toggle, both ways', async () => {
      const platformCaller = await platform();
      expect((await warm(operator)).permissions).toEqual([PERM.CREATE]);

      expectOk(
        await platformCaller.patch(
          `/iam/clients/${fixture.alpha.clientId}/applications/${fixture.opsApplicationId}`,
          { enabled: false },
        ),
        'disable the application',
      );

      try {
        expect((await grantsFor(operator)).permissions).toEqual([]);

        // Doc 04 §7 lists *re-enabling* as its own trigger, and for the same
        // reason: it changes effective grants, so it cannot wait for a TTL.
        expectOk(
          await (
            await platform()
          ).patch(
            `/iam/clients/${fixture.alpha.clientId}/applications/${fixture.opsApplicationId}`,
            { enabled: true },
          ),
          're-enable the application',
        );

        expect((await grantsFor(operator)).permissions).toEqual([PERM.CREATE]);
      } finally {
        await (
          await platform()
        ).patch(
          `/iam/clients/${fixture.alpha.clientId}/applications/${fixture.opsApplicationId}`,
          { enabled: true },
        );
      }
    });

    it('leaves the other tenant’s subjects untouched', async () => {
      const platformCaller = await platform();
      const betaOperator = await callerFor(fixture.beta, fixture.beta.operator);
      await warm(betaOperator);

      expectOk(
        await platformCaller.patch(
          `/iam/clients/${fixture.alpha.clientId}/applications/${fixture.opsApplicationId}`,
          { enabled: false },
        ),
        'disable it for alpha only',
      );

      try {
        expect((await grantsFor(betaOperator)).permissions).toEqual([PERM.CREATE]);
      } finally {
        await (
          await platform()
        ).patch(
          `/iam/clients/${fixture.alpha.clientId}/applications/${fixture.opsApplicationId}`,
          { enabled: true },
        );
      }
    });
  });

  describe('permission retired by a manifest re-upload → its holders (Doc 02 §7)', () => {
    it('retires the key immediately and restores it on the next upload', async () => {
      const binding = expectOk(
        await admin.post<{ id: string }>('/iam/role-bindings', {
          user_id: fixture.alpha.outsider.id,
          role_id: fixture.alpha.visitorRoleId,
          scope_node_id: fixture.alpha.root.id,
        }),
        'bind the member to the visitor role',
      );

      try {
        expect((await warm(member)).permissions).toEqual([PERM.VISITOR]);

        // Re-upload without `visitor.read`. Doc 02 §7: absent keys are
        // soft-deactivated, never hard-deleted — the role mapping survives and
        // simply stops granting, which is precisely why the cache must be told.
        expectOk(
          await (
            await platform()
          ).post(`/iam/applications/${fixture.opsApplicationId}/manifest`, {
            ...FULL_OPS_MANIFEST,
            permissions: FULL_OPS_MANIFEST.permissions.filter(
              (permission) => permission.key !== PERM.VISITOR,
            ),
          }),
          'shrink the manifest',
        );

        expect((await grantsFor(member)).permissions).toEqual([]);
      } finally {
        // Restore for every case and every file that comes after: the manifest
        // is platform catalogue, shared by the whole battery.
        await (
          await platform()
        ).post(
          `/iam/applications/${fixture.opsApplicationId}/manifest`,
          FULL_OPS_MANIFEST,
        );
        await admin.del(`/iam/role-bindings/${binding.id}`);
      }
    });
  });

  /**
   * The last row of §7, and the **only one that is not immediate** — the spec
   * says so in as many words: *time passing is not a hook*, so nothing fires
   * when `expires_at` slips into the past. A warm cache entry therefore keeps
   * granting until something tells it not to, and the two things that can are
   * the ten-minute TTL and the periodic sweep.
   *
   * Which makes this the one case that must **not** be written like the others.
   * Asserting "resolve reflects it immediately" here would be asserting a
   * property the design deliberately does not have, and the way it fails is
   * instructive: the grant survives the expiry for as long as the entry does.
   * What is actually promised is that the *sweep* closes the window, and that is
   * what is asserted — the audit row first, then the withdrawn grant.
   *
   * `api-process.ts` runs the sweep every five seconds for this battery so the
   * case does not have to wait out the shipped minute.
   */
  describe('role_binding expires_at reached → the periodic sweep', () => {
    it('lets the sweep close the window it leaves open, and audits the lapse', async () => {
      const binding = expectOk(
        await admin.post<{ id: string }>('/iam/role-bindings', {
          user_id: fixture.alpha.outsider.id,
          role_id: fixture.alpha.visitorRoleId,
          scope_node_id: fixture.alpha.root.id,
          expires_at: new Date(Date.now() + 2_000).toISOString(),
        }),
        'bind with a near expiry',
      );

      try {
        expect((await warm(member)).permissions).toEqual([PERM.VISITOR]);

        // The sweep claims the lapsed binding, audits it, and announces the
        // subject (Doc 01 §4.5). The audit row is the observable half.
        await waitForAudit('role_binding.expired', binding.id);

        // And only then is the cached grant gone.
        expect((await grantsFor(member)).permissions).toEqual([]);
      } finally {
        await admin.del(`/iam/role-bindings/${binding.id}`);
      }
    }, 60_000);

    it('reads a lapsed binding as ungranted on a cold cache, sweep or no sweep', async () => {
      // The other half of the same row: resolution itself filters on
      // `expires_at` (Doc 04 §4), so a subject whose entry is *not* warm never
      // sees the window at all. The sweep exists for the ones whose entry is.
      const cold = await callerFor(fixture.beta, fixture.beta.outsider);
      const binding = expectOk(
        await (
          await callerFor(fixture.beta, fixture.beta.admin)
        ).post<{ id: string }>('/iam/role-bindings', {
          user_id: fixture.beta.outsider.id,
          role_id: fixture.beta.visitorRoleId,
          scope_node_id: fixture.beta.root.id,
          expires_at: new Date(Date.now() + 2_000).toISOString(),
        }),
        'bind with a near expiry in the other tenant',
      );

      try {
        await sleep(3_500);
        expect((await grantsFor(cold)).permissions).toEqual([]);
      } finally {
        await (
          await callerFor(fixture.beta, fixture.beta.admin)
        ).del(`/iam/role-bindings/${binding.id}`);
      }
    });
  });

  /**
   * Doc 05 §5: navigation is a pure function of grants and catalogue, so a
   * change that invalidates one has to move the other in the same breath. A
   * menu that survives its permission is the visible half of a stale cache.
   */
  describe('navigation follows the same invalidation', () => {
    it('shows a menu the moment its permission is granted, and hides it again', async () => {
      const before = await navKeys(member);
      expect(before).not.toContain('e2e-ops.dc');

      const binding = expectOk(
        await admin.post<{ id: string }>('/iam/role-bindings', {
          user_id: fixture.alpha.outsider.id,
          role_id: fixture.alpha.operatorRoleId,
          scope_node_id: fixture.alpha.plantA.id,
        }),
        'grant the member dc.create',
      );

      try {
        expect(await navKeys(member)).toContain('e2e-ops.dc');
        // The unmapped, `isPublic` node is visible either way (Doc 05 §3).
        expect(await navKeys(member)).toContain('e2e-ops.help');
        // And the one behind a permission they still lack is not.
        expect(await navKeys(member)).not.toContain('e2e-ops.approvals');
      } finally {
        await admin.del(`/iam/role-bindings/${binding.id}`);
      }

      expect(await navKeys(member)).not.toContain('e2e-ops.dc');
    });
  });

  /* ── helpers ──────────────────────────────────────────────────────────── */

  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  async function allows(
    caller: Caller,
    permission: string,
    scopeNodeId: string,
  ): Promise<boolean> {
    return expectOk(
      await caller.post<{ allowed: boolean }>('/iam/permissions/check', {
        permission,
        scopeNodeId,
      }),
      'check',
    ).allowed;
  }

  interface NavNode {
    key: string;
    children: NavNode[];
  }

  async function navKeys(caller: Caller): Promise<string[]> {
    const nav = expectOk(
      await caller.get<{ tree: NavNode[] }>('/iam/navigation'),
      'navigation',
    );
    const keys: string[] = [];
    const walk = (nodes: NavNode[]): void => {
      for (const node of nodes) {
        keys.push(node.key);
        walk(node.children);
      }
    };
    walk(nav.tree);
    return keys;
  }

  /** Polls the audit read until the sweep's row for `targetId` appears. */
  async function waitForAudit(action: string, targetId: string): Promise<void> {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const trail = expectOk(
        await admin.get<{ data: { target_id: string | null }[] }>(
          `/iam/audit?action=${encodeURIComponent(action)}&limit=100`,
        ),
        `read audit for ${action}`,
      );
      if (trail.data.some((row) => row.target_id === targetId)) return;
      await sleep(500);
    }
    throw new Error(`No ${action} audit row for binding ${targetId} appeared.`);
  }
});
