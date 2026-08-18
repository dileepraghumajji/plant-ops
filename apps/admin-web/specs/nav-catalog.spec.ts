import type { NavNodeCatalogDTO } from '@plantops/contracts';
import { NavNodeKind } from '@plantops/contracts';

import {
  defaultKindUnder,
  findCatalogNode,
  flattenCatalog,
  isNoOpChange,
  mappingChange,
  nextSortOrder,
  reachabilityOf,
  siblingsOf,
} from '../src/lib/nav-catalog';

function node(
  overrides: Partial<NavNodeCatalogDTO> & Pick<NavNodeCatalogDTO, 'id' | 'key'>,
): NavNodeCatalogDTO {
  return {
    application_id: 'app-1',
    parent_id: null,
    kind: NavNodeKind.MENU,
    label: overrides.key,
    route: null,
    icon: null,
    sort_order: 0,
    is_active: true,
    is_public: false,
    requires: [],
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    children: [],
    ...overrides,
  };
}

/** module → (menu → sub_menu), plus a second module. */
const tree: NavNodeCatalogDTO[] = [
  node({
    id: 'm1',
    key: 'access',
    kind: NavNodeKind.MODULE,
    label: 'Access',
    sort_order: 0,
    children: [
      node({
        id: 'n1',
        key: 'access.users',
        parent_id: 'm1',
        label: 'Users',
        route: '/admin/users',
        sort_order: 10,
        requires: ['iam.client.user.read'],
        children: [
          node({
            id: 'n2',
            key: 'access.users.bulk',
            parent_id: 'n1',
            kind: NavNodeKind.SUB_MENU,
            label: 'Bulk upload',
            route: '/admin/users/bulk',
            sort_order: 20,
          }),
        ],
      }),
    ],
  }),
  node({ id: 'm2', key: 'audit', kind: NavNodeKind.MODULE, label: 'Audit', sort_order: 10 }),
];

describe('flattenCatalog', () => {
  it('walks depth-first in display order', () => {
    expect(flattenCatalog(tree).map((row) => row.node.id)).toEqual([
      'm1',
      'n1',
      'n2',
      'm2',
    ]);
  });

  it('reports the depth a table indents by', () => {
    const depths = Object.fromEntries(
      flattenCatalog(tree).map((row) => [row.node.id, row.depth]),
    );
    expect(depths).toEqual({ m1: 0, n1: 1, n2: 2, m2: 0 });
  });

  it("carries the ancestors' labels, outermost first", () => {
    const bulk = flattenCatalog(tree).find((row) => row.node.id === 'n2');
    expect(bulk?.ancestorLabels).toEqual(['Access', 'Users']);
  });

  it('is empty for an empty tree', () => {
    expect(flattenCatalog([])).toEqual([]);
  });
});

describe('findCatalogNode', () => {
  it('finds a node nested two levels down', () => {
    expect(findCatalogNode(tree, 'n2')?.key).toBe('access.users.bulk');
  });

  it('is null for an id that is not there', () => {
    expect(findCatalogNode(tree, 'nope')).toBeNull();
  });
});

describe('defaultKindUnder', () => {
  it('suggests a module at the top level', () => {
    expect(defaultKindUnder(null)).toBe(NavNodeKind.MODULE);
  });

  it('suggests a menu under a module', () => {
    expect(defaultKindUnder(findCatalogNode(tree, 'm1'))).toBe(NavNodeKind.MENU);
  });

  it('suggests a sub-menu under a menu', () => {
    expect(defaultKindUnder(findCatalogNode(tree, 'n1'))).toBe(NavNodeKind.SUB_MENU);
  });

  it('keeps suggesting a sub-menu below one', () => {
    // The kinds are a three-level vocabulary; below a sub-menu there is nothing
    // deeper to suggest, and the form lets the operator disagree anyway.
    expect(defaultKindUnder(findCatalogNode(tree, 'n2'))).toBe(NavNodeKind.SUB_MENU);
  });
});

describe('siblingsOf and nextSortOrder', () => {
  it('treats the top level as the children of null', () => {
    expect(siblingsOf(tree, null).map((n) => n.id)).toEqual(['m1', 'm2']);
  });

  it("returns a node's children", () => {
    expect(siblingsOf(tree, 'm1').map((n) => n.id)).toEqual(['n1']);
  });

  it('is empty for an unknown parent', () => {
    expect(siblingsOf(tree, 'nope')).toEqual([]);
  });

  it('leaves room after the last sibling', () => {
    expect(nextSortOrder(siblingsOf(tree, null))).toBe(20);
  });

  it('starts at zero when there are no siblings', () => {
    expect(nextSortOrder([])).toBe(0);
  });
});

describe('mappingChange', () => {
  it('is empty when nothing moved', () => {
    const change = mappingChange(['a', 'b'], ['b', 'a']);
    expect(change).toEqual({ map: [], unmap: [] });
    expect(isNoOpChange(change)).toBe(true);
  });

  it('separates the additions from the removals', () => {
    expect(mappingChange(['a', 'b'], ['b', 'c'])).toEqual({
      map: ['c'],
      unmap: ['a'],
    });
  });

  it('unmaps everything when the selection is cleared', () => {
    expect(mappingChange(['a', 'b'], [])).toEqual({ map: [], unmap: ['a', 'b'] });
  });

  it('maps everything for a node that had nothing', () => {
    expect(mappingChange([], ['b', 'a'])).toEqual({ map: ['a', 'b'], unmap: [] });
  });

  it('ignores a duplicate in the selection', () => {
    expect(mappingChange([], ['a', 'a'])).toEqual({ map: ['a'], unmap: [] });
  });
});

describe('reachabilityOf', () => {
  it('calls a node with children a container', () => {
    // Doc 05 §3: a container is shown when a descendant is, so it is not the
    // thing a mapping applies to.
    const module = findCatalogNode(tree, 'm1');
    expect(module).not.toBeNull();
    expect(reachabilityOf(module as NavNodeCatalogDTO)).toBe('container');
  });

  it('calls a mapped leaf gated', () => {
    expect(reachabilityOf(node({ id: 'x', key: 'x', requires: ['p'] }))).toBe('gated');
  });

  it('calls an unmapped public leaf public', () => {
    expect(reachabilityOf(node({ id: 'x', key: 'x', is_public: true }))).toBe('public');
  });

  it('calls an unmapped private leaf unreachable', () => {
    // The state the mapping tab exists to make visible: built correctly, gated
    // by nothing, and therefore invisible to everyone including its author.
    expect(reachabilityOf(node({ id: 'x', key: 'x' }))).toBe('unreachable');
  });

  it('prefers gated over public when a public node is also mapped', () => {
    expect(
      reachabilityOf(node({ id: 'x', key: 'x', is_public: true, requires: ['p'] })),
    ).toBe('gated');
  });
});
