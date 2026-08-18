/**
 * Walking a paginated endpoint, for the two screens that genuinely have to.
 *
 * Doc 06 §1 paginates every list and caps a page at `MAX_PAGE_SIZE`, which is
 * right for a table an admin scrolls. It is wrong for the two questions the
 * application detail screen asks:
 *
 * - **"Which application is `:id`?"** Doc 06 §4 has no `GET /iam/applications/
 *   :id` — deliberately, because it would return exactly what the list returns
 *   (`applications.controller.ts` says so). So the screen finds its row by
 *   walking the list, and stops at the page that has it.
 * - **"Every permission this application declares."** The menu-permission
 *   picker offers permission keys to map onto a nav node; offering the first
 *   twenty-five of them and a pager would make a mapping screen where the thing
 *   you want to map is on page three.
 *
 * Both are bounded reads over one application's catalog — tens of rows, not
 * thousands — so walking them is a handful of requests, not a scan. The page
 * cap below is what keeps that true if an assumption stops holding: a catalog
 * that outgrows it is a signal to add a search parameter to the API, and the
 * caller finds out because rows go missing rather than because the tab hangs.
 */

import type { Paginated, PaginationQuery } from '@plantops/contracts';
import { MAX_PAGE_SIZE } from '@plantops/contracts';

/** One page of a Doc 06 §1 list endpoint. */
export type PageFetcher<T> = (
  query: Required<PaginationQuery>,
) => Promise<Paginated<T>>;

export interface WalkOptions {
  /** Rows per request. Clamped to the server's `MAX_PAGE_SIZE`. */
  limit?: number;
  /**
   * How many requests a walk may make before giving up.
   *
   * At the default limit that is ten thousand rows — far past any realistic
   * application catalog, and near enough that a runaway loop against a
   * misbehaving server ends rather than fetching forever.
   */
  maxPages?: number;
}

const DEFAULT_MAX_PAGES = 100;

/**
 * Fetches pages in order, handing each to `visit`, until `visit` returns
 * `false`, a page comes back short, the total is reached, or the cap is hit.
 *
 * An empty page ends the walk even when `total` claims more rows: a server that
 * reports a total it cannot produce should end the loop, not drive it.
 */
export async function walkPages<T>(
  fetchPage: PageFetcher<T>,
  visit: (rows: T[], page: Paginated<T>) => boolean | void,
  options: WalkOptions = {},
): Promise<void> {
  const limit = Math.min(Math.max(1, options.limit ?? MAX_PAGE_SIZE), MAX_PAGE_SIZE);
  const maxPages = Math.max(1, options.maxPages ?? DEFAULT_MAX_PAGES);

  let page = 1;
  let seen = 0;

  for (;;) {
    const result = await fetchPage({ page, limit });
    const rows = result.data;
    seen += rows.length;

    if (visit(rows, result) === false) return;

    const exhausted =
      rows.length === 0 || rows.length < limit || seen >= result.total;
    if (exhausted || page >= maxPages) return;

    page += 1;
  }
}

/** Every row of a list endpoint, in server order. */
export async function collectPages<T>(
  fetchPage: PageFetcher<T>,
  options: WalkOptions = {},
): Promise<T[]> {
  const all: T[] = [];
  await walkPages(fetchPage, (rows) => {
    all.push(...rows);
  }, options);
  return all;
}

/**
 * The first row matching `predicate`, or `null` — stopping at the page that
 * contains it rather than reading the whole list.
 */
export async function findInPages<T>(
  fetchPage: PageFetcher<T>,
  predicate: (row: T) => boolean,
  options: WalkOptions = {},
): Promise<T | null> {
  let found: T | null = null;
  await walkPages(fetchPage, (rows) => {
    const match = rows.find(predicate);
    if (match === undefined) return true;
    found = match;
    return false;
  }, options);
  return found;
}
