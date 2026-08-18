'use client';

/**
 * This tenant's audit trail (Doc 09 §3.6), at `/admin/audit`.
 *
 * The client half of the arrangement described in `platform/audit/page.tsx`. The
 * isolation is the database's — a client admin's reads are narrowed by RLS
 * before this screen sees a row — which is why there is no tenant filter here to
 * get wrong.
 */

import type { ReactElement } from 'react';

import { AuditTable } from '../../../components/audit/audit-table';

export default function ClientAuditPage(): ReactElement {
  return <AuditTable tier="client" />;
}
