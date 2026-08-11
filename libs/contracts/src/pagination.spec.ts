import {
  DEFAULT_PAGE,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  normalizePagination,
  paginated,
} from './pagination.js';

describe('normalizePagination', () => {
  it('applies defaults for missing input', () => {
    expect(normalizePagination()).toEqual({
      page: DEFAULT_PAGE,
      limit: DEFAULT_PAGE_SIZE,
    });
    expect(normalizePagination({})).toEqual({
      page: DEFAULT_PAGE,
      limit: DEFAULT_PAGE_SIZE,
    });
  });

  it('clamps hostile input instead of trusting it', () => {
    expect(normalizePagination({ page: 0, limit: 0 })).toEqual({
      page: 1,
      limit: 1,
    });
    expect(normalizePagination({ page: -3, limit: 10_000 })).toEqual({
      page: 1,
      limit: MAX_PAGE_SIZE,
    });
    expect(normalizePagination({ page: 2.7, limit: 25.9 })).toEqual({
      page: 2,
      limit: 25,
    });
    expect(normalizePagination({ page: Number.NaN, limit: Number.NaN })).toEqual(
      { page: DEFAULT_PAGE, limit: DEFAULT_PAGE_SIZE },
    );
  });
});

describe('paginated', () => {
  it('reports total independently of the page slice', () => {
    expect(paginated(['a', 'b'], 57, { page: 3, limit: 2 })).toEqual({
      data: ['a', 'b'],
      page: 3,
      limit: 2,
      total: 57,
    });
  });
});
