'use client';

/**
 * This tenant's machine identities (Doc 09 §3.5), at `/admin/service-accounts`.
 *
 * The client half of the arrangement described in
 * `platform/service-accounts/page.tsx`: one screen, one surface, and the tenant
 * decided by the caller's token rather than by the route.
 */

import type { ReactElement } from 'react';

import { AccountsTable } from '../../../components/service-accounts/accounts-table';

export default function ClientServiceAccountsPage(): ReactElement {
  return <AccountsTable tier="client" />;
}
