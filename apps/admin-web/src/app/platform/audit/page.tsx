'use client';

/**
 * Platform audit (Doc 09 §2.3), at `/platform/audit`.
 *
 * The same screen as the client console's, because `GET /iam/audit` is one route
 * that either tier's key admits: what a reader sees is decided by the
 * `audit_trail_read` policy, not by which page they opened
 * (`components/audit/audit-table.tsx`). A platform admin sees every tenant's
 * rows and the `client_id IS NULL` ones that belong to no tenant at all.
 */

import type { ReactElement } from 'react';

import { AuditTable } from '../../../components/audit/audit-table';

export default function PlatformAuditPage(): ReactElement {
  return <AuditTable tier="platform" />;
}
