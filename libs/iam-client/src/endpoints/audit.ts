/**
 * `/iam/audit` — the queryable side of governance, Doc 06 §12.
 *
 * The last gap in "every Doc 06 endpoint has a typed method". `client.ts` used
 * to explain why it was open: Session 25 had not built the endpoint and
 * `@plantops/contracts` typed no audit record, so a method here would have had
 * to invent both. Both exist now, so this closes it.
 *
 * ## One route, two tiers, and no tier parameter
 *
 * `iam.platform.audit.read` and `iam.client.audit.read` both admit, and which of
 * them the caller holds decides nothing about the request. What a reader sees is
 * decided by the `audit_trail_read` policy alone (Doc 07 §6, Doc 10 §7): a client
 * admin their own tenant's rows, a platform admin everything including the
 * `client_id IS NULL` rows that record platform-level acts. So there is no
 * `?tier=`, and `client_id` only ever *narrows* what RLS already allows — a
 * tenant the caller may not see is an empty page, never a 403.
 *
 * ## The export answers CSV, and says so
 *
 * It takes the same filters and no page: it is the whole of the filter or it is
 * refused, because a truncated compliance export is indistinguishable from a
 * complete one. `accept: 'text'` is what lets it come back through the same
 * transport as everything else — same token, same error mapping — rather than
 * being fetched around the outside of this library.
 *
 * There is no mutating route here and there is not meant to be (Doc 10 §7).
 */

import type {
  AuditExportQuery,
  AuditQuery,
  AuditRecordDTO,
  Paginated,
} from '@plantops/contracts';
import { IAM_ROUTE_PREFIX } from '@plantops/contracts';

import type { Requester } from '../http.js';

export interface AuditApi {
  list(query?: AuditQuery): Promise<Paginated<AuditRecordDTO>>;
  /**
   * The same filter as a CSV document, which the export itself audits
   * (`audit.exported`, Doc 10 §7).
   *
   * Returns the CSV text. Handing it to the browser as a file is the caller's
   * job — this library runs in Node too, where there is nothing to download to.
   */
  export(query?: AuditExportQuery): Promise<string>;
}

export function auditEndpoints(request: Requester): AuditApi {
  const base = `${IAM_ROUTE_PREFIX}/audit`;

  return {
    list: (query) => request({ method: 'GET', path: base, query: { ...query } }),
    export: (query) =>
      request({
        method: 'GET',
        path: `${base}/export`,
        query: { ...query },
        accept: 'text',
      }),
  };
}
