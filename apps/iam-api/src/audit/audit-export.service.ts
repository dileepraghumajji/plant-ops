/**
 * `GET /iam/audit/export` — the CSV, and the record that it happened
 * (Doc 10 §7, Doc 06 §12).
 *
 * ## Reading the audit trail in bulk is itself an event
 *
 * Doc 10 §7's last line is one clause long — "exports (CSV) are themselves
 * audited (`audit.exported`)" — and it is the whole reason this is a service
 * rather than a `format=csv` branch on the list endpoint. Paging a screen is
 * ordinary use; taking a copy of a tenant's security history away with you is
 * the act an investigator asks about afterwards, and the trail has to be able to
 * answer. So every export writes {@link AUDIT_ACTIONS.AUDIT_EXPORTED} naming the
 * filter that was run and how many rows left the building.
 *
 * That record is written through {@link AuditService.record}, which means it is
 * written **in the request transaction** — so an export that fails writes no
 * record, and a record that exists is one whose CSV was fully assembled. Doc 10
 * §3's coupling, applied to a read.
 *
 * It is written *after* the last row is read, which is why an export never
 * contains its own record. That is worth stating because the alternative is not
 * absurd — the row would be visible to a later statement in the same
 * transaction — and a file whose last line is "somebody exported this file" is a
 * small, permanent piece of confusion in a compliance artefact.
 *
 * ## The whole filter, or a refusal — never a silent prefix
 *
 * A filter matching more than {@link AUDIT_EXPORT_MAX_ROWS} is refused with the
 * count and told to narrow the range. Truncating instead is the failure mode
 * this cap exists to prevent: a reviewer who asked for a quarter and received
 * its first ten thousand events holds a file that looks complete, and nothing in
 * it says otherwise. A refusal is recoverable; a quiet prefix is not.
 *
 * The count comes from the same predicate the rows do
 * (`audit-query.service.ts`), and the route opens its transaction at
 * `REPEATABLE READ` (`audit.controller.ts`) — so the count, every chunk and the
 * `rows` figure in the audit record are all statements about one snapshot. At
 * `READ COMMITTED` they would each take their own, and a row committed between
 * the count and the first chunk would be exported without having been counted.
 *
 * ## Chunked reads, one buffered response
 *
 * The rows are read in keyset-paged chunks — the "export streamer" of the
 * roadmap — and the CSV is assembled in memory. The chunking is what keeps the
 * database side bounded; buffering the response is deliberate and is argued in
 * `audit-csv.ts`: an HTTP response cannot be un-sent, so a stream that failed
 * halfway would deliver a truncated audit export under a `200`.
 */

import { Injectable } from '@nestjs/common';
import {
  AUDIT_EXPORT_MAX_ROWS,
  type AuditExportQuery,
  type AuditRecordDTO,
} from '@plantops/contracts';
import { IamException } from '../common/iam.exception';
import { AUDIT_ACTIONS } from './audit-actions';
import { auditCsv } from './audit-csv';
import { AuditQueryService } from './audit-query.service';
import { AuditService } from './audit.service';

/**
 * Rows per statement while assembling the document.
 *
 * Large enough that the cap is ten round-trips rather than four hundred, small
 * enough that no single result set is unbounded. Nothing observable depends on
 * it: the same rows, in the same order, come out whatever it is.
 */
const CHUNK_SIZE = 1_000;

@Injectable()
export class AuditExportService {
  constructor(
    private readonly query: AuditQueryService,
    private readonly audit: AuditService,
  ) {}

  /**
   * The filtered trail as CSV, with `audit.exported` recorded beside it.
   *
   * @throws {IamException} 400 when the filter matches more than
   * {@link AUDIT_EXPORT_MAX_ROWS} rows — with the count, so the caller knows how
   * much to narrow by.
   */
  async export(filter: AuditExportQuery = {}): Promise<string> {
    const total = await this.query.count(filter);

    if (total > AUDIT_EXPORT_MAX_ROWS) {
      throw IamException.validationFailed([
        {
          field: 'from',
          message:
            `the filter matches ${total} records; an export carries at most ` +
            `${AUDIT_EXPORT_MAX_ROWS}. Narrow the date range or add a filter.`,
        },
      ]);
    }

    const records: AuditRecordDTO[] = [];
    let cursor: { created_at: string; id: string } | undefined;

    // Reads until a chunk comes back short. A chunk that is exactly full and
    // happens to be the last costs one extra empty statement, which is the
    // price of not needing the count to be race-free against the reads.
    for (;;) {
      const chunk = await this.query.chunk(filter, CHUNK_SIZE, cursor);
      records.push(...chunk);
      if (chunk.length < CHUNK_SIZE) break;

      const last = chunk[chunk.length - 1];
      cursor = { created_at: last.created_at, id: last.id };
    }

    // After the reads, so the export never contains its own record — see the
    // header. In the request transaction, so a failed export leaves none.
    await this.audit.record(
      AUDIT_ACTIONS.AUDIT_EXPORTED,
      { type: 'audit', id: null },
      { rows: records.length, filter: { ...filter } },
    );

    return auditCsv(records);
  }
}
