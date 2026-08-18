'use client';

/**
 * The signed-in subject's resolved grants, fetched once per session.
 *
 * `GET /iam/permissions/resolve` answers WHO × WHAT × WHERE for the bearer
 * (Doc 04 §4) and is not paginated — it is one cacheable unit. A console needs
 * it constantly: every permission-aware button consults it (Doc 09 §4). Fetched
 * per component that asks, a screen with a dozen guarded controls would issue a
 * dozen identical requests; fetched once here, it issues one.
 *
 * `IamClient.grants()` already caches with a short TTL, so this provider is
 * mostly about *React* — giving every consumer the same object identity, and a
 * single place to invalidate from.
 *
 * ## Staleness is expected, and is the server's business
 *
 * Doc 04 §7 says grant changes invalidate the server's cache immediately, and
 * Doc 09 §4 asks the console to tell an admin that "access updates may take a
 * few seconds" after a role or binding change. So this provider does not try to
 * be clever: it holds what it fetched, exposes {@link GrantsContextValue.reload}
 * for the screen that just changed something, and re-fetches when the identity
 * changes. Anything it shows that is out of date is corrected by the server the
 * moment the user actually tries the action.
 */

import type { ResolvedGrants } from '@plantops/contracts';
import * as React from 'react';

import { useAuth, useIam } from './iam-provider';
import { useAsync } from './use-async';

export interface GrantsContextValue {
  /** `undefined` until the first resolve lands. */
  grants: ResolvedGrants | undefined;
  loading: boolean;
  error: unknown;
  /** Re-resolves, bypassing the client's cache. */
  reload: () => void;
}

const GrantsContext = React.createContext<GrantsContextValue | null>(null);

export function useGrants(): GrantsContextValue {
  const value = React.useContext(GrantsContext);
  if (value === null) {
    throw new Error('useGrants() requires an <IamProvider> above it in the tree.');
  }
  return value;
}

export interface GrantsProviderProps {
  children: React.ReactNode;
  /**
   * Narrows the resolve to one application's slice (Doc 06 §11).
   *
   * The admin console leaves it unset — it spans the IAM's whole permission
   * namespace. A single-application console (gatepass, visitor) sets it, and
   * gets a smaller answer that changes less often.
   */
  applicationId?: string;
}

/**
 * Supplies {@link useGrants}. Mounted by `IamProvider`; a console does not
 * normally render it directly.
 */
export function GrantsProvider({
  children,
  applicationId,
}: GrantsProviderProps): React.ReactElement {
  const client = useIam();
  const { status, subject } = useAuth();

  const state = useAsync(
    () => client.grants(applicationId === undefined ? {} : { applicationId }),
    // Keyed on the subject, not merely on "authenticated": signing out and
    // straight back in as someone else must re-resolve. `IamClient` empties its
    // own cache on any identity change for the same reason.
    [client, subject?.id, subject?.sessionId, applicationId],
    { enabled: status === 'authenticated' },
  );

  // `state.reload` rather than `state`: the state object is new on every render,
  // and depending on it would give every consumer of this context a new value
  // each time — which for a context read by every permission-aware control in
  // the console is a re-render of the whole screen per keystroke elsewhere.
  const stateReload = state.reload;
  const reload = React.useCallback(() => {
    client.invalidateGrants(applicationId);
    stateReload();
  }, [client, applicationId, stateReload]);

  const value = React.useMemo<GrantsContextValue>(
    () => ({
      grants: status === 'authenticated' ? state.data : undefined,
      // `initializing` counts as loading. The resolve has not been *asked for*
      // yet at that point, so `useAsync` honestly reports `loading: false` —
      // but a screen reading this to decide between a skeleton and "you have no
      // access" would take that as an answer, and give the wrong one.
      loading: state.loading || status === 'initializing',
      error: state.error,
      reload,
    }),
    [status, state.data, state.loading, state.error, reload],
  );

  return <GrantsContext.Provider value={value}>{children}</GrantsContext.Provider>;
}
