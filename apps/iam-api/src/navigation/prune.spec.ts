/**
 * The pruning matrix — Doc 05 §3 and §5, case by case.
 *
 * This is the suite the session's Definition of Done names, and the reason it
 * carries the weight is the direction each mistake fails in. A menu that hides
 * something a subject may use is a support ticket; a menu that *shows* something
 * they may not is Invariant I3 broken, and the only artefact of it is a screen a
 * user was told about and cannot open. Doc 05 §3 rule 1 records that the rule
 * here was deliberately inverted at some point — "this inverts the previous
 * 'unmapped = public' rule, which was a silent-access footgun" — so the cases
 * below pin the direction rather than merely the behaviour.
 *
 * No Nest, no database, no HTTP: {@link pruneNavTree} is a pure function of a
 * catalog and a set of keys, and every claim Doc 05 §5 makes about it is decidable
 * from plain values. The parts that need infrastructure — enablement, the version
 * cache, the resolve — are `navigation.integration.spec.ts`.
 */

import { NavNodeKind, type NavNodeDTO } from '@plantops/contracts';
import { pruneNavTree, type NavCatalog, type NavCatalogNode } from './prune';

/**
 * A node whose id *is* its key, so a failure names the node it is about.
 *
 * Legal because pruning never interprets either field — it indexes on `id` and
 * copies `key` through — and it makes `parent_id: 'ops'` read as the tree it
 * describes.
 */
function node(key: string, over: Partial<NavCatalogNode> = {}): NavCatalogNode {
  return {
    id: key,
    parent_id: null,
    kind: NavNodeKind.MENU,
    key,
    label: key.toUpperCase(),
    route: `/${key}`,
    icon: null,
    is_public: false,
    ...over,
  };
}

const catalog = (
  nodes: readonly NavCatalogNode[],
  gates: Record<string, readonly string[]> = {},
): NavCatalog => ({ nodes, gates });

const held = (...keys: string[]): ReadonlySet<string> => new Set(keys);

/** `[key, [childKey, …]]` for every visible node — the shape of the answer. */
function shape(tree: readonly NavNodeDTO[]): unknown[] {
  return tree.map((node) =>
    node.children.length === 0 ? node.key : [node.key, shape(node.children)],
  );
}

describe('pruneNavTree (Doc 05 §5)', () => {
  it('returns nothing for an empty catalog', () => {
    expect(pruneNavTree(catalog([]), held('anything'))).toEqual([]);
  });

  // ── the leaf rule (Doc 05 §3 rule 1) ──────────────────────────────────────

  describe('a leaf', () => {
    it('is visible when the subject holds its mapped permission', () => {
      const tree = pruneNavTree(
        catalog([node('dc')], { dc: ['gatepass.dc.read'] }),
        held('gatepass.dc.read'),
      );

      expect(shape(tree)).toEqual(['dc']);
    });

    it('is hidden when the subject holds none of its mapped permissions', () => {
      const tree = pruneNavTree(
        catalog([node('dc')], { dc: ['gatepass.dc.read'] }),
        held('gatepass.other.read'),
      );

      expect(tree).toEqual([]);
    });

    it('needs only one of several mapped permissions — OR, not AND', () => {
      const nodes = [node('dc')];
      const gates = { dc: ['gatepass.dc.read', 'gatepass.dc.approve'] };

      expect(shape(pruneNavTree(catalog(nodes, gates), held('gatepass.dc.read')))).toEqual([
        'dc',
      ]);
      expect(
        shape(pruneNavTree(catalog(nodes, gates), held('gatepass.dc.approve'))),
      ).toEqual(['dc']);
      // …and still nothing when neither is held.
      expect(pruneNavTree(catalog(nodes, gates), held('gatepass.dc.void'))).toEqual([]);
    });

    it('is hidden when unmapped — an unmapped menu is a gap, not a grant', () => {
      // Invariant I3. The subject holds a great deal and still cannot see a node
      // nobody gated: what makes an item visible is a mapping they satisfy, never
      // the absence of one.
      const tree = pruneNavTree(
        catalog([node('orphan')]),
        held('gatepass.dc.read', 'gatepass.dc.approve'),
      );

      expect(tree).toEqual([]);
    });

    it('is visible when unmapped and explicitly public', () => {
      // Doc 05 §3 rule 1's opt-in — "use `is_public` sparingly (e.g. an app
      // landing page)". Note the subject holds *nothing*: this is the one path by
      // which a node reaches a subject with no grants at all.
      const tree = pruneNavTree(
        catalog([node('landing', { is_public: true })]),
        held(),
      );

      expect(shape(tree)).toEqual(['landing']);
    });

    it('stays hidden when it is public *and* mapped but the gate is unheld', () => {
      // The half of rule 1 that is easy to get wrong. `is_public` rescues a leaf
      // with **no** mapping; a mapping is the operator's statement that the item
      // is gated, and a flag set years earlier must not quietly override it.
      const tree = pruneNavTree(
        catalog([node('reports', { is_public: true })], { reports: ['gatepass.report.read'] }),
        held('gatepass.dc.read'),
      );

      expect(tree).toEqual([]);
    });

    it('is visible when it is public and mapped and the gate *is* held', () => {
      const tree = pruneNavTree(
        catalog([node('reports', { is_public: true })], { reports: ['gatepass.report.read'] }),
        held('gatepass.report.read'),
      );

      expect(shape(tree)).toEqual(['reports']);
    });
  });

  // ── the container rule (Doc 05 §3 rule 2) ─────────────────────────────────

  describe('a container', () => {
    const module = (over: Partial<NavCatalogNode> = {}) =>
      node('ops', { kind: NavNodeKind.MODULE, route: null, ...over });

    const nodes = [
      module(),
      node('ops.dc', { parent_id: 'ops' }),
      node('ops.gate', { parent_id: 'ops' }),
    ];
    const gates = {
      'ops.dc': ['gatepass.dc.read'],
      'ops.gate': ['gatepass.gate.read'],
    };

    it('survives on one visible descendant and carries only that one', () => {
      const tree = pruneNavTree(catalog(nodes, gates), held('gatepass.dc.read'));

      expect(shape(tree)).toEqual([['ops', ['ops.dc']]]);
    });

    it('is pruned when no descendant is visible', () => {
      expect(pruneNavTree(catalog(nodes, gates), held('gatepass.other.read'))).toEqual(
        [],
      );
    });

    it('never consults its own gate', () => {
      // Doc 05 §5 branches on "has children" before it reads a gate, so a mapping
      // on a container is inert. The subject below holds nothing the module
      // requires and sees it anyway, because its child is visible — which is the
      // whole of rule 2 and the reason a container's own mapping is not a second,
      // stricter gate on its subtree.
      const tree = pruneNavTree(
        catalog(nodes, { ...gates, ops: ['gatepass.admin'] }),
        held('gatepass.dc.read'),
      );

      expect(shape(tree)).toEqual([['ops', ['ops.dc']]]);
    });

    it('is pruned when empty even with a route and a satisfied gate', () => {
      // The same clause read the other way. A node with children is a container
      // whatever else it carries, and an empty container is a dead end — so
      // `route` and a held mapping do not save it. Doc 05 §3 assumes routes and
      // children are disjoint; this is what the schema permits and §5 decides.
      const tree = pruneNavTree(
        catalog(
          [module({ route: '/ops' }), node('ops.dc', { parent_id: 'ops' })],
          { ops: ['gatepass.admin'], 'ops.dc': ['gatepass.dc.read'] },
        ),
        held('gatepass.admin'),
      );

      expect(tree).toEqual([]);
    });

    it('prunes bottom-up through three levels', () => {
      // Module → menu → sub-menu, the full depth of Doc 01 §3.3. The `users`
      // menu keeps only the sub-menu whose permission is held, and the `roles`
      // menu disappears entirely, taking nothing else with it.
      const tree = pruneNavTree(
        catalog(
          [
            node('admin', { kind: NavNodeKind.MODULE, route: null }),
            node('admin.users', { parent_id: 'admin', route: null }),
            node('admin.users.list', {
              parent_id: 'admin.users',
              kind: NavNodeKind.SUB_MENU,
            }),
            node('admin.users.bulk', {
              parent_id: 'admin.users',
              kind: NavNodeKind.SUB_MENU,
            }),
            node('admin.roles', { parent_id: 'admin' }),
          ],
          {
            'admin.users.list': ['iam.client.user.read'],
            'admin.users.bulk': ['iam.client.user.bulk_upload'],
            'admin.roles': ['iam.client.role.read'],
          },
        ),
        held('iam.client.user.read'),
      );

      expect(shape(tree)).toEqual([['admin', [['admin.users', ['admin.users.list']]]]]);
    });
  });

  // ── ordering (Doc 05 §3 rule 4) ───────────────────────────────────────────

  it('keeps siblings in catalog order at every level', () => {
    // The catalog arrives ordered by `(sort_order, key)` and children are
    // appended in that order, so nothing here sorts anything — which is exactly
    // what this asserts: the nodes are handed over deliberately out of key order,
    // and they come back the way they went in.
    const tree = pruneNavTree(
      catalog(
        [
          node('zulu', { kind: NavNodeKind.MODULE, route: null }),
          node('zulu.second', { parent_id: 'zulu' }),
          node('zulu.first', { parent_id: 'zulu' }),
          node('alpha', { kind: NavNodeKind.MODULE, route: null }),
          node('alpha.only', { parent_id: 'alpha' }),
        ],
        {
          'zulu.second': ['p'],
          'zulu.first': ['p'],
          'alpha.only': ['p'],
        },
      ),
      held('p'),
    );

    expect(shape(tree)).toEqual([
      ['zulu', ['zulu.second', 'zulu.first']],
      ['alpha', ['alpha.only']],
    ]);
  });

  // ── what an inactive node leaves behind ───────────────────────────────────

  it('drops a subtree whose parent is absent rather than promoting it', () => {
    // Inactive nodes never reach a catalog (Doc 05 §3 rule 4), so a deactivated
    // module shows up here as children whose `parent_id` matches nothing.
    // Promoting them to the top level — which `registry/nav.service.ts`'s
    // `assemble()` deliberately does for the admin's full catalog — would put the
    // menus of a retired module at the root of the sidebar, revealing precisely
    // what the operator switched off.
    const tree = pruneNavTree(
      catalog(
        [
          node('kept', { kind: NavNodeKind.MODULE, route: null }),
          node('kept.child', { parent_id: 'kept' }),
          node('retired.child', { parent_id: 'retired-module' }),
        ],
        { 'kept.child': ['p'], 'retired.child': ['p'] },
      ),
      held('p'),
    );

    expect(shape(tree)).toEqual([['kept', ['kept.child']]]);
  });

  it('terminates on a parent cycle instead of recursing into it', () => {
    // Not reachable through the API — nav parents are named upwards — but the
    // walk starts from `parent_id === null` and a cycle contains no such node, so
    // it is skipped rather than followed forever. Asserted because "it cannot
    // happen" is a poor reason for a resolver on the request path to be able to
    // hang.
    const tree = pruneNavTree(
      catalog(
        [
          node('root', { kind: NavNodeKind.MODULE, route: null }),
          node('root.leaf', { parent_id: 'root' }),
          node('a', { parent_id: 'b' }),
          node('b', { parent_id: 'a' }),
        ],
        { 'root.leaf': ['p'], a: ['p'], b: ['p'] },
      ),
      held('p'),
    );

    expect(shape(tree)).toEqual([['root', ['root.leaf']]]);
  });

  // ── what the answer does not carry ────────────────────────────────────────

  it('reports no gates, flags or ordering on the nodes it returns', () => {
    // A client that received `requires` could enumerate the permissions it does
    // *not* hold from the items it cannot see, which is more than a menu has any
    // business telling it. `NavNodeCatalogDTO` is the shape that carries all of
    // that, and it is the platform admin's, on a different route.
    const [visible] = pruneNavTree(
      catalog([node('dc', { icon: 'truck', is_public: true })], { dc: ['p'] }),
      held('p'),
    );

    expect(visible).toEqual({
      id: 'dc',
      kind: NavNodeKind.MENU,
      key: 'dc',
      label: 'DC',
      route: '/dc',
      icon: 'truck',
      children: [],
    });
  });

  it('is empty for a subject with no grants and no public nodes', () => {
    // Deny-by-default, and by the absence of a special case: nothing in
    // `prune.ts` branches on "this subject holds nothing".
    const tree = pruneNavTree(
      catalog(
        [
          node('ops', { kind: NavNodeKind.MODULE, route: null }),
          node('ops.dc', { parent_id: 'ops' }),
        ],
        { 'ops.dc': ['p'] },
      ),
      held(),
    );

    expect(tree).toEqual([]);
  });
});
