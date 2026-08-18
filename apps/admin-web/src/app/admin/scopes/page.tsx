'use client';

/**
 * Org structure — the client console's scope tree (Doc 09 §3.1, Doc 06 §6).
 *
 * The route is `/admin/scopes` because that is what the IAM's own manifest puts
 * in the nav catalog (`tools/iam-manifest.json`), and the console renders the
 * menu the server sends rather than a list of its own constants (Doc 05 §7).
 *
 * The screen itself is `components/scopes/scope-tree-editor.tsx`. This file is
 * the route, and it is thin on purpose: Session 35's access screen mounts the
 * same tree as a picker, and an editor that only existed as a page would have to
 * be lifted out at that point.
 */

import type { ReactElement } from 'react';

import { ScopeTreeEditor } from '../../../components/scopes/scope-tree-editor';

export default function ScopesPage(): ReactElement {
  return <ScopeTreeEditor />;
}
