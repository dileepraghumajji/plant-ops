'use client';

/**
 * The frame every authenticated screen renders inside.
 *
 * Mounted by `app/platform/layout.tsx` and `app/admin/layout.tsx` rather than
 * by a route group, so that the URL segments stay exactly what the nav catalog
 * says they are (`/platform/applications`, `/admin/users`) and the screen
 * sessions that follow add page files at those literal paths.
 *
 * ## One shell, two consoles
 *
 * There is no platform variant and no client variant. Doc 09 §1 describes two
 * experiences, but they differ only in the menu — and the menu is a projection
 * of the subject's grants that the server computes (Doc 05). A platform admin
 * and a tenant admin loading this component get different sidebars and the same
 * code, which is the property that makes "add an application to the registry"
 * a data change rather than a frontend release.
 */

import { AppShell, Brand } from '@plantops/ui';
import { Typography } from 'antd';
import { useRouter } from 'next/navigation';
import { useCallback, useState, type ReactElement, type ReactNode } from 'react';

import { RequireSession } from '../../lib/auth-context';
import { IAM_API_LABEL } from '../../lib/api-config';
import { HeaderActions } from './header';
import { Sidebar } from './sidebar';

export function ConsoleShell({ children }: { children: ReactNode }): ReactElement {
  const router = useRouter();
  const [collapsed, setCollapsed] = useState(false);

  const goHome = useCallback(() => {
    // `/` resolves to the first screen this subject may see — which differs per
    // subject, so it is a redirect the server's menu decides rather than a
    // literal path the brand knows.
    router.push('/');
  }, [router]);

  return (
    <RequireSession>
      <AppShell
        collapsed={collapsed}
        onCollapsedChange={setCollapsed}
        brand={<Brand product="IAM" collapsed={collapsed} onClick={goHome} />}
        renderNav={({ collapsed: isCollapsed }) => <Sidebar collapsed={isCollapsed} />}
        navFooter={
          collapsed ? undefined : (
            <Typography.Text
              style={{ color: 'inherit', fontSize: 11 }}
              ellipsis={{ tooltip: IAM_API_LABEL }}
            >
              {IAM_API_LABEL}
            </Typography.Text>
          )
        }
        headerRight={<HeaderActions />}
      >
        {children}
      </AppShell>
    </RequireSession>
  );
}
