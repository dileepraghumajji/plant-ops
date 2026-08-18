/**
 * Every `/platform/*` route that has no screen yet.
 *
 * An *optional* catch-all, so it also answers bare `/platform`. Next resolves a
 * literal segment ahead of a catch-all, which is what lets Session 28 add
 * `platform/applications/page.tsx` and take that route over without touching
 * this file. See `components/pending-screen-page.tsx`.
 */

import type { ReactElement } from 'react';

import { PendingScreenPage } from '../../../components/pending-screen-page';

export default function PlatformPlaceholder(): ReactElement {
  return <PendingScreenPage />;
}
