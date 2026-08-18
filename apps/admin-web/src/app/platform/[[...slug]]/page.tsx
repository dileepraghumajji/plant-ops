/**
 * Every `/platform/*` route the console has no screen for.
 *
 * Next resolves a literal segment — and a dynamic one — ahead of an optional
 * catch-all, so this only ever runs for a path no page claims. Since Session 37
 * that means a nav catalog entry this build does not carry, which
 * `components/unknown-screen.tsx` explains.
 */

import type { ReactElement } from 'react';

import { UnknownScreen } from '../../../components/unknown-screen';

export default function PlatformUnknownRoute(): ReactElement {
  return <UnknownScreen />;
}
