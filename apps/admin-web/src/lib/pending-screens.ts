'use client';

/**
 * Scaffolding, with an expiry date.
 *
 * Session 27 builds the shell; the screens themselves arrive in Sessions 28–37.
 * That leaves twelve routes in the nav catalog that a signed-in admin can click
 * today, and the honest thing to put behind each one is not a blank page but a
 * screen that says which session builds it — and that *actually calls the API
 * it will call*, so the plumbing is exercised end to end before the screen
 * exists.
 *
 * That second part is the reason this file is not a list of strings. Doc 09 §4
 * requires that a deep link into a screen the menu hid still reaches the server
 * and renders its 403 cleanly, because client-side hiding is UX and the server
 * is the enforcement. A placeholder that rendered static text would let that
 * requirement pass untested until Session 28. Each entry below therefore issues
 * the read its screen will issue, which means a client admin opening
 * `/platform/applications` gets a real `PERMISSION_DENIED` from a real request.
 *
 * ## How this file disappears
 *
 * Each screen session deletes its own row and adds a real `page.tsx` at that
 * path — Next resolves a literal segment ahead of the optional catch-all, so a
 * new page takes over its route with no coordination. When the last row goes,
 * so do this file and the two catch-all pages.
 */

import type { IamClient } from '@plantops/iam-client';

export interface PendingScreen {
  title: string;
  /** What the screen will be for — the spec's sentence, not a placeholder's. */
  description: string;
  /** Roadmap session that replaces this row. */
  session: string;
  /**
   * The read the real screen will perform, returning one summary line.
   *
   * Runs against the live API with the caller's token, so its failure — 403,
   * 401, a network fault — is the failure the finished screen would have.
   */
  probe: (iam: IamClient) => Promise<string>;
}

const count = (label: string) => (total: number) =>
  `${total} ${label}${total === 1 ? '' : 's'}`;

export const PENDING_SCREENS: Readonly<Record<string, PendingScreen>> = Object.freeze({
  '/platform/service-accounts': {
    title: 'Service accounts',
    description:
      'Platform machine identities. Secrets are shown exactly once, at create and at rotate.',
    session: 'Session 36',
    probe: async (iam) =>
      iam.serviceAccounts
        .list({ limit: 1 })
        .then((page) => count('service account')(page.total)),
  },

  '/platform/audit': {
    title: 'Platform audit',
    description:
      'The audit trail across every tenant, filterable by actor, action, target and date, with an export that is itself audited.',
    session: 'Session 37',
    probe: async (iam) => {
      // `/iam/audit` has no typed method yet — Session 26 documents the gap —
      // so this goes through the client's raw request, which still carries the
      // token and still maps the error.
      const page = await iam.request<{ total: number }>({
        method: 'GET',
        path: '/iam/audit',
        query: { limit: 1 },
      });
      return count('audit record')(page.total);
    },
  },

  '/admin/scopes': {
    title: 'Org structure',
    description:
      'The scope tree — Group, Plant, Department, Gate. This is the WHERE of every grant: access follows the tree downward.',
    session: 'Session 31',
    probe: async (iam) =>
      iam.scopes.tree().then((tree) => count('root node')(tree.tree.length)),
  },

  '/admin/roles': {
    title: 'Roles',
    description:
      'Roles and what they carry: a permission picker grouped by the applications enabled for this client.',
    session: 'Session 32',
    probe: async (iam) =>
      iam.roles.list({ limit: 1 }).then((page) => count('role')(page.total)),
  },

  '/admin/users': {
    title: 'Users',
    description:
      'The tenant’s people: search, status filters including the locked view, and per-user lock, unlock, disable and password reset.',
    session: 'Session 33',
    probe: async (iam) =>
      iam.users.list({ limit: 1 }).then((page) => count('user')(page.total)),
  },

  '/admin/users/by-role': {
    title: 'Users by role',
    description: 'Pick a role, see who holds it and at which scope node.',
    session: 'Session 34',
    probe: async (iam) =>
      iam.roles.list({ limit: 1 }).then((page) => count('role')(page.total)),
  },

  '/admin/users/bulk': {
    title: 'Bulk user upload',
    description:
      'A CSV or JSON roster, with a per-row report: created, skipped or errored, and why.',
    session: 'Session 34',
    probe: async (iam) =>
      iam.users.list({ limit: 1 }).then((page) => count('existing user')(page.total)),
  },

  '/admin/access': {
    title: 'Access assignment',
    description:
      'The central screen: who × which role × where, with the scope node chosen from the org tree and never assumed.',
    session: 'Session 35',
    probe: async (iam) =>
      iam.roleBindings.list({ limit: 1 }).then((page) => count('grant')(page.total)),
  },

  '/admin/service-accounts': {
    title: 'Service accounts',
    description:
      'This client’s machine identities, bindable to roles and scope nodes exactly like people.',
    session: 'Session 36',
    probe: async (iam) =>
      iam.serviceAccounts
        .list({ limit: 1 })
        .then((page) => count('service account')(page.total)),
  },

  '/admin/audit': {
    title: 'Audit',
    description:
      'This client’s audit trail: logins, grants, lock and unlock, binding changes.',
    session: 'Session 37',
    probe: async (iam) => {
      const page = await iam.request<{ total: number }>({
        method: 'GET',
        path: '/iam/audit',
        query: { limit: 1 },
      });
      return count('audit record')(page.total);
    },
  },
});

/** The entry for a path, or `null` when the console has no screen there. */
export function pendingScreenFor(pathname: string): PendingScreen | null {
  const normalized = pathname.replace(/\/+$/, '');
  return PENDING_SCREENS[normalized === '' ? '/' : normalized] ?? null;
}
