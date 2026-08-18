import type { Paginated } from '@plantops/contracts';

import { collectPages, findInPages, walkPages } from '../src/lib/paging';

/**
 * A stand-in for a Doc 06 §1 list endpoint over a fixed set of rows.
 *
 * Records the queries it was asked for, which is what most of these tests are
 * actually about: the screens that walk a list do so because there is no
 * by-id endpoint and no unpaginated one, and the property worth protecting is
 * that they stop as soon as they can rather than reading the whole catalog.
 */
function fakeEndpoint(rows: readonly string[]) {
  const calls: { page: number; limit: number }[] = [];
  const fetchPage = (query: {
    page: number;
    limit: number;
  }): Promise<Paginated<string>> => {
    calls.push(query);
    const start = (query.page - 1) * query.limit;
    return Promise.resolve({
      data: rows.slice(start, start + query.limit),
      page: query.page,
      limit: query.limit,
      total: rows.length,
    });
  };
  return { fetchPage, calls };
}

const rows = (count: number): string[] =>
  Array.from({ length: count }, (_, index) => `row-${index}`);

describe('collectPages', () => {
  it('returns every row, in server order', async () => {
    const { fetchPage } = fakeEndpoint(rows(25));
    await expect(collectPages(fetchPage, { limit: 10 })).resolves.toEqual(rows(25));
  });

  it('makes exactly the requests it needs', async () => {
    const { fetchPage, calls } = fakeEndpoint(rows(25));
    await collectPages(fetchPage, { limit: 10 });
    expect(calls).toEqual([
      { page: 1, limit: 10 },
      { page: 2, limit: 10 },
      { page: 3, limit: 10 },
    ]);
  });

  it('stops after one request when the first page holds everything', async () => {
    const { fetchPage, calls } = fakeEndpoint(rows(3));
    await collectPages(fetchPage, { limit: 10 });
    expect(calls).toHaveLength(1);
  });

  it('handles an empty list', async () => {
    const { fetchPage, calls } = fakeEndpoint([]);
    await expect(collectPages(fetchPage)).resolves.toEqual([]);
    expect(calls).toHaveLength(1);
  });

  it('clamps the page size to what the server accepts', async () => {
    // Anything above MAX_PAGE_SIZE is a 400, so asking for it would turn a
    // working screen into a broken one for the largest catalogs only.
    const { fetchPage, calls } = fakeEndpoint(rows(1));
    await collectPages(fetchPage, { limit: 5_000 });
    expect(calls[0].limit).toBe(100);
  });

  it('gives up at the page cap rather than looping forever', async () => {
    // A server that reports a total it never produces — the shape a broken
    // pager takes — must end the walk, not drive it.
    const calls: number[] = [];
    const fetchPage = (query: { page: number; limit: number }) => {
      calls.push(query.page);
      return Promise.resolve({
        data: rows(query.limit),
        page: query.page,
        limit: query.limit,
        total: Number.MAX_SAFE_INTEGER,
      });
    };

    await collectPages(fetchPage, { limit: 10, maxPages: 4 });
    expect(calls).toEqual([1, 2, 3, 4]);
  });

  it('stops on an empty page even when the total claims more', async () => {
    const fetchPage = (query: { page: number; limit: number }) =>
      Promise.resolve({
        data: query.page === 1 ? rows(10) : [],
        page: query.page,
        limit: query.limit,
        total: 999,
      });

    await expect(collectPages(fetchPage, { limit: 10 })).resolves.toHaveLength(10);
  });
});

describe('findInPages', () => {
  it('stops at the page holding the match', async () => {
    const { fetchPage, calls } = fakeEndpoint(rows(100));
    await expect(
      findInPages(fetchPage, (row) => row === 'row-15', { limit: 10 }),
    ).resolves.toBe('row-15');
    expect(calls.map((call) => call.page)).toEqual([1, 2]);
  });

  it('finds a match on the first page without a second request', async () => {
    const { fetchPage, calls } = fakeEndpoint(rows(100));
    await findInPages(fetchPage, (row) => row === 'row-0', { limit: 10 });
    expect(calls).toHaveLength(1);
  });

  it('is null when nothing matches, having read the whole list', async () => {
    const { fetchPage, calls } = fakeEndpoint(rows(25));
    await expect(
      findInPages(fetchPage, (row) => row === 'absent', { limit: 10 }),
    ).resolves.toBeNull();
    expect(calls).toHaveLength(3);
  });
});

describe('walkPages', () => {
  it('stops when the visitor says so', async () => {
    const { fetchPage, calls } = fakeEndpoint(rows(100));
    await walkPages(fetchPage, () => false, { limit: 10 });
    expect(calls).toHaveLength(1);
  });

  it('hands the visitor the envelope as well as the rows', async () => {
    const { fetchPage } = fakeEndpoint(rows(12));
    const totals: number[] = [];
    await walkPages(
      fetchPage,
      (_rows, page) => {
        totals.push(page.total);
      },
      { limit: 10 },
    );
    expect(totals).toEqual([12, 12]);
  });
});
