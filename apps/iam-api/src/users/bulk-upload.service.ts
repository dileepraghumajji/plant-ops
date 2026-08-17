/**
 * `POST /iam/users/bulk` — the staff-list upload and its per-row report
 * (Doc 06 §8, Doc 09 §3.3).
 *
 * ## What "partial success" means here, precisely
 *
 * Doc 06 §8 asks that valid rows commit even when others fail. The obvious
 * reading — attempt every row and keep the ones that worked — is not available
 * inside a Postgres transaction: a failed statement aborts the block, so every
 * row after the first bad one would fail too, and recovering would mean a
 * `SAVEPOINT` per row and a round-trip per row with it.
 *
 * So the guarantee is delivered the other way round, and it is stronger: **a row
 * that would fail is never attempted.** Every row is validated against
 * `createUserSchema`, every in-file duplicate is resolved, and the one write
 * that runs uses `on conflict do nothing` so an address that already exists in
 * the tenant is a row the statement skips rather than a row it fails on. Nothing
 * in the upload can make the insert error, which is what lets the valid rows
 * commit — and the transaction stays all-or-nothing, so an unexpected database
 * failure rolls the whole thing back and `created` in the report always means
 * committed. Doc 06 §8 states this for consumers.
 *
 * ## One statement, not N
 *
 * The insert is a single `insert … select from unnest(…)`, for the reason
 * `AuditService.recordMany` gives: the statement text does not depend on the row
 * count, so there is one plan-cache entry rather than five hundred, and the
 * transaction is not held open across five hundred sequential round-trips while
 * it holds write locks on a table an administrator is about to bind roles on.
 * The returned `(id, email)` pairs are matched back to rows by address, which is
 * unambiguous because in-file duplicates have already been removed — `returning`
 * makes no promise about order.
 *
 * ## Two audit records, at two granularities
 *
 * `user.bulk_uploaded` once, with the counts, because the upload is a single act
 * an operator performed and Doc 10 §4 names it. `user.created` per created row,
 * through `recordMany`, because a person who appears in a tenant has to be
 * explicable on their own — an account whose only trace is a summary saying "412
 * users were created" is one nobody can account for later. Both are in the
 * request transaction, so a rollback takes the whole trail with the whole
 * upload.
 *
 * ## Authorization
 *
 * `@RequirePermission('iam.client.user.bulk_upload')` — its own key rather than
 * `user.create`, because the two are not the same power in practice: one adds a
 * person, the other adds up to five hundred in a single unreviewed act, and an
 * organisation may reasonably grant the first without the second.
 *
 * Isolation does not depend on it: `client_id` is pinned to the token's `cid` in
 * the statement and the whole thing runs under the request's RLS context.
 */

import { Injectable } from '@nestjs/common';
import {
  BULK_USER_CSV_COLUMNS,
  BulkUserRowStatus,
  IamErrorCode,
  MAX_BULK_USER_ROWS,
  UserStatus,
  type BulkUserRowResult,
  type BulkUserUploadFormat,
  type BulkUserUploadResponse,
} from '@plantops/contracts';
import { IAM_SCHEMA, type VerifiedClaims } from '@plantops/db';
import type { z } from 'zod';
import { AUDIT_ACTIONS } from '../audit/audit-actions';
import { AuditService, type AuditEntry } from '../audit/audit.service';
import { IamException } from '../common/iam.exception';
import { entityManager } from '../common/transaction-context';
import { CsvParseError, parseCsv } from './csv.util';
import { createUserSchema } from './dto/users.dto';

const S = `"${IAM_SCHEMA}"`;

/**
 * The one write.
 *
 * `on conflict (client_id, email) do nothing` names migration 0003's
 * `user_client_id_email_key` explicitly rather than relying on the bare form: an
 * untargeted `do nothing` would also swallow a violation of some *other*
 * constraint added later, turning a schema change into rows that silently vanish
 * from an upload nobody was told had skipped them.
 */
const INSERT_USERS = `
  insert into ${S}."user" (client_id, email, full_name, phone, status, is_client_admin)
  select $1::uuid, c.email, c.full_name, c.phone, c.status::${S}."user_status", false
    from unnest($2::text[], $3::text[], $4::text[], $5::text[])
      as c(email, full_name, phone, status)
      on conflict (client_id, email) do nothing
  returning id, email
`;

/**
 * The body, after `bulkUserUploadSchema` and before anything is read.
 *
 * Both payload fields are optional in the type because the schema expresses the
 * arm rule as a cross-field refinement rather than as a union — see
 * `dto/users.dto.ts` for why it has to. By the time this service is called the
 * refinement has already run, so exactly one of them is present; {@link readRows}
 * still handles the impossible case rather than asserting, because the honest
 * fallbacks cost a character each and an assertion would be a second copy of a
 * rule the schema already owns.
 */
export interface BulkUploadInput {
  format: BulkUserUploadFormat;
  content?: string;
  users?: readonly unknown[];
}

/** A row lifted out of the document, before it is known to describe a user. */
interface CandidateRow {
  /** 1-based among data rows, whichever format it arrived in. */
  row: number;
  /** Set when the document could not even shape this row into an object. */
  defect?: string;
  value: unknown;
}

/** A row that parsed, is not an in-file duplicate, and is on its way to the insert. */
interface InsertableRow {
  row: number;
  user: z.output<typeof createUserSchema>;
}

@Injectable()
export class BulkUploadService {
  constructor(private readonly audit: AuditService) {}

  /**
   * Reads the document, adjudicates every row, writes the survivors.
   *
   * @throws {IamException} `403` when the caller does not administer the tenant,
   * and `400` when the *document* is unreadable — malformed CSV, a header
   * missing a required column, more rows than {@link MAX_BULK_USER_ROWS}. Those
   * are properties of the upload rather than of a row, and there is no honest
   * per-row verdict to give for any of them.
   */
  async upload(
    claims: VerifiedClaims,
    input: BulkUploadInput,
  ): Promise<BulkUserUploadResponse> {
    const candidates = readRows(input);
    const { results, insertable } = adjudicate(candidates);

    const created = await this.insert(claims, insertable);

    // The verdict for a row that reached the insert is decided by whether the
    // statement returned an id for it: no id means the address was already
    // taken in this tenant, which is a skip and not a failure — re-uploading a
    // roster after adding three people is the ordinary way this gets used.
    for (const { row, user } of insertable) {
      const id = created.get(user.email);
      results[row - 1] =
        id === undefined
          ? {
              row,
              email: user.email,
              status: BulkUserRowStatus.SKIPPED,
              reason: 'A user with this email already exists in this client',
              user_id: null,
            }
          : {
              row,
              email: user.email,
              status: BulkUserRowStatus.CREATED,
              user_id: id,
            };
    }

    await this.record(input.format, insertable, created, results);

    return summarize(results);
  }

  /** Runs {@link INSERT_USERS}, and answers with `email → id` for what it wrote. */
  private async insert(
    claims: VerifiedClaims,
    insertable: readonly InsertableRow[],
  ): Promise<Map<string, string>> {
    if (insertable.length === 0) return new Map();

    const rows = (await entityManager().query(INSERT_USERS, [
      claims.cid,
      insertable.map(({ user }) => user.email),
      insertable.map(({ user }) => user.full_name),
      insertable.map(({ user }) => user.phone ?? null),
      insertable.map(({ user }) => user.status ?? UserStatus.ACTIVE),
    ])) as { id: string; email: string }[];

    return new Map(rows.map((row) => [row.email, row.id]));
  }

  /**
   * The trail: one record per created user, then one for the upload itself.
   *
   * The summary names the rows that did *not* land, which the per-user records
   * cannot: a row that created nothing has no target to be recorded against, and
   * "why is this person not in the system" is a question asked months later by
   * somebody without the HTTP response in front of them. Both lists are bounded
   * by {@link MAX_BULK_USER_ROWS}, so the payload stays a record rather than a
   * document.
   */
  private async record(
    format: BulkUploadInput['format'],
    insertable: readonly InsertableRow[],
    created: ReadonlyMap<string, string>,
    results: readonly BulkUserRowResult[],
  ): Promise<void> {
    const entries: AuditEntry[] = [];
    for (const { row, user } of insertable) {
      const id = created.get(user.email);
      if (id === undefined) continue;
      entries.push({
        action: AUDIT_ACTIONS.USER_CREATED,
        target: { type: 'user', id },
        payload: {
          email: user.email,
          full_name: user.full_name,
          status: user.status ?? UserStatus.ACTIVE,
          is_client_admin: false,
          source: 'bulk',
          row,
        },
      });
    }
    await this.audit.recordMany(entries);

    const counts = summarize(results);
    await this.audit.record(
      AUDIT_ACTIONS.USER_BULK_UPLOADED,
      // No id: the act is the upload, and there is no single row it produced.
      // `AuditTarget.id` is nullable for exactly this case (`audit-actions.ts`).
      { type: 'user', id: null },
      {
        format,
        total: counts.total,
        created: counts.created,
        skipped: counts.skipped,
        errored: counts.errored,
        skipped_rows: rowsWith(results, BulkUserRowStatus.SKIPPED),
        errored_rows: rowsWith(results, BulkUserRowStatus.ERRORED),
      },
    );
  }
}

// ── reading the document ────────────────────────────────────────────────────

/**
 * The document → one candidate per data row, in file order.
 *
 * Both arms end in the same shape, which is the point: everything downstream —
 * validation, duplicate detection, the report — is written once and cannot
 * behave differently depending on which format an operator chose.
 */
function readRows(input: BulkUploadInput): CandidateRow[] {
  if (input.format === 'json') {
    // Already bounded by the DTO's `.max()`, since a JSON array's length is
    // known before it is read.
    return (input.users ?? []).map((value, index) => ({ row: index + 1, value }));
  }

  const table = readCsv(input.content ?? '');
  const headers = table.headers;
  const known = new Set<string>(BULK_USER_CSV_COLUMNS);

  return table.records.map(({ row, values }) => {
    if (values.length > headers.length) {
      return {
        row,
        value: undefined,
        defect:
          `This row has ${values.length} values but the header names ` +
          `${headers.length} columns, so its fields cannot be matched to them`,
      };
    }

    const record: Record<string, string> = {};
    headers.forEach((header, index) => {
      if (!known.has(header)) return;
      const value = values[index] ?? '';
      // An empty optional cell is the field being omitted, not set to "". The
      // two required ones are always passed through, so their own messages —
      // "a valid email address is required", "full_name is required" — are what
      // the report shows rather than zod's complaint about an absent key.
      if (value.trim() !== '' || header === 'email' || header === 'full_name') {
        record[header] = value;
      }
    });
    return { row, value: record };
  });
}

/** Parses the CSV and refuses the document-level faults, as a `400`. */
function readCsv(content: string): ReturnType<typeof parseCsv> {
  let table: ReturnType<typeof parseCsv>;
  try {
    table = parseCsv(content);
  } catch (error) {
    if (error instanceof CsvParseError) throw badDocument(error.message);
    throw error;
  }

  const duplicate = table.headers.find(
    (header, index) => table.headers.indexOf(header) !== index,
  );
  if (duplicate !== undefined) {
    throw badDocument(
      `The header names the column "${duplicate}" more than once, so it is ` +
        'ambiguous which one the values belong to.',
    );
  }

  const missing = (['email', 'full_name'] as const).filter(
    (column) => !table.headers.includes(column),
  );
  if (missing.length > 0) {
    // A file with no `email` column yields nothing usable, so five hundred
    // identical row errors would be a worse answer than one that names the
    // column and the columns that were found instead.
    throw badDocument(
      `The CSV header is missing the required column${missing.length > 1 ? 's' : ''} ` +
        `${missing.map((column) => `"${column}"`).join(' and ')}. ` +
        `The recognised columns are ${BULK_USER_CSV_COLUMNS.join(', ')}; this ` +
        `file has ${table.headers.map((header) => `"${header}"`).join(', ')}.`,
    );
  }

  if (table.records.length > MAX_BULK_USER_ROWS) {
    throw badDocument(
      `The CSV has ${table.records.length} rows; at most ${MAX_BULK_USER_ROWS} ` +
        'may be uploaded at once.',
    );
  }

  if (table.records.length === 0) {
    throw badDocument('The CSV has a header but no rows.');
  }

  return table;
}

function badDocument(message: string): IamException {
  return new IamException(IamErrorCode.VALIDATION_FAILED, message);
}

// ── adjudicating the rows ───────────────────────────────────────────────────

/**
 * Every candidate → its verdict, and the subset that is going to be written.
 *
 * The returned `results` is complete and in file order, with the insertable rows
 * holding a provisional `created` entry the caller overwrites once the statement
 * has said whether the address was free. Building it here rather than merging
 * two lists afterwards is what keeps `results[row - 1]` a safe index and the
 * report a rendering of the file rather than a re-ordering of it.
 */
function adjudicate(candidates: readonly CandidateRow[]): {
  results: BulkUserRowResult[];
  insertable: InsertableRow[];
} {
  const results: BulkUserRowResult[] = [];
  const insertable: InsertableRow[] = [];
  /** Normalized address → the row that claimed it first. */
  const seen = new Map<string, number>();

  for (const candidate of candidates) {
    const { row } = candidate;

    if (candidate.defect !== undefined) {
      results.push(errored(row, null, candidate.defect));
      continue;
    }

    const parsed = createUserSchema.safeParse(candidate.value);
    if (!parsed.success) {
      results.push(errored(row, readableEmail(candidate.value), describe(parsed.error)));
      continue;
    }

    const user = parsed.data;
    const first = seen.get(user.email);
    if (first !== undefined) {
      results.push({
        row,
        email: user.email,
        status: BulkUserRowStatus.SKIPPED,
        reason: `Row ${first} of this upload already uses this email`,
        user_id: null,
      });
      continue;
    }

    seen.set(user.email, row);
    insertable.push({ row, user });
    // Provisional: `upload()` replaces it once the insert has run. It is never
    // observable — the placeholder cannot reach a response — but it keeps the
    // array dense, which is what makes the index arithmetic there correct.
    results.push({
      row,
      email: user.email,
      status: BulkUserRowStatus.CREATED,
      user_id: null,
    });
  }

  return { results, insertable };
}

function errored(row: number, email: string | null, reason: string): BulkUserRowResult {
  return { row, email, status: BulkUserRowStatus.ERRORED, user_id: null, reason };
}

/**
 * The address as the file spelled it, for a row that failed validation.
 *
 * Echoed unnormalized and bounded, because the point is to help an operator find
 * the line in their spreadsheet: normalizing it would print something that is
 * not in their file, and `null` for a row whose address is the thing that is
 * wrong is honest — that row is found by its number.
 */
function readableEmail(value: unknown): string | null {
  if (typeof value !== 'object' || value === null) return null;
  const email = (value as Record<string, unknown>)['email'];
  return typeof email === 'string' && email.trim() !== ''
    ? email.trim().slice(0, 320)
    : null;
}

/**
 * A zod failure → one line an operator can act on.
 *
 * Capped at three issues: a row that is wrong in four ways is wrong, and a
 * report cell holding a paragraph is one nobody reads. The field name is
 * prefixed because "is required" on its own does not say which.
 */
function describe(error: z.ZodError): string {
  const shown = error.issues.slice(0, 3).map((issue) => {
    const field = issue.path.join('.');
    return field === '' ? issue.message : `${field}: ${issue.message}`;
  });
  const remaining = error.issues.length - shown.length;
  return shown.join('; ') + (remaining > 0 ? ` (and ${remaining} more)` : '');
}

// ── the report ──────────────────────────────────────────────────────────────

function summarize(results: readonly BulkUserRowResult[]): BulkUserUploadResponse {
  return {
    total: results.length,
    created: countWith(results, BulkUserRowStatus.CREATED),
    skipped: countWith(results, BulkUserRowStatus.SKIPPED),
    errored: countWith(results, BulkUserRowStatus.ERRORED),
    results: [...results],
  };
}

function countWith(
  results: readonly BulkUserRowResult[],
  status: BulkUserRowStatus,
): number {
  return results.reduce((total, result) => total + (result.status === status ? 1 : 0), 0);
}

function rowsWith(
  results: readonly BulkUserRowResult[],
  status: BulkUserRowStatus,
): number[] {
  return results.filter((result) => result.status === status).map(({ row }) => row);
}
