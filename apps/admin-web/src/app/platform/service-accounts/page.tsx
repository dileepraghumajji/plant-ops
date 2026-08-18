'use client';

/**
 * Platform-tier machine identities (Doc 09 §2.4), at `/platform/service-accounts`.
 *
 * The same screen as the client console's, because `/iam/service-accounts` is
 * one surface: which tenant's accounts a caller sees is decided by their token's
 * `cid` and by RLS, never by a route. A platform admin here is administering the
 * platform *tenant*, which migration 0011 makes a tenant like any other — which
 * is also why the controls are gated on `iam.client.svc.*` rather than on a
 * platform key. `components/service-accounts/accounts-table.tsx` sets that out.
 */

import type { ReactElement } from 'react';

import { AccountsTable } from '../../../components/service-accounts/accounts-table';

export default function PlatformServiceAccountsPage(): ReactElement {
  return <AccountsTable tier="platform" />;
}
