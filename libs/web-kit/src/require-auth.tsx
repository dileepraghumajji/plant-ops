'use client';

/**
 * The gate in front of every authenticated screen.
 *
 * Three states, three behaviours: while the browser is still working out
 * whether a session exists it renders `fallback` (a session almost certainly
 * *does* exist — the tokens are one synchronous `localStorage` read away — so
 * flashing the login screen here would be a lie); with a session it renders the
 * screen; without one it calls `onUnauthenticated` and renders nothing.
 *
 * Routing is a callback rather than an import. This library has no router: a
 * `next/navigation` import here would tie the gatepass and visitor consoles to
 * the Next app router forever, and would make this component untestable without
 * one. The caller passes `(target) => router.replace(...)` and keeps the
 * decision about *where* the login screen lives.
 *
 * ## The `next` parameter
 *
 * `onUnauthenticated` receives where the user was going. A deep link into a
 * screen — from a bookmark, from a colleague's message — must survive the
 * sign-in, or the link is only useful to someone already signed in. The caller
 * decides how to carry it; a query parameter is the usual answer.
 *
 * ## This is not authorisation
 *
 * It answers "is anyone signed in", not "may they see this". Permission is the
 * server's answer, arriving as a 403 the screen renders with `<ScreenError>`
 * (Doc 09 §4). A component that hid screens by permission would be re-deriving
 * the pruning the navigation endpoint already did, and would still have to
 * handle the 403 for the deep link it got wrong.
 */

import * as React from 'react';

import { useAuth } from './iam-provider';

export interface RequireAuthProps {
  children: React.ReactNode;
  /**
   * Called once, when the browser has established that nobody is signed in.
   *
   * @param target The path the user was trying to reach, or `null` when it
   *   could not be determined (server rendering).
   */
  onUnauthenticated: (target: string | null) => void;
  /** Rendered while the session is being established. */
  fallback?: React.ReactNode;
}

export function RequireAuth({
  children,
  onUnauthenticated,
  fallback = null,
}: RequireAuthProps): React.ReactNode {
  const { status } = useAuth();

  // Held in a ref so a re-render — a colour-mode change, a resize — cannot fire
  // a second redirect while the first is still in flight.
  const redirected = React.useRef(false);
  const redirect = React.useRef(onUnauthenticated);
  redirect.current = onUnauthenticated;

  React.useEffect(() => {
    if (status !== 'unauthenticated' || redirected.current) return;
    redirected.current = true;

    const location = globalThis.location;
    const target =
      location === undefined ? null : `${location.pathname}${location.search}`;
    redirect.current(target);
  }, [status]);

  React.useEffect(() => {
    if (status === 'authenticated') redirected.current = false;
  }, [status]);

  if (status === 'authenticated') return children;
  if (status === 'initializing') return fallback;
  return null;
}
