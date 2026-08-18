'use client';

/**
 * Everything the console needs above the first screen.
 *
 * Thin by design: the composition itself lives in `@plantops/web-kit`'s
 * `PlantOpsProvider` (theme → antd feedback hooks → IAM client → session →
 * grants, in the order they depend on each other), because the gatepass and
 * visitor consoles need the identical stack and getting the nesting wrong fails
 * silently — every permission answers `false` with no error anywhere.
 *
 * What is left here is what is genuinely this app's: which API to talk to, and
 * the fact that the admin console spans the whole IAM namespace rather than one
 * application's slice, so it passes no `applicationId` and renders the
 * cross-application shell (Doc 05 §4).
 */

import { PlantOpsProvider } from '@plantops/web-kit';
import type { ReactElement, ReactNode } from 'react';

import { IAM_API_URL } from '../lib/api-config';

export function Providers({ children }: { children: ReactNode }): ReactElement {
  return <PlantOpsProvider baseUrl={IAM_API_URL}>{children}</PlantOpsProvider>;
}
