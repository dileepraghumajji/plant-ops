'use client';

/**
 * The sidebar menu — a pure render of `GET /iam/navigation` (Doc 05 §7).
 *
 * The component holds no route table, no permission check and no idea which
 * console it is in. It is handed a tree and a pathname and produces an antd
 * `Menu`; if a node is in the tree the subject may see it, because the server
 * already pruned everything they may not (Doc 05 §3). That is the whole
 * contract, and it is what makes one component serve the platform console, the
 * client console, and the gatepass and visitor consoles that follow.
 *
 * Navigation is a callback rather than a `next/link`: this library stays free
 * of a router so that a console built on something other than the Next app
 * router — or a Storybook page, or a test — can mount it unchanged.
 */

import type { NavNodeDTO } from '@plantops/contracts';
import { Menu, type MenuProps } from 'antd';
import * as React from 'react';

import { NavIcon } from '../icons/icon-registry';
import { navSelectionForPath } from './nav-tree';

type MenuItem = Required<MenuProps>['items'][number];

export interface NavMenuProps {
  /** The `tree` field of the navigation response, rendered as-is. */
  tree: readonly NavNodeDTO[];
  /** Current location, for selection and sub-menu expansion. */
  pathname: string;
  /** Called with a node's `route` when the user picks a row. */
  onNavigate: (route: string) => void;
  /** Dark in both colour modes — see `tokens.ts`. */
  theme?: 'dark' | 'light';
  /** Collapsed rail: antd renders icons only and pops sub-menus out. */
  collapsed?: boolean;
}

/**
 * Builds antd's item tree, keyed by node id.
 *
 * Ids rather than the catalog `key` because the cross-application shell
 * (Doc 05 §4, `GET /iam/navigation` with no `applicationId`) concatenates trees
 * from several applications, and catalog keys are only unique *within* an
 * application — two apps may each legitimately have a `settings` node.
 */
function toMenuItems(nodes: readonly NavNodeDTO[]): MenuItem[] {
  return nodes.map((node): MenuItem => {
    const icon =
      node.icon === null || node.icon === undefined ? undefined : (
        <NavIcon iconKey={node.icon} />
      );

    if (node.children.length > 0) {
      return {
        key: node.id,
        icon,
        label: node.label,
        children: toMenuItems(node.children),
      };
    }

    return { key: node.id, icon, label: node.label };
  });
}

export function NavMenu({
  tree,
  pathname,
  onNavigate,
  theme = 'dark',
  collapsed = false,
}: NavMenuProps): React.ReactElement {
  const items = React.useMemo(() => toMenuItems(tree), [tree]);
  const selection = React.useMemo(
    () => navSelectionForPath(tree, pathname),
    [tree, pathname],
  );

  /**
   * Which sub-menus are open.
   *
   * Seeded from the location and then owned by the user: re-deriving it on
   * every render would slam a sub-menu shut the moment someone opened it to
   * look at a sibling section. It *is* re-seeded when the location changes, so
   * that a deep link or a back-button navigation reveals its own row.
   */
  const [openKeys, setOpenKeys] = React.useState<string[]>(selection.openKeys);

  // Keyed on the *derived* open keys rather than on the pathname alone. The
  // tree arrives asynchronously, so a deep link into a sub-menu renders once
  // with an empty tree — and a pathname-keyed seed would conclude it had
  // already seeded for that URL and leave the sub-menu shut around the
  // highlighted row.
  const seedKey = `${pathname}|${selection.openKeys.join(',')}`;
  const seededFor = React.useRef(seedKey);
  if (seededFor.current !== seedKey) {
    seededFor.current = seedKey;
    // Union, not replacement: navigating within an open section should not
    // collapse the other sections the user deliberately opened.
    const merged = [...new Set([...openKeys, ...selection.openKeys])];
    if (merged.length !== openKeys.length) setOpenKeys(merged);
  }

  const routeById = React.useMemo(() => {
    const map = new Map<string, string>();
    const walk = (nodes: readonly NavNodeDTO[]): void => {
      for (const node of nodes) {
        if (typeof node.route === 'string' && node.route.trim() !== '') {
          map.set(node.id, node.route);
        }
        walk(node.children);
      }
    };
    walk(tree);
    return map;
  }, [tree]);

  const handleClick = React.useCallback<NonNullable<MenuProps['onClick']>>(
    ({ key }) => {
      const route = routeById.get(String(key));
      if (route !== undefined) onNavigate(route);
    },
    [routeById, onNavigate],
  );

  return (
    <Menu
      mode="inline"
      theme={theme}
      items={items}
      selectedKeys={selection.selectedKeys}
      // antd manages flyouts itself when collapsed; forcing openKeys then
      // leaves sub-menus stuck open behind the rail.
      {...(collapsed ? {} : { openKeys, onOpenChange: (keys) => setOpenKeys(keys as string[]) })}
      onClick={handleClick}
      inlineIndent={16}
      style={{ borderInlineEnd: 'none', background: 'transparent' }}
    />
  );
}
