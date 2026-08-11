/**
 * Pagination contract — `?page=&limit=` → `{ data, page, limit, total }`
 * (Doc 06 §1).
 *
 * Note the deliberate exception: `/iam/permissions/resolve` is **not**
 * paginated. A subject's grant set is one cacheable unit, bounded instead by
 * path minimization and the optional `applicationId` filter (Doc 06 §11).
 */

export const DEFAULT_PAGE = 1;
export const DEFAULT_PAGE_SIZE = 25;
export const MAX_PAGE_SIZE = 100;

/** Query parameters accepted by every list endpoint. */
export interface PaginationQuery {
  page?: number;
  limit?: number;
}

/** The envelope every list endpoint returns. */
export interface Paginated<T> {
  data: T[];
  page: number;
  limit: number;
  /** Total matching rows, not the length of `data`. */
  total: number;
}

/** Normalizes user input to a valid, bounded `(page, limit)` pair. */
export function normalizePagination(
  query: PaginationQuery = {},
): Required<PaginationQuery> {
  const page = Math.max(DEFAULT_PAGE, toInt(query.page, DEFAULT_PAGE));
  const requested = toInt(query.limit, DEFAULT_PAGE_SIZE);
  const limit = Math.min(MAX_PAGE_SIZE, Math.max(1, requested));
  return { page, limit };
}

function toInt(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.trunc(value)
    : fallback;
}

export function paginated<T>(
  data: T[],
  total: number,
  query: PaginationQuery = {},
): Paginated<T> {
  const { page, limit } = normalizePagination(query);
  return { data, page, limit, total };
}
