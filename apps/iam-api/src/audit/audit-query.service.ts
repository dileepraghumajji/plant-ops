/**
 * `GET /iam/audit` — the queryable side of governance (Doc 06 §12, Doc 10 §7).
 *
 * Doc 10 §1 lists four principles, and three of them were settled by Session 12
 * and by migrations 0005 and 0010: append-only, complete, attributable. This
 * service is the fourth — **queryable** — and it is the one that decides whether
 * the other three were worth anything. A trail nobody can search is a backup.
 *
 * ## Visibility is not implemented here, and that is the design
 *
 * Doc 10 §7 asks for two readers: a client admin who sees their own tenant's
 * rows, and a platform admin who sees everything including the `client_id is
 * null` rows that record platform-level acts. There is no branch below that
 * implements either. Both come from the `audit_trail_read` policy migration 0010
 * wrote:
 *
 * ```sql
 * for select using (app.is_platform_admin or client_id = app.current_client_id)
 * ```
 *
 * — evaluated against the transaction-local context `TenantContextInterceptor`
 * derived from the verified token (Doc 07 §5). So the tier difference is a
 * property of the *connection*, and a bug in this file cannot widen it: the
 * worst a wrong predicate here can do is return fewer rows than the caller was
 * entitled to. That is the same argument every tenant-scoped service in this
 * application makes, and it matters more here than anywhere else, because this
 * is the one endpoint whose whole product is other tenants' history.
 *
 * The suite that proves it is `audit-read.integration.spec.ts`, under a real
 * Postgres and the real app role. Nothing about it can be proved with a fake.
 *
 * ## Every filter narrows, and `client_id` narrows too
 *
 * Doc 10 §1.4 wants "actor, action, target, client, and time". A client admin
 * may pass `client_id`, and passing another tenant's returns an empty page —
 * not a 403, and not a 404. The RLS predicate is `and`-ed with this one, so a
 * filter can only ever subtract from what the policy already allows, and the
 * empty page is indistinguishable from a client that does not exist (Doc 06 §2:
 * a response must not reveal cross-tenant existence).
 *
 * ## Ordering, and the index behind it
 *
 * `created_at desc, id desc`. Newest first is what an operator investigating an
 * incident wants, and migration 0006 indexed `(client_id, created_at desc)`,
 * `(action, created_at desc)`, `(actor_id, created_at desc)` and
 * `(target_type, target_id, created_at desc)` for exactly these four filters.
 * `id` is the tiebreaker and it is not decoration: `write_audit` stamps
 * transaction time, so every row of one transaction ties on `created_at`, and a
 * sort with ties is a sort whose page boundaries move between requests.
 *
 * ## There is no write path in this file, by design
 *
 * Doc 10 §7: "audit is read-only through the API — there is no mutate/delete
 * endpoint by design". The app role holds `select` and nothing else on the table
 * (migration 0010), so a mutation here would fail at the database rather than
 * succeed quietly — but the reason it is not here is the design, not the
 * privilege. `audit.controller.ts` asserts the surface stays `GET`-only.
 */

import { Injectable } from '@nestjs/common';
import {
  normalizePagination,
  paginated,
  type AuditQuery,
  type AuditRecordDTO,
  type Paginated,
} from '@plantops/contracts';
import { IAM_SCHEMA } from '@plantops/db';
import { entityManager } from '../common/transaction-context';

const S = `"${IAM_SCHEMA}"`;

const COLUMNS = `id, client_id, actor_type, actor_id, action,
                 target_type, target_id, payload, created_at`;

/** Newest first, with `id` breaking the ties transaction time creates. */
const ORDER = 'order by created_at desc, id desc';

/** One row as Postgres hands it back. */
interface AuditRow {
  id: string;
  client_id: string | null;
  actor_type: AuditRecordDTO['actor_type'];
  actor_id: string | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  payload: Record<string, unknown>;
  created_at: Date;
}

/** A `where` clause and the parameters it numbers. */
export interface AuditFilter {
  where: string;
  parameters: unknown[];
}

/**
 * The filters of Doc 06 §12 as one `where` clause.
 *
 * Exported because the export path builds the same predicate and must not build
 * it differently: an export that covered a different set of rows from the page
 * the operator was looking at when they pressed the button is a governance bug,
 * not a cosmetic one.
 *
 * `true` is the base rather than an empty string, so that a filterless query is
 * a legal statement and every arm below can append with `and` unconditionally.
 * The planner discards it.
 */
export function auditFilter(query: AuditQuery = {}): AuditFilter {
  const clauses = ['true'];
  const parameters: unknown[] = [];

  const add = (clause: (position: string) => string, value: unknown): void => {
    parameters.push(value);
    clauses.push(clause(`$${parameters.length}`));
  };

  if (query.actor_id !== undefined) add((p) => `actor_id = ${p}::uuid`, query.actor_id);
  if (query.actor_type !== undefined) {
    add((p) => `actor_type = ${p}::${S}."audit_actor_type"`, query.actor_type);
  }
  if (query.action !== undefined) add((p) => `action = ${p}`, query.action);
  if (query.target_type !== undefined) {
    add((p) => `target_type = ${p}`, query.target_type);
  }
  if (query.target_id !== undefined) {
    add((p) => `target_id = ${p}::uuid`, query.target_id);
  }
  if (query.client_id !== undefined) {
    add((p) => `client_id = ${p}::uuid`, query.client_id);
  }
  // Half-open: `from` inclusive, `to` exclusive, so consecutive ranges neither
  // overlap nor drop the instant between them (`contracts/audit.ts`).
  if (query.from !== undefined) {
    add((p) => `created_at >= ${p}::timestamptz`, query.from);
  }
  if (query.to !== undefined) add((p) => `created_at < ${p}::timestamptz`, query.to);

  return { where: clauses.join(' and '), parameters };
}

/** A row → the published shape. The only transformation is the timestamp. */
export function toAuditRecord(row: AuditRow): AuditRecordDTO {
  return {
    id: row.id,
    client_id: row.client_id,
    actor_type: row.actor_type,
    actor_id: row.actor_id,
    action: row.action,
    target_type: row.target_type,
    target_id: row.target_id,
    // `jsonb` arrives parsed; the default is `'{}'`, so a null cannot reach
    // here — the coalesce is for a row written before that default existed.
    payload: row.payload ?? {},
    created_at: row.created_at.toISOString(),
  };
}

@Injectable()
export class AuditQueryService {
  /**
   * One page of the trail (Doc 06 §1's envelope, Doc 06 §12's filters).
   *
   * Two statements rather than a windowed `count(*) over ()`: the count is over
   * the whole filter and the page is over an index range, and folding them into
   * one query makes the planner materialize every matching row in order to
   * number them — which on a table that only grows is the difference between
   * scanning a day and scanning a year.
   */
  async list(query: AuditQuery = {}): Promise<Paginated<AuditRecordDTO>> {
    const { page, limit } = normalizePagination(query);
    const { where, parameters } = auditFilter(query);

    const rows = (await entityManager().query(
      `select ${COLUMNS}
         from ${S}."audit_trail"
        where ${where}
        ${ORDER}
        limit $${parameters.length + 1} offset $${parameters.length + 2}`,
      [...parameters, limit, (page - 1) * limit],
    )) as AuditRow[];

    const [count] = (await entityManager().query(
      `select count(*)::int as total from ${S}."audit_trail" where ${where}`,
      parameters,
    )) as { total: number }[];

    return paginated(rows.map(toAuditRecord), count?.total ?? rows.length, query);
  }

  /** How many rows the filter matches — what the export checks its cap against. */
  async count(query: AuditQuery = {}): Promise<number> {
    const { where, parameters } = auditFilter(query);

    const [count] = (await entityManager().query(
      `select count(*)::int as total from ${S}."audit_trail" where ${where}`,
      parameters,
    )) as { total: number }[];

    return count?.total ?? 0;
  }

  /**
   * One chunk of the export, continuing after `cursor`.
   *
   * Keyset rather than `offset`, and the reason is the shape of the table rather
   * than a preference: `offset 9500` re-reads the 9 500 rows it discards, so
   * paging an export with offsets costs O(n²) reads in the number of chunks.
   * `(created_at, id) < (…)` matches the `ORDER` above exactly, so each chunk
   * resumes on the same index at the cost of one descent.
   *
   * The row order is `created_at desc, id desc`, so "after" means *strictly
   * smaller* — the row-wise comparison, which compares `id` only where
   * `created_at` ties, and which is exactly the tie the transaction clock
   * creates.
   */
  async chunk(
    query: AuditQuery,
    limit: number,
    cursor?: { created_at: string; id: string },
  ): Promise<AuditRecordDTO[]> {
    const { where, parameters } = auditFilter(query);

    const keyset =
      cursor === undefined
        ? ''
        : `and (created_at, id) < ($${parameters.length + 1}::timestamptz, $${
            parameters.length + 2
          }::uuid)`;
    const bound =
      cursor === undefined ? [] : ([cursor.created_at, cursor.id] as unknown[]);

    const rows = (await entityManager().query(
      `select ${COLUMNS}
         from ${S}."audit_trail"
        where ${where} ${keyset}
        ${ORDER}
        limit $${parameters.length + bound.length + 1}`,
      [...parameters, ...bound, limit],
    )) as AuditRow[];

    return rows.map(toAuditRecord);
  }
}
