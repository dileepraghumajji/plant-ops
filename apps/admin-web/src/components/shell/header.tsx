'use client';

/**
 * The header's right-hand side: who is signed in, and how to stop being.
 *
 * Two things it puts on screen that an admin console usually has to be asked
 * for. The first is the **tenant**: the same email can exist in several clients
 * (Doc 06 §8), so "which PlantOps am I in" has to be answerable at a glance
 * rather than by memory of which tab is which. The second is the **request
 * environment** — the API host, in the sidebar footer — because the most
 * expensive minutes of any admin's day are the ones spent making a change on
 * the wrong environment.
 */

import { UserMenu, useColorMode } from '@plantops/ui';
import { useNotices } from '@plantops/web-kit';
import { useRouter } from 'next/navigation';
import { useCallback, type ReactElement } from 'react';

import { useAuth, LOGIN_PATH } from '../../lib/auth-context';

export function HeaderActions(): ReactElement | null {
  const { subject, logout } = useAuth();
  const { mode, toggle } = useColorMode();
  const { error } = useNotices();
  const router = useRouter();

  const onLogout = useCallback(() => {
    void (async () => {
      try {
        await logout();
      } catch (cause) {
        // `logout()` clears the local session even when the server call fails,
        // so the user *is* signed out; they are told why the server was not
        // told, because their other devices are still logged in.
        error(cause, { title: 'Signed out here, but the server was not reached' });
      } finally {
        router.replace(LOGIN_PATH);
      }
    })();
  }, [logout, error, router]);

  if (subject === null) return null;

  return (
    <UserMenu
      name={subject.email ?? 'Signed in'}
      tenant={subject.clientSlug}
      subtitle={subject.type === 'service' ? 'Service account' : subject.email}
      onLogout={onLogout}
      colorMode={{ mode, onToggle: toggle }}
    />
  );
}
