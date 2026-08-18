'use client';

/**
 * The console's binding between the shared session state and the Next router.
 *
 * The session itself — tokens, silent refresh, sign-in, sign-out, the
 * cross-tab handling — lives in `@plantops/web-kit`, because the gatepass and
 * visitor consoles need exactly the same thing and a copy per app is a copy per
 * app to keep correct. What cannot live there is *routing*: `web-kit` takes a
 * redirect callback rather than importing `next/navigation`, so that it stays
 * usable by a console built on something else and testable without a router.
 *
 * This file supplies the callback. The rule about *where* it may redirect to —
 * and the reason that rule matters — is in `return-to.ts`.
 */

import { RequireAuth, useAuth } from '@plantops/web-kit';
import { Skeleton } from 'antd';
import { useRouter } from 'next/navigation';
import { useCallback, type ReactElement, type ReactNode } from 'react';

import { loginUrlFor } from './return-to';

/**
 * Wraps the authenticated part of the console.
 *
 * Renders a skeleton while the browser works out whether a session exists —
 * which is one synchronous `localStorage` read away, so flashing the login
 * screen here would be a lie almost every time.
 */
export function RequireSession({ children }: { children: ReactNode }): ReactElement {
  const router = useRouter();

  const onUnauthenticated = useCallback(
    (target: string | null) => {
      router.replace(loginUrlFor(target));
    },
    [router],
  );

  return (
    <RequireAuth
      onUnauthenticated={onUnauthenticated}
      fallback={<Skeleton active style={{ padding: 24 }} />}
    >
      {children}
    </RequireAuth>
  );
}

export { useAuth };
export { LOGIN_PATH, RETURN_TO_PARAM, loginUrlFor, safeReturnTo } from './return-to';
