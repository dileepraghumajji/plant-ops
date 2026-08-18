/**
 * The audit read surface — `GET /iam/audit` and its CSV export
 * (Doc 06 §12, Doc 10 §2, §7).
 *
 * The trail is written from a dozen places and read from exactly one, and this
 * file describes the reading half. Everything about the writing half — the
 * action catalog, the redaction boundary, the `SECURITY DEFINER` writer — is
 * deliberately absent: a consumer of this contract cannot write an audit row and
 * must not be given a type that suggests otherwise (Doc 10 §7: "audit is
 * read-only through the API — there is no mutate/delete endpoint by design").
 *
 * ## Why `action` and `target_type` are plain strings here
 *
 * The IAM types both narrowly for its *writers* — `AUDIT_ACTIONS` and
 * `AUDIT_TARGET_TYPES` in `apps/iam-api/src/audit/audit-actions.ts` — so a
 * misspelling does not compile. A *reader* cannot be typed that way, and the
 * reason is the whole point of an append-only table: rows outlive the catalog
 * that wrote them. An action retired in a later version, or a `target_type`
 * naming a table since renamed, is still in the trail and must still be
 * readable; a union here would make the compiler refuse to describe history that
 * the database is contractually obliged to keep (Doc 10 §1, §6).
 *
 * `actor_type` is the exception, and it is the exception for the opposite
 * reason: it is a Postgres enum (migration 0001) rather than a convention, so
 * the database itself guarantees the three values — see {@link AuditActorType}.
 */

import type { PaginationQuery } from './pagination.js';

/**
 * Who took the action (Doc 10 §2).
 *
 * Derived inside `iam.write_audit` from the session context rather than passed
 * by any caller, which is what makes it non-forgeable (migration 0010): a
 * platform context stamps `platform`, an authenticated user `user`, and anything
 * else `service_account`.
 *
 * Spelled here rather than imported from `@plantops/db`, which contracts must
 * not depend on — it has zero dependencies by design (Doc 08 §3). The Postgres
 * enum is the same three values in the same order, and `libs/db`'s
 * `entities.spec.ts` asserts the two spellings against each other so they cannot
 * drift into an `actor_type` the API publishes and the column never produces.
 * Same arrangement as `UserStatus` and `ClientStatus`.
 */
export const AuditActorType = {
  USER: 'user',
  SERVICE_ACCOUNT: 'service_account',
  PLATFORM: 'platform',
} as const;
export type AuditActorType = (typeof AuditActorType)[keyof typeof AuditActorType];

export const AUDIT_ACTOR_TYPE_VALUES = [
  AuditActorType.USER,
  AuditActorType.SERVICE_ACCOUNT,
  AuditActorType.PLATFORM,
] as const satisfies readonly AuditActorType[];

/**
 * One record of the trail, exactly as Doc 10 §2 shapes it (Doc 01 §4.8).
 *
 * Every nullable field is nullable for a stated reason, and none of them is an
 * oversight:
 *
 * - **`client_id`** — null means a platform-level action, outside any tenant.
 *   Only a platform admin ever sees such a row (Doc 10 §7).
 * - **`actor_id`** — null where there was no subject to name. `platform.bootstrap`
 *   runs before any subject exists (migration 0011), and a failed login names an
 *   account that may not have matched anything.
 * - **`target_type` / `target_id`** — null where the event has no row to point
 *   at: a bulk upload reports counts, a denied request names a permission. The
 *   table's `audit_trail_target_is_typed` check means an id never arrives
 *   without a type, so the two are null together or the type alone is set.
 *
 * `payload` is whatever context the writer attached, after passing the redaction
 * boundary of Doc 10 §8 — so a consumer may render it, but must not assume any
 * particular key: the shape varies by action, and secrets are structurally
 * absent rather than merely omitted.
 */
export interface AuditRecordDTO {
  id: string;
  /** Null ⇒ a platform-level action, outside any tenant (Doc 10 §2). */
  client_id: string | null;
  actor_type: AuditActorType;
  /** Null where the event had no subject to attribute. */
  actor_id: string | null;
  /** A dotted verb from the Doc 10 §4 catalog — see the header on typing. */
  action: string;
  /** The table the target lives in, or null where the event names no row. */
  target_type: string | null;
  target_id: string | null;
  /** Redacted context (Doc 10 §8). Shape varies by action. */
  payload: Record<string, unknown>;
  /** ISO-8601. */
  created_at: string;
}

/**
 * The filters of Doc 06 §12, composable in any combination (Doc 10 §1.4:
 * "filterable by actor, action, target, client, and time").
 *
 * Every one of them **narrows** and none of them widens. That is the property
 * that makes the same query object safe for both tiers: visibility is decided by
 * the `audit_trail_read` RLS policy from the caller's own context (migration
 * 0010), so a client admin passing `client_id` of another tenant gets an empty
 * page rather than a refusal — the same answer they would get for a client that
 * does not exist, which is what Doc 06 §2 requires of anything that could
 * otherwise become a cross-tenant existence oracle.
 *
 * `from` and `to` are ISO-8601 instants compared against `created_at`, `from`
 * inclusive and `to` exclusive — the half-open convention that lets a caller
 * page a month by asking for `[2026-08-01, 2026-09-01)` without owning the
 * boundary problem.
 */
export interface AuditQuery extends PaginationQuery {
  /** The subject who acted — `actor_id`. */
  actor_id?: string;
  actor_type?: AuditActorType;
  /** An exact action from the Doc 10 §4 catalog. */
  action?: string;
  target_type?: string;
  target_id?: string;
  /** The tenant whose rows to show; only ever narrows what RLS already allows. */
  client_id?: string;
  /** Inclusive lower bound on `created_at`, ISO-8601. */
  from?: string;
  /** Exclusive upper bound on `created_at`, ISO-8601. */
  to?: string;
}

/** {@link AuditQuery} without the page — an export is of the whole filter. */
export type AuditExportQuery = Omit<AuditQuery, 'page' | 'limit'>;

/**
 * The most rows one CSV export may carry.
 *
 * A ceiling rather than a page, because an export is a document: a compliance
 * reader who asked for a quarter and silently received its first ten thousand
 * events has a file that *looks* complete and is not, which is a worse failure
 * than no file at all. So a filter matching more than this is refused with the
 * count and a suggestion to narrow the range (Doc 06 §2's `VALIDATION_FAILED`),
 * and every export that succeeds is the complete answer to what was asked.
 *
 * Ten thousand rows of this shape is a few megabytes — comfortably inside what a
 * spreadsheet opens and what a response can be assembled in.
 */
export const AUDIT_EXPORT_MAX_ROWS = 10_000;

/**
 * The CSV column order, which is part of the contract.
 *
 * An export is consumed by spreadsheets and by scripts, and both break when
 * columns move. Publishing the order here rather than leaving it inside the
 * server means a consumer can assert on it, and means the header row and the
 * value row cannot disagree — `audit-csv.ts` builds both from this list.
 */
export const AUDIT_EXPORT_COLUMNS = [
  'id',
  'created_at',
  'client_id',
  'actor_type',
  'actor_id',
  'action',
  'target_type',
  'target_id',
  'payload',
] as const satisfies readonly (keyof AuditRecordDTO)[];

export type AuditExportColumn = (typeof AUDIT_EXPORT_COLUMNS)[number];

/** `Content-Type` of the export, and what the browser saves it as. */
export const AUDIT_EXPORT_CONTENT_TYPE = 'text/csv; charset=utf-8';
export const AUDIT_EXPORT_FILENAME = 'audit-export.csv';
