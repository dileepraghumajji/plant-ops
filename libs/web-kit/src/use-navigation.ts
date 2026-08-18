'use client';

/**
 * The menu, from `GET /iam/navigation` (Doc 05 §4).
 *
 * A hook rather than a provider because a console fetches it once, in the shell
 * layout, and passes the tree down as a prop to whatever renders it — the
 * sidebar, a mobile drawer, a command palette. Wrapping it in a context would
 * add an indirection for a single consumer.
 *
 * It is not cached here, for the reason `libs/iam-client/src/endpoints/
 * navigation.ts` gives: the menu changes when the *catalog* changes as well as
 * when grants change, it is fetched once per shell load rather than once per
 * request, and there is no burst for a cache to absorb — only staleness to
 * introduce. {@link UseNavigationResult.reload} exists for the platform admin
 * who has just edited the catalog and wants to see it (Doc 09 §2.1).
 */

import type { NavigationResponse, NavNodeDTO } from '@plantops/contracts';

import { useAuth, useIam } from './iam-provider';
import { useAsync } from './use-async';

export interface UseNavigationResult {
  /** The response, once it lands. */
  navigation: NavigationResponse | undefined;
  /** The tree alone — `[]` while loading, and for a subject who may see nothing. */
  tree: NavNodeDTO[];
  loading: boolean;
  error: unknown;
  reload: () => void;
}

/**
 * @param applicationId Narrows to one application's menu. Omit for the
 *   cross-application shell — one top-level node per enabled application
 *   (Doc 05 §4), which is what the admin console renders.
 */
export function useNavigation(applicationId?: string): UseNavigationResult {
  const client = useIam();
  const { status, subject } = useAuth();

  const state = useAsync(
    () => client.navigation.tree(applicationId === undefined ? {} : { applicationId }),
    // Re-fetched when the subject changes: the menu is a projection of *their*
    // grants, so serving the previous user's menu would be both wrong and
    // alarming.
    [client, subject?.id, subject?.sessionId, applicationId],
    { enabled: status === 'authenticated' },
  );

  return {
    navigation: state.data,
    tree: state.data?.tree ?? [],
    loading: state.loading,
    error: state.error,
    reload: state.reload,
  };
}
