/**
 * Every `/admin/*` route that has no screen yet — the client console's half of
 * the arrangement described in `platform/[[...slug]]/page.tsx`.
 */

import type { ReactElement } from 'react';

import { PendingScreenPage } from '../../../components/pending-screen-page';

export default function AdminPlaceholder(): ReactElement {
  return <PendingScreenPage />;
}
