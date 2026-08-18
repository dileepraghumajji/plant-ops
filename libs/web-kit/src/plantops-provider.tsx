'use client';

/**
 * One component that turns a React tree into a PlantOps console.
 *
 * Theme, antd's feedback hooks, the IAM client, the session, and the resolved
 * grants — in the order they depend on each other, which is the part that is
 * easy to get wrong and impossible to notice: mount `GrantsProvider` above
 * `IamProvider` and every permission answers `false` with no error anywhere.
 *
 * ```tsx
 * // apps/gatepass-web/src/app/providers.tsx
 * <PlantOpsProvider baseUrl={API_URL} applicationId={GATEPASS_APP_ID}>
 *   {children}
 * </PlantOpsProvider>
 * ```
 *
 * The composition also keeps the two libraries' seam honest. `@plantops/ui`
 * knows nothing about the IAM and `@plantops/web-kit` renders nothing of its
 * own; this file is the only place the two meet, and it meets them by nesting
 * rather than by either importing the other's internals.
 */

import type { FetchLike } from '@plantops/iam-client';
import { PlantOpsThemeProvider, type ColorMode } from '@plantops/ui';
import * as React from 'react';

import { GrantsProvider } from './grants-provider';
import { IamProvider } from './iam-provider';

export interface PlantOpsProviderProps {
  /** The IAM's origin, without the `/iam` or `/auth` prefix. */
  baseUrl: string;
  children: React.ReactNode;
  /**
   * Narrows resolved grants to one application (Doc 06 §11).
   *
   * Set it in a single-application console. The admin console leaves it unset:
   * it spans the whole `iam.platform.*` / `iam.client.*` namespace and renders
   * the cross-application shell.
   */
  applicationId?: string;
  /** Fixes the colour mode, disabling the stored preference. */
  colorMode?: ColorMode;
  /** Initial mode before the stored preference is read. */
  defaultColorMode?: ColorMode;
  /** `localStorage` slot for the token pair. */
  tokenStorageKey?: string;
  /** Abort a request that has taken this long. */
  timeoutMs?: number;
  /** Overrides the runtime's `fetch` — for a test, or for instrumentation. */
  fetch?: FetchLike;
}

export function PlantOpsProvider({
  baseUrl,
  children,
  applicationId,
  colorMode,
  defaultColorMode,
  tokenStorageKey,
  timeoutMs,
  fetch,
}: PlantOpsProviderProps): React.ReactElement {
  return (
    <PlantOpsThemeProvider mode={colorMode} defaultMode={defaultColorMode}>
      <IamProvider
        baseUrl={baseUrl}
        storageKey={tokenStorageKey}
        timeoutMs={timeoutMs}
        fetch={fetch}
      >
        <GrantsProvider applicationId={applicationId}>{children}</GrantsProvider>
      </IamProvider>
    </PlantOpsThemeProvider>
  );
}
