import type { NavNodeDTO } from '@plantops/contracts';
import { fireEvent, render, screen } from '@testing-library/react';

import { NavMenu } from './nav-menu';

function node(partial: Partial<NavNodeDTO> & { id: string }): NavNodeDTO {
  return { kind: 'menu', key: partial.id, label: partial.id, children: [], ...partial };
}

const TREE: NavNodeDTO[] = [
  node({
    id: 'admin',
    kind: 'module',
    label: 'Administration',
    icon: 'shield',
    children: [
      node({ id: 'roles', label: 'Roles', route: '/admin/roles', icon: 'badge' }),
      node({ id: 'users', label: 'Users', route: '/admin/users', icon: 'users' }),
    ],
  }),
];

describe('<NavMenu>', () => {
  /**
   * The property Doc 05 §7 asks for: the sidebar is what the server sent, not a
   * menu constant filtered by a client-side permission check. A label that is
   * absent from the response must be absent from the DOM.
   */
  it('renders exactly the nodes in the response', async () => {
    render(<NavMenu tree={TREE} pathname="/admin/roles" onNavigate={() => undefined} />);

    expect(await screen.findByText('Administration')).toBeTruthy();
    expect(screen.getByText('Roles')).toBeTruthy();
    expect(screen.getByText('Users')).toBeTruthy();
    expect(screen.queryByText('Clients')).toBeNull();
  });

  it('renders an empty menu for a subject whose tree pruned to nothing', () => {
    const { container } = render(
      <NavMenu tree={[]} pathname="/" onNavigate={() => undefined} />,
    );
    expect(container.querySelectorAll('li').length).toBe(0);
  });

  it('reports the clicked node’s route, not its id', async () => {
    const onNavigate = jest.fn();
    render(<NavMenu tree={TREE} pathname="/admin/roles" onNavigate={onNavigate} />);

    fireEvent.click(await screen.findByText('Users'));

    expect(onNavigate).toHaveBeenCalledWith('/admin/users');
  });

  /**
   * The tree arrives asynchronously, so the first render of a deep link has
   * nothing in it. The sub-menu around the highlighted row has to open when the
   * response lands, not only when the URL next changes.
   */
  it('opens the sub-menu around a deep link once the tree arrives', async () => {
    const nested: NavNodeDTO[] = [
      node({
        id: 'admin',
        kind: 'module',
        label: 'Administration',
        children: [
          node({
            id: 'users',
            label: 'Users',
            children: [
              node({
                id: 'by-role',
                kind: 'sub_menu',
                label: 'Users by Role',
                route: '/admin/users/by-role',
              }),
            ],
          }),
        ],
      }),
    ];

    const { rerender } = render(
      <NavMenu tree={[]} pathname="/admin/users/by-role" onNavigate={() => undefined} />,
    );
    rerender(
      <NavMenu
        tree={nested}
        pathname="/admin/users/by-role"
        onNavigate={() => undefined}
      />,
    );

    expect(await screen.findByText('Users by Role')).toBeTruthy();
  });

  it('tolerates an icon key it has never heard of', async () => {
    // Icons are catalog data (Doc 02 §8): an admin can type anything into a
    // manifest, and the menu still has to render.
    const tree = [node({ id: 'x', label: 'Forklifts', route: '/x', icon: 'forklift' })];
    render(<NavMenu tree={tree} pathname="/x" onNavigate={() => undefined} />);

    expect(await screen.findByText('Forklifts')).toBeTruthy();
  });
});
