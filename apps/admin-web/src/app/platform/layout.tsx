/**
 * Everything under `/platform` renders inside the console shell.
 *
 * A layout per top-level segment rather than one route group, so the URLs stay
 * literally what the nav catalog says (`/platform/applications`) and the screen
 * sessions that follow add `platform/applications/page.tsx` at that path
 * without a group prefix to remember.
 *
 * The shell is not what makes these screens platform-only — the server is.
 * A tenant admin who deep-links here gets a rendered 403, which is the
 * behaviour Doc 09 §4 asks for.
 */

import type { ReactElement, ReactNode } from 'react';

import { ConsoleShell } from '../../components/shell/console-shell';

export default function PlatformLayout({
  children,
}: {
  children: ReactNode;
}): ReactElement {
  return <ConsoleShell>{children}</ConsoleShell>;
}
