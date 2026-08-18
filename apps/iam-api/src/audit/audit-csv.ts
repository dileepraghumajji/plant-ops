/**
 * The CSV an audit export is (Doc 10 §7, Doc 06 §12).
 *
 * RFC 4180: `CRLF` between records, `,` between fields, a field quoted when it
 * contains a delimiter, a quote or a newline, and an embedded quote doubled.
 * Written here rather than taken from a library because the whole of it is the
 * forty lines below, and because the one rule that matters most is not in RFC
 * 4180 at all — see below.
 *
 * `users/csv.util.ts` is the reader and this is the writer, and they are
 * deliberately not one module. The reader's job is to survive a file an operator
 * exported from a spreadsheet and to report which *row* was wrong; this one
 * never fails, because its input is rows this system wrote. Merging them would
 * produce a module whose error type only half its callers can raise.
 *
 * ## Formula injection, which is why an audit export in particular needs care
 *
 * A spreadsheet treats a cell beginning `=`, `+`, `-`, `@`, tab or carriage
 * return as a *formula*, and several of them will evaluate it on open — up to
 * and including `=HYPERLINK` and `=cmd|…`. The values in this file are not
 * trusted: an audit `payload` records what a caller sent, so a display name of
 * `=cmd|'/c calc'!A1` is a string this system faithfully recorded and would
 * faithfully re-emit.
 *
 * So every field that begins with one of those characters is prefixed with a
 * single quote, which is the convention every spreadsheet reads as "this is
 * text". That changes the byte the cell starts with, which is a real cost: a
 * script diffing an export against the API's JSON must know about it. It is
 * documented here and asserted in `audit-csv.spec.ts`, and it is the right trade
 * — the alternative is an export of a security log that can attack the machine
 * of the person reviewing it.
 *
 * ## Why the whole document is a string
 *
 * The row cap ({@link AUDIT_EXPORT_MAX_ROWS}) bounds it to a few megabytes, and
 * the export must be atomic with the `audit.exported` record that accompanies it
 * (Doc 10 §7) — see `audit-export.service.ts`. A response streamed row by row
 * cannot be taken back once its headers are on the wire, so a failure halfway
 * through would deliver a truncated file under a `200`, which is precisely the
 * failure an audit export must not have.
 */

import {
  AUDIT_EXPORT_COLUMNS,
  type AuditExportColumn,
  type AuditRecordDTO,
} from '@plantops/contracts';

/** RFC 4180's record separator — `CRLF`, not `LF`. */
const RECORD_SEPARATOR = '\r\n';
const FIELD_SEPARATOR = ',';
const QUOTE = '"';

/** What forces a field to be quoted (RFC 4180 §2.6). */
const MUST_QUOTE = /[",\r\n]/;

/**
 * What a spreadsheet may evaluate as a formula.
 *
 * Tab and carriage return are here because a leading one is stripped by some
 * readers, exposing whatever follows it — so `\t=cmd` becomes `=cmd`.
 */
const FORMULA_LEAD = /^[=+\-@\t\r]/;

/** The prefix that makes a spreadsheet treat the cell as text. */
const TEXT_PREFIX = "'";

/**
 * One field, quoted and escaped as the format requires and de-fanged as the
 * reader requires.
 *
 * `null` becomes an empty field rather than the four letters `null`: the columns
 * that can be null mean "there was nothing to name" (Doc 10 §2), and an empty
 * cell is how a spreadsheet says that.
 */
export function csvField(value: string | null): string {
  if (value === null || value === '') return '';

  const guarded = FORMULA_LEAD.test(value) ? `${TEXT_PREFIX}${value}` : value;

  return MUST_QUOTE.test(guarded)
    ? `${QUOTE}${guarded.replaceAll(QUOTE, `${QUOTE}${QUOTE}`)}${QUOTE}`
    : guarded;
}

/** One record, as the {@link AUDIT_EXPORT_COLUMNS} order lays it out. */
export function csvRow(values: readonly (string | null)[]): string {
  return values.map(csvField).join(FIELD_SEPARATOR);
}

/**
 * One audit record's cells, in the published column order.
 *
 * `payload` is serialized as JSON into a single cell. A spreadsheet cannot
 * usefully explode a shape that varies by action, and flattening it into columns
 * would produce a file whose header depends on which rows matched — so the raw
 * object goes in one cell, where a reviewer can read it and a script can
 * `JSON.parse` it.
 */
function cellsOf(record: AuditRecordDTO): readonly (string | null)[] {
  const cell: Record<AuditExportColumn, string | null> = {
    id: record.id,
    created_at: record.created_at,
    client_id: record.client_id,
    actor_type: record.actor_type,
    actor_id: record.actor_id,
    action: record.action,
    target_type: record.target_type,
    target_id: record.target_id,
    payload: JSON.stringify(record.payload),
  };

  return AUDIT_EXPORT_COLUMNS.map((column) => cell[column]);
}

/**
 * The header row plus one row per record, `CRLF`-separated and `CRLF`-terminated.
 *
 * Terminated rather than merely separated, so that appending — which is what a
 * caller assembling several pages does — never needs to know whether the
 * previous chunk ended a line.
 *
 * A filter that matched nothing still produces the header. An empty file and a
 * file of zero records are different claims, and only the second is true.
 */
export function auditCsv(records: readonly AuditRecordDTO[]): string {
  const header = csvRow([...AUDIT_EXPORT_COLUMNS]);
  return [header, ...records.map((record) => csvRow(cellsOf(record)))]
    .map((row) => `${row}${RECORD_SEPARATOR}`)
    .join('');
}
