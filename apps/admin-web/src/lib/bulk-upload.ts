/**
 * Pure functions behind the bulk user upload (Doc 09 §3.3, Doc 06 §8).
 *
 * ## What the console decides, and what it does not
 *
 * It decides **which of the two shapes** a dropped file is, and turns it into
 * the request body the endpoint takes. Nothing else. The rows themselves are
 * adjudicated server-side and come back as a per-row report — that is the whole
 * point of the endpoint — so a console that pre-validated addresses would be a
 * second, weaker copy of `users.dto.ts` producing a different verdict from the
 * one the operator is about to be shown.
 *
 * The CSV in particular is passed through **untouched**. Matching is by header
 * name, case- and whitespace-insensitively, never by position (Doc 06 §8), and a
 * parser here would have to reimplement that — including the quoting rules — to
 * gain nothing: the string travels inside the JSON envelope exactly as it was
 * read.
 *
 * ## Format is stated, not guessed at, on the wire
 *
 * `BulkUserUploadRequest` is discriminated on `format` so a body carrying
 * neither field, or both, is refused by name rather than guessed at. The guess
 * happens here instead, from the file extension and then from the first
 * non-blank character, and the screen shows what it decided so an operator can
 * correct it before sending.
 */

import type {
  BulkUserRowResult,
  BulkUserUploadRequest,
  CreateUserRequest,
} from '@plantops/contracts';
import { BULK_USER_CSV_COLUMNS, MAX_BULK_USER_ROWS } from '@plantops/contracts';

export type BulkFormat = 'csv' | 'json';

/**
 * The file an operator downloads before filling it in.
 *
 * Header row plus one example, because a template with only headers leaves the
 * question of what a `status` cell may contain unanswered — and `phone` and
 * `status` are both optional, which an example line shows more clearly than a
 * sentence.
 */
export const CSV_TEMPLATE = [
  BULK_USER_CSV_COLUMNS.join(','),
  'gita@example.test,Gita Rao,,active',
  'arun@example.test,Arun Patel,+91 98765 43210,disabled',
].join('\n');

/**
 * Which shape this text is, from the file name first and the content second.
 *
 * The extension is trusted when it is one of the two, because a file named
 * `.csv` is a statement of intent even if its first character happens to be `{`.
 * Failing that, a leading `{` or `[` is JSON and anything else is CSV — which
 * makes an empty file CSV, and the server then reports it as a header problem
 * rather than as a parse failure.
 */
export function detectFormat(fileName: string, text: string): BulkFormat {
  const lowered = fileName.toLowerCase();
  if (lowered.endsWith('.csv')) return 'csv';
  if (lowered.endsWith('.json')) return 'json';

  const first = text.trimStart().charAt(0);
  return first === '{' || first === '[' ? 'json' : 'csv';
}

export type BulkRequestResult =
  | { ok: true; request: BulkUserUploadRequest; rows: number }
  | { ok: false; problem: string };

/**
 * The request body for this text, or why it cannot be one.
 *
 * The only refusals here are the ones the endpoint could not explain usefully:
 * text that is not JSON at all, JSON that is not a list of people, and a row
 * count over the published ceiling. Everything else — a missing column, an
 * unreadable address, a duplicate — is the report's job, and refusing it here
 * would deny the operator the row-by-row answer they came for.
 */
export function buildBulkRequest(
  format: BulkFormat,
  text: string,
): BulkRequestResult {
  if (text.trim() === '') {
    return { ok: false, problem: 'There is nothing to upload yet.' };
  }

  if (format === 'csv') {
    const rows = countCsvDataRows(text);
    if (rows === 0) {
      return {
        ok: false,
        problem:
          'That file has a header and no people in it. Add a row per person — ' +
          `at least ${BULK_USER_CSV_COLUMNS.slice(0, 2).join(' and ')}.`,
      };
    }
    if (rows > MAX_BULK_USER_ROWS) {
      return { ok: false, problem: tooManyRows(rows) };
    }
    return { ok: true, request: { format: 'csv', content: text }, rows };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return {
      ok: false,
      problem: `This is not valid JSON. ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }

  // Both shapes an author might reasonably write: the endpoint's own envelope,
  // and the bare list that an export usually is.
  const users = Array.isArray(parsed)
    ? parsed
    : isRecord(parsed) && Array.isArray(parsed['users'])
      ? (parsed['users'] as unknown[])
      : null;

  if (users === null) {
    return {
      ok: false,
      problem:
        'A JSON upload is a list of people, either on its own or under a ' +
        '"users" key.',
    };
  }

  if (users.length === 0) {
    return { ok: false, problem: 'That list has nobody in it.' };
  }
  if (users.length > MAX_BULK_USER_ROWS) {
    return { ok: false, problem: tooManyRows(users.length) };
  }

  // Cast rather than validate: what a row *should* be is `users.dto.ts`'s to
  // decide, per row, so that a malformed one is reported beside the others
  // instead of failing the upload.
  return {
    ok: true,
    request: {
      format: 'json',
      users: users as CreateUserRequest[],
    },
    rows: users.length,
  };
}

function tooManyRows(rows: number): string {
  return (
    `That file has ${rows} rows and the limit is ${MAX_BULK_USER_ROWS}. ` +
    'Split it — each upload is one transaction, and the limit is what keeps ' +
    'that transaction short.'
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Data rows in a CSV — every non-blank line after the first.
 *
 * Only used to catch the two cases worth catching before sending: a file with
 * no people in it, and one over the ceiling. It deliberately does not parse:
 * a quoted field containing a newline would be miscounted, which would move a
 * borderline file from "refused here with a clear message" to "refused by the
 * server with a clear message". That is an acceptable trade for not carrying a
 * CSV parser the upload does not otherwise need.
 */
export function countCsvDataRows(text: string): number {
  return text
    .split(/\r?\n/)
    .slice(1)
    .filter((line) => line.trim() !== '').length;
}

// ── the report ───────────────────────────────────────────────────────────────

/** The filter above the per-row report (Doc 09 §3.3's "filterable by outcome"). */
export type OutcomeFilter = 'all' | BulkUserRowResult['status'];

export function filterResults(
  results: readonly BulkUserRowResult[],
  outcome: OutcomeFilter,
): BulkUserRowResult[] {
  if (outcome === 'all') return [...results];
  return results.filter((row) => row.status === outcome);
}

/**
 * The report as a CSV, so an operator can take the failures back to the file
 * they came from.
 *
 * A hundred errored rows in a table is a hundred rows to retype from a screen;
 * the same rows as a file open beside the original is a diff. Row numbers are
 * the report's own, which count data rows from 1 — the same numbering the
 * operator's spreadsheet shows once its header is discounted.
 */
export function resultsToCsv(results: readonly BulkUserRowResult[]): string {
  const escape = (value: string): string =>
    /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;

  return [
    'row,email,status,reason,user_id',
    ...results.map((row) =>
      [
        String(row.row),
        escape(row.email ?? ''),
        row.status,
        escape(row.reason ?? ''),
        row.user_id ?? '',
      ].join(','),
    ),
  ].join('\n');
}
