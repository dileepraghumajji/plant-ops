'use client';

/**
 * What stands behind a nav route this build has no screen for.
 *
 * Every route the IAM's own manifest puts in the menu now has a real page, so
 * this is no longer scaffolding waiting to be replaced — it is the permanent
 * answer to a case the registry makes possible on purpose: the nav catalog is
 * data (Doc 02, Doc 05 §7), and a platform admin may register an application, or
 * a menu, whose console this deployment does not carry. That is not an error, it
 * is a catalog running ahead of a build.
 *
 * So it explains rather than 404s in the abstract, and names the path — which is
 * the one thing that tells an operator whether they are looking at a stale
 * bookmark or at a menu entry pointing somewhere real that simply is not here
 * yet.
 *
 * It replaced `PendingScreenPage`, which did the same job for the twelve routes
 * Sessions 28–37 were still building. `specs/nav-routes.spec.ts` is what keeps
 * this from quietly becoming the answer to a route that *should* have a screen.
 */

import { Result } from 'antd';
import { usePathname } from 'next/navigation';
import type { ReactElement } from 'react';

export function UnknownScreen(): ReactElement {
  const pathname = usePathname();

  return (
    <Result
      status="404"
      title="No screen here"
      subTitle={
        <>
          The navigation catalog points at <code>{pathname}</code>, but this
          console has no screen for it. That is possible by design — the menu is
          data, so an application can be registered before the console that draws
          it ships. Check the link, or the deployment.
        </>
      }
    />
  );
}
