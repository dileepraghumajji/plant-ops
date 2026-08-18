/**
 * Still Session 34's screen — but it needs a route of its own now.
 *
 * Session 33 added `admin/users/[id]`, and a single dynamic segment beats the
 * optional catch-all in Next's resolution: without this file
 * `/admin/users/by-role` would render the user profile with `id="by-role"`
 * rather than the placeholder, and the first symptom would be a 400 from
 * `GET /iam/users/by-role`.
 *
 * So the placeholder keeps its route explicitly. It renders exactly what the
 * catch-all rendered — `PENDING_SCREENS` is still the single source of what is
 * pending — and Session 34 replaces the body of this file rather than creating
 * it.
 */

import type { ReactElement } from 'react';

import { PendingScreenPage } from '../../../../components/pending-screen-page';

export default function UsersByRolePlaceholder(): ReactElement {
  return <PendingScreenPage />;
}
