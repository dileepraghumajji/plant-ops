import type { NavNodeDTO } from '@plantops/contracts';

import {
  findNavRouteForPath,
  firstNavRoute,
  flattenNavRoutes,
  navContainerIds,
  navSelectionForPath,
} from './nav-tree';

/** Builds a node without repeating the fields a test does not care about. */
function node(partial: Partial<NavNodeDTO> & { id: string }): NavNodeDTO {
  return {
    kind: 'menu',
    key: partial.id,
    label: partial.id,
    children: [],
    ...partial,
  };
}

/**
 * A pruned response shaped like the IAM's own manifest: a container with leaves,
 * and a nested sub-menu whose route is a prefix-sibling of one of them.
 */
const TREE: NavNodeDTO[] = [
  node({
    id: 'platform',
    kind: 'module',
    children: [
      node({ id: 'apps', route: '/platform/applications' }),
      node({ id: 'clients', route: '/platform/clients' }),
    ],
  }),
  node({
    id: 'admin',
    kind: 'module',
    children: [
      node({ id: 'scopes', route: '/admin/scopes' }),
      node({
        id: 'users',
        children: [
          node({ id: 'users-list', kind: 'sub_menu', route: '/admin/users' }),
          node({ id: 'users-by-role', kind: 'sub_menu', route: '/admin/users/by-role' }),
        ],
      }),
    ],
  }),
];

describe('flattenNavRoutes', () => {
  it('returns routable nodes in display order, skipping containers', () => {
    expect(flattenNavRoutes(TREE).map((entry) => entry.route)).toEqual([
      '/platform/applications',
      '/platform/clients',
      '/admin/scopes',
      '/admin/users',
      '/admin/users/by-role',
    ]);
  });

  it('records the container ids that lead to each leaf', () => {
    const byRole = flattenNavRoutes(TREE).find(
      (entry) => entry.route === '/admin/users/by-role',
    );
    expect(byRole?.ancestorIds).toEqual(['admin', 'users']);
  });

  it('treats a blank route as no route — a container is not a destination', () => {
    const tree = [node({ id: 'container', route: '   ', children: [] })];
    expect(flattenNavRoutes(tree)).toEqual([]);
  });
});

describe('firstNavRoute', () => {
  it('is the first screen the subject may see, in menu order', () => {
    expect(firstNavRoute(TREE)).toBe('/platform/applications');
  });

  it('is null for a subject whose menu pruned to nothing', () => {
    // Doc 05 §3: a subject holding no mapped permission gets an empty tree.
    // The caller has to say so rather than redirect somewhere.
    expect(firstNavRoute([])).toBeNull();
  });
});

describe('findNavRouteForPath', () => {
  it('matches a menu row exactly', () => {
    expect(findNavRouteForPath(TREE, '/admin/scopes')?.node.id).toBe('scopes');
  });

  it('matches a detail screen to the list it belongs to', () => {
    // /admin/users/8f2c… is not in the menu; Users must still light up.
    expect(findNavRouteForPath(TREE, '/admin/users/8f2c1d')?.node.id).toBe('users-list');
  });

  it('prefers the longest matching route over a shorter sibling prefix', () => {
    expect(findNavRouteForPath(TREE, '/admin/users/by-role')?.node.id).toBe(
      'users-by-role',
    );
  });

  it('does not match across a partial path segment', () => {
    // '/admin/users-archive' starts with '/admin/users' as a *string* but is a
    // different screen; highlighting Users there would be a lie.
    expect(findNavRouteForPath(TREE, '/admin/users-archive')).toBeNull();
  });

  it('ignores a trailing slash on either side', () => {
    expect(findNavRouteForPath(TREE, '/admin/scopes/')?.node.id).toBe('scopes');
  });

  it('is null for a path the menu does not contain', () => {
    expect(findNavRouteForPath(TREE, '/account/settings')).toBeNull();
  });
});

describe('navSelectionForPath', () => {
  it('selects the row and opens every sub-menu above it', () => {
    expect(navSelectionForPath(TREE, '/admin/users/by-role')).toEqual({
      selectedKeys: ['users-by-role'],
      openKeys: ['admin', 'users'],
    });
  });

  it('selects nothing when the path is outside the menu', () => {
    expect(navSelectionForPath(TREE, '/nowhere')).toEqual({
      selectedKeys: [],
      openKeys: [],
    });
  });
});

describe('navContainerIds', () => {
  it('lists every expandable node, at any depth', () => {
    expect(navContainerIds(TREE)).toEqual(['platform', 'admin', 'users']);
  });
});
