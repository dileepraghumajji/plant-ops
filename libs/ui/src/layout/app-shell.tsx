'use client';

/**
 * The console frame: sidebar, header, content.
 *
 * Every authenticated screen in every PlantOps console renders inside one of
 * these. It owns the chrome — the collapse state, the fixed header, the
 * scrolling content region — and nothing else: what goes in the sidebar is a
 * `nav` node, what goes in the header's right side is `headerRight`. That keeps
 * the frame free of any knowledge of navigation, permissions or identity, which
 * is what lets the gatepass and visitor consoles reuse it without inheriting
 * the IAM's ideas about menus.
 *
 * ## Layout mechanics worth knowing
 *
 * The sidebar is `position: fixed` and the content region carries a matching
 * inline offset. The alternative — a flex row with an overflowing child — makes
 * the *page* scroll, which detaches the header from the viewport and puts the
 * table header out of reach on a long user list. Fixed chrome plus one
 * scrolling region is the behaviour an admin console needs.
 */

import { MenuFoldOutlined, MenuUnfoldOutlined } from '@ant-design/icons';
import { Button, Grid, Layout } from 'antd';
import * as React from 'react';

import { layout as layoutTokens, navSurface, spacing } from '../theme/tokens';

const { Header, Sider, Content } = Layout;

export interface AppShellProps {
  /** Usually a `<Brand>`. Rendered at the top of the sidebar. */
  brand?: React.ReactNode;
  /** Usually a `<NavMenu>`. Receives the collapsed state via `renderNav`. */
  nav?: React.ReactNode;
  /** Use instead of `nav` when the menu needs to know it is collapsed. */
  renderNav?: (state: { collapsed: boolean }) => React.ReactNode;
  /** Pinned to the bottom of the sidebar — a version string, a support link. */
  navFooter?: React.ReactNode;
  /** Left of the header, after the collapse toggle — breadcrumbs, a title. */
  headerLeft?: React.ReactNode;
  /** Right of the header — usually a `<UserMenu>`. */
  headerRight?: React.ReactNode;
  children: React.ReactNode;
  /** Controlled collapse. Omit to let the shell manage it. */
  collapsed?: boolean;
  onCollapsedChange?: (collapsed: boolean) => void;
}

export function AppShell({
  brand,
  nav,
  renderNav,
  navFooter,
  headerLeft,
  headerRight,
  children,
  collapsed,
  onCollapsedChange,
}: AppShellProps): React.ReactElement {
  const screens = Grid.useBreakpoint();
  const [selfCollapsed, setSelfCollapsed] = React.useState(false);
  const isControlled = collapsed !== undefined;
  const effectiveCollapsed = isControlled ? collapsed : selfCollapsed;

  const setCollapsed = React.useCallback(
    (next: boolean) => {
      if (!isControlled) setSelfCollapsed(next);
      onCollapsedChange?.(next);
    },
    [isControlled, onCollapsedChange],
  );

  // Below `lg` there is not enough width for a 248px rail and a usable table,
  // so the sidebar collapses to icons. Deliberately not a drawer: an operator
  // switching between Users and Access all morning should not have to open a
  // panel each time.
  const isNarrow = screens.lg === false;
  React.useEffect(() => {
    if (isNarrow) setCollapsed(true);
  }, [isNarrow, setCollapsed]);

  const siderWidth = effectiveCollapsed
    ? layoutTokens.sidebarCollapsedWidth
    : layoutTokens.sidebarWidth;

  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Sider
        collapsible
        collapsed={effectiveCollapsed}
        onCollapse={setCollapsed}
        trigger={null}
        width={layoutTokens.sidebarWidth}
        collapsedWidth={layoutTokens.sidebarCollapsedWidth}
        style={{
          position: 'fixed',
          insetBlock: 0,
          insetInlineStart: 0,
          zIndex: 20,
          display: 'flex',
          flexDirection: 'column',
          borderInlineEnd: `1px solid ${navSurface.border}`,
        }}
      >
        {brand}
        <div
          style={{
            flex: 1,
            minHeight: 0,
            overflowY: 'auto',
            overflowX: 'hidden',
            paddingBlock: spacing.xs,
          }}
        >
          {renderNav === undefined ? nav : renderNav({ collapsed: effectiveCollapsed })}
        </div>
        {navFooter !== undefined && (
          <div
            style={{
              padding: spacing.sm,
              borderBlockStart: `1px solid ${navSurface.border}`,
              color: navSurface.text,
              fontSize: 12,
            }}
          >
            {navFooter}
          </div>
        )}
      </Sider>

      <Layout
        style={{
          marginInlineStart: siderWidth,
          transition: 'margin-inline-start 0.2s',
        }}
      >
        <Header
          style={{
            position: 'sticky',
            top: 0,
            zIndex: 10,
            display: 'flex',
            alignItems: 'center',
            gap: spacing.md,
            borderBlockEnd: '1px solid var(--ant-color-border-secondary)',
          }}
        >
          <Button
            type="text"
            aria-label={effectiveCollapsed ? 'Expand navigation' : 'Collapse navigation'}
            icon={effectiveCollapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />}
            onClick={() => setCollapsed(!effectiveCollapsed)}
          />
          <div style={{ flex: 1, minWidth: 0 }}>{headerLeft}</div>
          {headerRight}
        </Header>

        <Content
          style={{
            padding: spacing.lg,
            maxWidth: layoutTokens.contentMaxWidth,
            width: '100%',
          }}
        >
          {children}
        </Content>
      </Layout>
    </Layout>
  );
}
