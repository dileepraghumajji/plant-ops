'use client';

/**
 * The sidebar: the brand, and the menu the API said this subject may see.
 *
 * The whole component is thirty lines because that is the point of Doc 05. The
 * console holds no menu constants; it fetches `/iam/navigation`, hands the tree
 * to `<NavMenu>`, and routes on the `route` a node carries. A platform admin and
 * a client admin therefore get visibly different consoles from the same build,
 * and a platform admin adding a menu in the catalog sees it here on the next
 * load — no deploy, no restart, no code change (Doc 05 §1).
 *
 * The three states below are all real. A subject with no grants gets an empty
 * tree (Doc 05 §3 prunes unmapped nodes rather than exposing them), and saying
 * so plainly beats an empty rail that looks like a failed request.
 */

import { NavIcon, NavMenu } from '@plantops/ui';
import { useNavigation } from '@plantops/web-kit';
import { Skeleton, Typography } from 'antd';
import { usePathname, useRouter } from 'next/navigation';
import { useCallback, type ReactElement } from 'react';

export function Sidebar({ collapsed }: { collapsed: boolean }): ReactElement {
  const router = useRouter();
  const pathname = usePathname();
  const { tree, loading, error } = useNavigation();

  const onNavigate = useCallback(
    (route: string) => {
      router.push(route);
    },
    [router],
  );

  if (loading && tree.length === 0) {
    return (
      <div style={{ padding: 16 }}>
        <Skeleton active paragraph={{ rows: 5 }} title={false} />
      </div>
    );
  }

  if (error !== null && tree.length === 0) {
    return <SidebarNotice collapsed={collapsed} text="Menu unavailable" />;
  }

  if (tree.length === 0) {
    // Not a bug: deny-by-default means a subject with no bindings has no menu.
    // The screens are still reachable by URL and the server still refuses them.
    return <SidebarNotice collapsed={collapsed} text="No screens granted" />;
  }

  return (
    <NavMenu
      tree={tree}
      pathname={pathname}
      onNavigate={onNavigate}
      collapsed={collapsed}
    />
  );
}

function SidebarNotice({
  collapsed,
  text,
}: {
  collapsed: boolean;
  text: string;
}): ReactElement {
  return (
    <div
      style={{
        padding: collapsed ? 12 : 16,
        display: 'flex',
        alignItems: 'center',
        justifyContent: collapsed ? 'center' : 'flex-start',
        gap: 8,
        color: '#B7C2C6',
      }}
      title={text}
    >
      <NavIcon iconKey="warning" />
      {!collapsed && (
        <Typography.Text style={{ color: 'inherit', fontSize: 12 }}>
          {text}
        </Typography.Text>
      )}
    </div>
  );
}
