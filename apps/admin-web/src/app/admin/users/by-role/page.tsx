'use client';

/**
 * Users by Role (Doc 09 §3.3), at `/admin/users/by-role`.
 *
 * The screen is `components/users/users-by-role.tsx`; this file is the route,
 * and it stays a route of its own rather than a tab of the user list because
 * that is where the IAM's own manifest puts it (`tools/iam-manifest.json`) and
 * the console renders the menu the server sends.
 */

import type { ReactElement } from 'react';

import { UsersByRole } from '../../../../components/users/users-by-role';

export default function UsersByRolePage(): ReactElement {
  return <UsersByRole />;
}
