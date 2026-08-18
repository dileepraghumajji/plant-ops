import type { ScopeNodeDTO } from '@plantops/contracts';

import {
  allScopeNodeIds,
  defaultChildKind,
  descendantIds,
  findScopeNode,
  flattenScopeTree,
  scopeTreeData,
  scopeTreeSize,
} from './scope-tree';

/**
 * A node, with the `path` the server would have built for it.
 *
 * Labels are `n_` + the id's UUID hex and never the display name (Doc 01 §3.5),
 * so the fixtures use `n_<id>` — enough for the prefix arithmetic
 * `descendantIds` performs, and a reminder that nothing here reads a name out of
 * a path.
 */
function node(
  overrides: Partial<ScopeNodeDTO> & Pick<ScopeNodeDTO, 'id' | 'name' | 'path'>,
): ScopeNodeDTO {
  return {
    client_id: 'c1',
    parent_id: null,
    kind: 'group',
    depth: overrides.path.split('.').length,
    metadata: {},
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    children: [],
    ...overrides,
  };
}

/** Acme → (Plant A → (Assembly, Gate 3), Plant B). */
const gate3 = node({
  id: 'g3',
  name: 'Gate 3',
  kind: 'gate',
  parent_id: 'pa',
  path: 'n_acme.n_pa.n_g3',
});
const assembly = node({
  id: 'as',
  name: 'Assembly',
  kind: 'department',
  parent_id: 'pa',
  path: 'n_acme.n_pa.n_as',
});
const plantA = node({
  id: 'pa',
  name: 'Plant A',
  kind: 'plant',
  parent_id: 'acme',
  path: 'n_acme.n_pa',
  children: [assembly, gate3],
});
const plantB = node({
  id: 'pb',
  name: 'Plant B',
  kind: 'plant',
  parent_id: 'acme',
  path: 'n_acme.n_pb',
});
const acme = node({
  id: 'acme',
  name: 'Acme',
  kind: 'group',
  path: 'n_acme',
  children: [plantA, plantB],
});
const tree: ScopeNodeDTO[] = [acme];

describe('walking a scope tree', () => {
  it('reads depth-first in display order', () => {
    expect(flattenScopeTree(tree).map((row) => row.node.id)).toEqual([
      'acme',
      'pa',
      'as',
      'g3',
      'pb',
    ]);
  });

  it('counts the level in the tree and carries the ancestor names', () => {
    const row = flattenScopeTree(tree).find((entry) => entry.node.id === 'g3');

    expect(row?.level).toBe(2);
    expect(row?.ancestorNames).toEqual(['Acme', 'Plant A']);
  });

  it('finds a node anywhere, not only at the top', () => {
    expect(findScopeNode(tree, 'as')?.name).toBe('Assembly');
    expect(findScopeNode(tree, 'nope')).toBeNull();
  });

  it('reports how big the tree is', () => {
    expect(scopeTreeSize(tree)).toEqual({ nodes: 5, depth: 3 });
  });

  it('reports an empty tree as empty rather than one level deep', () => {
    expect(scopeTreeSize([])).toEqual({ nodes: 0, depth: 0 });
  });

  it('lists every id, for an expand-all', () => {
    expect(allScopeNodeIds(tree)).toEqual(['acme', 'pa', 'as', 'g3', 'pb']);
  });
});

describe('the subtree a node may not move into', () => {
  it('includes the node itself — it cannot be its own parent either', () => {
    expect(descendantIds(tree, plantA).has('pa')).toBe(true);
  });

  it('includes everything beneath it', () => {
    expect([...descendantIds(tree, plantA)].sort()).toEqual(['as', 'g3', 'pa']);
  });

  it('does not catch a sibling whose path merely shares a prefix string', () => {
    // `n_pa` is a prefix of `n_pab` as a string but not as an ltree label, which
    // is why the match is on `path + '.'` rather than on `path`.
    const pab = node({
      id: 'pab',
      name: 'Plant AB',
      parent_id: 'acme',
      path: 'n_acme.n_pab',
    });
    const wider: ScopeNodeDTO[] = [{ ...acme, children: [plantA, pab] }];

    expect(descendantIds(wider, plantA).has('pab')).toBe(false);
  });

  it('is just the node for a leaf', () => {
    expect([...descendantIds(tree, gate3)]).toEqual(['g3']);
  });
});

describe('the antd tree data', () => {
  it('keys and values on the node id, so Tree and TreeSelect share one builder', () => {
    const [root] = scopeTreeData(tree);

    expect(root.key).toBe('acme');
    expect(root.value).toBe('acme');
    expect(root.title).toBe('Acme');
  });

  it('carries the node through, so a renderer need not look it up again', () => {
    expect(scopeTreeData(tree)[0].children[0].node.kind).toBe('plant');
  });

  it('selects everything when nothing is disabled', () => {
    const rows = scopeTreeData(tree);
    expect(rows[0].disabled).toBe(false);
    expect(rows[0].selectable).toBe(true);
  });

  it('greys a row out but keeps it in the tree', () => {
    // Hiding a branch would make the picker lie about the organisation, and the
    // node the operator can choose is often beneath one they cannot.
    const forbidden = descendantIds(tree, plantA);
    const rows = scopeTreeData(tree, { isDisabled: (n) => forbidden.has(n.id) });

    const renderedPlantA = rows[0].children[0];
    expect(renderedPlantA.disabled).toBe(true);
    expect(renderedPlantA.selectable).toBe(false);
    expect(renderedPlantA.children).toHaveLength(2);
    expect(rows[0].disabled).toBe(false);
  });
});

describe('the kind a new child most likely is', () => {
  it.each([
    ['group', 'plant'],
    ['plant', 'department'],
    ['department', 'gate'],
  ] as const)('suggests %s → %s', (parentKind, expected) => {
    expect(defaultChildKind({ ...plantA, kind: parentKind })).toBe(expected);
  });

  it('suggests a group for the tenant’s root', () => {
    expect(defaultChildKind(null)).toBe('group');
  });

  it('stops at gate rather than running off the end', () => {
    // A gate under a gate is unusual, not invalid — Doc 01 §3.5 pins no kind to
    // a depth, so the form suggests and the operator decides.
    expect(defaultChildKind(gate3)).toBe('gate');
  });
});
