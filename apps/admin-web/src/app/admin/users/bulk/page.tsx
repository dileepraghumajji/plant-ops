/**
 * Still Session 34's screen, with a route of its own for the reason
 * `by-role/page.tsx` sets out: `admin/users/[id]` would otherwise swallow it.
 */

import type { ReactElement } from 'react';

import { PendingScreenPage } from '../../../../components/pending-screen-page';

export default function BulkUploadPlaceholder(): ReactElement {
  return <PendingScreenPage />;
}
