/**
 * The manifest schema and the diff (Doc 02 §2, §7).
 *
 * Everything in this file runs without Postgres, because everything in this file
 * is a property of a *document* and a snapshot: what a valid manifest is, and
 * what applying one to a given catalog would change. That is most of Session
 * 14's specification — idempotence, in-place update, soft-deactivation — and the
 * point of `manifest-diff.ts` being a pure function is that these can be pinned
 * here rather than inferred from a database afterwards.
 *
 * What genuinely needs a database — that the plan is applied in one transaction,
 * that the rows and audit records land, that nothing is hard-deleted — is
 * `manifest.integration.spec.ts`.
 */

import type { ApplicationManifest, ManifestNavNode } from '@plantops/contracts';
import { applicationManifestSchema } from './dto/manifest.dto';
import {
  computeManifestPlan,
  flattenManifestNav,
  isNoOpDiff,
  toManifestDiff,
  type CurrentCatalog,
} from './manifest-diff';

/**
 * Doc 02 §2's example, in pieces.
 *
 * The evolve cases below each differ from the baseline in one field, and they
 * say so by rebuilding the tree rather than by mutating a clone — the diff is
 * about *documents*, and two documents side by side read better than one
 * document and a patch applied to it.
 */
const moduleNode = (children: ManifestNavNode[]): ManifestNavNode => ({
  kind: 'module',
  key: 'gatepass',
  label: 'Gate Pass',
  icon: 'truck',
  children,
});

const createNode = (overrides: Partial<ManifestNavNode> = {}): ManifestNavNode => ({
  kind: 'menu',
  key: 'dc.create',
  label: 'New DC',
  route: '/gatepass/new',
  requires: ['gatepass.dc.create'],
  ...overrides,
});

const approvalsNode = (overrides: Partial<ManifestNavNode> = {}): ManifestNavNode => ({
  kind: 'menu',
  key: 'dc.approvals',
  label: 'Approvals',
  route: '/gatepass/approvals',
  requires: ['gatepass.dc.approve'],
  ...overrides,
});

const manifestWith = (
  nav: ManifestNavNode[],
  overrides: Partial<ApplicationManifest> = {},
): ApplicationManifest => ({
  key: 'gatepass',
  name: 'Gate Pass',
  permissions: [
    { key: 'gatepass.dc.create', name: 'Create DC' },
    { key: 'gatepass.dc.approve', name: 'Approve DC' },
  ],
  nav,
  ...overrides,
});

const MANIFEST = manifestWith([moduleNode([createNode(), approvalsNode()])]);

/** The catalog exactly as {@link MANIFEST} would leave it. */
const SETTLED: CurrentCatalog = {
  application: { key: 'gatepass', name: 'Gate Pass', description: null },
  permissions: [
    { key: 'gatepass.dc.approve', name: 'Approve DC', description: null, is_active: true },
    { key: 'gatepass.dc.create', name: 'Create DC', description: null, is_active: true },
  ],
  navNodes: [
    {
      key: 'dc.approvals',
      kind: 'menu',
      label: 'Approvals',
      route: '/gatepass/approvals',
      icon: null,
      sort_order: 1,
      is_public: false,
      is_active: true,
      parent_key: 'gatepass',
    },
    {
      key: 'dc.create',
      kind: 'menu',
      label: 'New DC',
      route: '/gatepass/new',
      icon: null,
      sort_order: 0,
      is_public: false,
      is_active: true,
      parent_key: 'gatepass',
    },
    {
      key: 'gatepass',
      kind: 'module',
      label: 'Gate Pass',
      route: null,
      icon: 'truck',
      sort_order: 0,
      is_public: false,
      is_active: true,
      parent_key: null,
    },
  ],
  mappings: new Map([
    ['dc.create', ['gatepass.dc.create']],
    ['dc.approvals', ['gatepass.dc.approve']],
  ]),
};

/** An application that exists but has no catalog yet — the first upload. */
const EMPTY: CurrentCatalog = {
  application: { key: 'gatepass', name: 'Gate Pass', description: null },
  permissions: [],
  navNodes: [],
  mappings: new Map(),
};

const diffOf = (current: CurrentCatalog, manifest: ApplicationManifest) =>
  toManifestDiff(computeManifestPlan(current, manifest));

describe('the manifest schema', () => {
  it('accepts Doc 02 §2’s example', () => {
    expect(applicationManifestSchema.safeParse(MANIFEST).success).toBe(true);
  });

  it('rejects an unknown field instead of dropping it', () => {
    // The opposite rule to every other body in the registry, and the reason is
    // in `manifest.dto.ts`: this is a hand-authored file, and a silently
    // stripped `sort_order` is a menu that comes out in the wrong order with
    // nothing to explain why.
    const result = applicationManifestSchema.safeParse({
      ...MANIFEST,
      nav: [{ kind: 'module', key: 'gatepass', label: 'Gate Pass', sort_order: 3 }],
    });

    expect(result.success).toBe(false);
  });

  it('refuses a requires naming a permission the manifest does not declare', () => {
    const result = applicationManifestSchema.safeParse({
      ...MANIFEST,
      nav: [
        {
          kind: 'menu',
          key: 'dc.create',
          label: 'New DC',
          route: '/gatepass/new',
          requires: ['gatepass.dc.delete'],
        },
      ],
    });

    // This same upload deactivates undeclared keys, so gating a node on one
    // would map a menu to a permission nobody can hold by the time the
    // transaction commits.
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(['nav', 0, 'requires', 0]);
  });

  it('refuses a nav key repeated anywhere in the tree', () => {
    const result = applicationManifestSchema.safeParse({
      ...MANIFEST,
      nav: [
        {
          kind: 'module',
          key: 'gatepass',
          label: 'Gate Pass',
          children: [{ kind: 'menu', key: 'gatepass', label: 'Itself' }],
        },
      ],
    });

    // The key is the upsert's natural key across the whole application, not per
    // level — two nodes sharing one would make the second an update of the first.
    expect(result.success).toBe(false);
  });

  it('refuses isPublic on a container', () => {
    const result = applicationManifestSchema.safeParse({
      ...MANIFEST,
      nav: [
        {
          kind: 'module',
          key: 'gatepass',
          label: 'Gate Pass',
          isPublic: true,
          children: [{ kind: 'menu', key: 'dc.create', label: 'New DC', route: '/x' }],
        },
      ],
    });

    // A container is visible when a descendant is (Doc 05 §3); `isPublic` on one
    // reads as "show this branch to everyone" and does nothing at all.
    expect(result.success).toBe(false);
  });

  it('refuses a fourth level of nesting', () => {
    const deep = {
      ...MANIFEST,
      permissions: [],
      nav: [
        {
          kind: 'module',
          key: 'a',
          label: 'A',
          children: [
            {
              kind: 'menu',
              key: 'b',
              label: 'B',
              children: [
                {
                  kind: 'sub_menu',
                  key: 'c',
                  label: 'C',
                  children: [{ kind: 'sub_menu', key: 'd', label: 'D', route: '/d' }],
                },
              ],
            },
          ],
        },
      ],
    };

    expect(applicationManifestSchema.safeParse(deep).success).toBe(false);
  });

  it('accepts empty permissions and nav — the shrink-to-nothing declaration', () => {
    expect(
      applicationManifestSchema.safeParse({ key: 'gatepass', name: 'Gate Pass', permissions: [], nav: [] })
        .success,
    ).toBe(true);
  });

  it('requires both arrays to be present', () => {
    expect(
      applicationManifestSchema.safeParse({ key: 'gatepass', name: 'Gate Pass' }).success,
    ).toBe(false);
  });
});

describe('flattening a manifest tree', () => {
  it('emits parents before their children', () => {
    expect(flattenManifestNav(MANIFEST.nav).map((node) => node.key)).toEqual([
      'gatepass',
      'dc.create',
      'dc.approvals',
    ]);
  });

  it('defaults sort_order to declaration order among siblings', () => {
    const flat = flattenManifestNav(MANIFEST.nav);

    // Doc 02 §2's own example would otherwise render "Approvals" above "New DC",
    // because `dc.approvals` sorts before `dc.create`.
    expect(flat.map((node) => [node.key, node.sort_order])).toEqual([
      ['gatepass', 0],
      ['dc.create', 0],
      ['dc.approvals', 1],
    ]);
  });

  it('honours an explicit sortOrder', () => {
    const [node] = flattenManifestNav([
      { kind: 'module', key: 'a', label: 'A', sortOrder: 42 },
    ]);
    expect(node.sort_order).toBe(42);
  });
});

describe('the manifest diff', () => {
  it('reports the first upload as all-created', () => {
    const diff = diffOf(EMPTY, MANIFEST);

    expect(diff.permissions.created).toEqual([
      'gatepass.dc.create',
      'gatepass.dc.approve',
    ]);
    expect(diff.nav.created).toEqual(['gatepass', 'dc.create', 'dc.approvals']);
    expect(diff.menu_permissions.mapped).toEqual([
      { nav_key: 'dc.create', permission_keys: ['gatepass.dc.create'] },
      { nav_key: 'dc.approvals', permission_keys: ['gatepass.dc.approve'] },
    ]);
    expect(isNoOpDiff(diff)).toBe(false);
  });

  it('reports a re-upload of the same manifest as nothing at all', () => {
    // The idempotence criterion. It is checked here, on the plan, because that
    // is what makes the upsert a no-op rather than a series of updates that
    // happen to set the same values.
    expect(isNoOpDiff(diffOf(SETTLED, MANIFEST))).toBe(true);
  });

  it('updates a changed label in place rather than replacing the node', () => {
    const renamed = manifestWith([
      moduleNode([createNode({ label: 'Raise a DC' }), approvalsNode()]),
    ]);

    const diff = diffOf(SETTLED, renamed);

    expect(diff.nav.updated).toEqual(['dc.create']);
    expect(diff.nav.created).toEqual([]);
    expect(diff.nav.deactivated).toEqual([]);
  });

  it('sees a re-parenting as an update of the node that moved', () => {
    const moved = manifestWith([moduleNode([createNode()]), approvalsNode()]);

    const diff = diffOf(SETTLED, moved);

    expect(diff.nav.updated).toEqual(['dc.approvals']);
  });

  it('deactivates keys the manifest stopped mentioning, and deletes nothing', () => {
    const shrunk: ApplicationManifest = {
      key: 'gatepass',
      name: 'Gate Pass',
      permissions: [{ key: 'gatepass.dc.create', name: 'Create DC' }],
      nav: [
        {
          kind: 'module',
          key: 'gatepass',
          label: 'Gate Pass',
          icon: 'truck',
          children: [
            {
              kind: 'menu',
              key: 'dc.create',
              label: 'New DC',
              route: '/gatepass/new',
              requires: ['gatepass.dc.create'],
            },
          ],
        },
      ],
    };

    const diff = diffOf(SETTLED, shrunk);

    expect(diff.permissions.deactivated).toEqual(['gatepass.dc.approve']);
    expect(diff.nav.deactivated).toEqual(['dc.approvals']);
    // The removed node keeps its gate: it is inert while inactive, and keeping
    // it is what makes a key that comes back come back gated as it was.
    expect(diff.menu_permissions.unmapped).toEqual([]);
  });

  it('treats a key that comes back as a reactivation, not a creation', () => {
    const withRetired: CurrentCatalog = {
      ...SETTLED,
      permissions: SETTLED.permissions.map((permission) =>
        permission.key === 'gatepass.dc.approve'
          ? { ...permission, is_active: false }
          : permission,
      ),
      navNodes: SETTLED.navNodes.map((node) =>
        node.key === 'dc.approvals' ? { ...node, is_active: false } : node,
      ),
    };

    const diff = diffOf(withRetired, MANIFEST);

    // The row, its uuid, and every `role_permission` and `menu_permission` that
    // references it are still there — re-creating would collide with the unique
    // index and would lose the grants besides.
    expect(diff.permissions.created).toEqual([]);
    expect(diff.permissions.updated).toEqual(['gatepass.dc.approve']);
    expect(diff.nav.created).toEqual([]);
    expect(diff.nav.updated).toEqual(['dc.approvals']);
  });

  it('maps and unmaps only the difference of a requires list', () => {
    const regated = manifestWith([
      moduleNode([createNode({ requires: ['gatepass.dc.approve'] }), approvalsNode()]),
    ]);

    const diff = diffOf(SETTLED, regated);

    expect(diff.menu_permissions.mapped).toEqual([
      { nav_key: 'dc.create', permission_keys: ['gatepass.dc.approve'] },
    ]);
    expect(diff.menu_permissions.unmapped).toEqual([
      { nav_key: 'dc.create', permission_keys: ['gatepass.dc.create'] },
    ]);
  });

  it('clears a description the manifest stopped carrying', () => {
    const described: CurrentCatalog = {
      ...SETTLED,
      application: { ...SETTLED.application, description: 'Old blurb' },
    };

    // A manifest is the declaration, not a patch: a field it no longer mentions
    // is a field the application no longer has — the same rule that
    // soft-deactivates a permission it stopped listing.
    expect(diffOf(described, MANIFEST).application.changed).toEqual(['description']);
  });

  it('names a rename of the application itself', () => {
    expect(diffOf(SETTLED, { ...MANIFEST, name: 'Gate Pass v2' }).application).toEqual({
      key: 'gatepass',
      changed: ['name'],
    });
  });
});
