/**
 * Every `/admin/*` route the console has no screen for — the client half of the
 * arrangement described in `platform/[[...slug]]/page.tsx`.
 */

import type { ReactElement } from 'react';

import { UnknownScreen } from '../../../components/unknown-screen';

export default function AdminUnknownRoute(): ReactElement {
  return <UnknownScreen />;
}
