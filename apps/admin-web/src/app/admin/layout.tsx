/**
 * Everything under `/admin` — the tenant administrator's console — renders
 * inside the same shell as `/platform`.
 *
 * The same component, deliberately: the two consoles differ by the menu the
 * server computed, not by the frame around it (Doc 09 §1). See
 * `console-shell.tsx`.
 */

import type { ReactElement, ReactNode } from 'react';

import { ConsoleShell } from '../../components/shell/console-shell';

export default function AdminLayout({
  children,
}: {
  children: ReactNode;
}): ReactElement {
  return <ConsoleShell>{children}</ConsoleShell>;
}
