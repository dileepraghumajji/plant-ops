import type { BulkUserRowResult } from '@plantops/contracts';
import { MAX_BULK_USER_ROWS } from '@plantops/contracts';

import {
  CSV_TEMPLATE,
  buildBulkRequest,
  countCsvDataRows,
  detectFormat,
  filterResults,
  resultsToCsv,
} from '../src/lib/bulk-upload';

const CSV = 'email,full_name\ngita@acme.test,Gita Rao\narun@acme.test,Arun Patel';

describe('deciding which shape a roster is', () => {
  it('trusts a .csv or .json extension', () => {
    // A file named `.csv` is a statement of intent even if its first character
    // happens to be `{`.
    expect(detectFormat('roster.csv', '{"users":[]}')).toBe('csv');
    expect(detectFormat('roster.json', 'email,full_name')).toBe('json');
  });

  it('falls back to the first non-blank character', () => {
    expect(detectFormat('pasted', '  \n[{"email":"a@b.test"}]')).toBe('json');
    expect(detectFormat('pasted', '{"users":[]}')).toBe('json');
    expect(detectFormat('pasted', 'email,full_name\na@b.test,A B')).toBe('csv');
  });

  it('treats an empty paste as CSV', () => {
    // So the server reports it as a header problem rather than a parse failure.
    expect(detectFormat('pasted', '')).toBe('csv');
  });

  it('is case-insensitive about the extension', () => {
    expect(detectFormat('ROSTER.CSV', '')).toBe('csv');
  });
});

describe('building the request body', () => {
  it('sends a CSV through untouched', () => {
    // Column matching is by header name, case- and whitespace-insensitively —
    // a parser here would put that rule in two places.
    const built = buildBulkRequest('csv', CSV);

    expect(built).toEqual({
      ok: true,
      rows: 2,
      request: { format: 'csv', content: CSV },
    });
  });

  it('accepts a bare JSON list and the endpoint’s own envelope alike', () => {
    const users = [{ email: 'gita@acme.test', full_name: 'Gita Rao' }];

    expect(buildBulkRequest('json', JSON.stringify(users))).toMatchObject({
      ok: true,
      request: { format: 'json', users },
    });
    expect(buildBulkRequest('json', JSON.stringify({ users }))).toMatchObject({
      ok: true,
      request: { format: 'json', users },
    });
  });

  it('does not judge the rows', () => {
    // Every row's verdict is the report's, per row. Refusing a malformed one
    // here would deny the operator the row-by-row answer they came for.
    const built = buildBulkRequest(
      'json',
      JSON.stringify([{ email: 'not-an-email' }, { nonsense: true }]),
    );

    expect(built.ok).toBe(true);
  });

  it('refuses text that is not JSON at all', () => {
    const built = buildBulkRequest('json', '{ "users": [ , ] }');

    expect(built.ok).toBe(false);
    if (!built.ok) expect(built.problem).toMatch(/not valid JSON/i);
  });

  it('refuses JSON that is not a list of people', () => {
    const built = buildBulkRequest('json', '{"roster":{"gita":true}}');

    expect(built.ok).toBe(false);
    if (!built.ok) expect(built.problem).toMatch(/list of people/i);
  });

  it('refuses a CSV with a header and nobody in it', () => {
    const built = buildBulkRequest('csv', 'email,full_name\n\n  \n');

    expect(built.ok).toBe(false);
    if (!built.ok) expect(built.problem).toMatch(/no people/i);
  });

  it('refuses an empty document before it is sent', () => {
    expect(buildBulkRequest('csv', '   ').ok).toBe(false);
    expect(buildBulkRequest('json', '').ok).toBe(false);
  });

  it('refuses a file over the published ceiling, and names it', () => {
    const rows = MAX_BULK_USER_ROWS + 1;
    const csv = [
      'email,full_name',
      ...Array.from({ length: rows }, (_, i) => `p${i}@acme.test,Person ${i}`),
    ].join('\n');

    const built = buildBulkRequest('csv', csv);

    expect(built.ok).toBe(false);
    if (!built.ok) {
      expect(built.problem).toContain(String(rows));
      expect(built.problem).toContain(String(MAX_BULK_USER_ROWS));
    }
  });

  it('accepts a file exactly at the ceiling', () => {
    const csv = [
      'email,full_name',
      ...Array.from(
        { length: MAX_BULK_USER_ROWS },
        (_, i) => `p${i}@acme.test,Person ${i}`,
      ),
    ].join('\n');

    expect(buildBulkRequest('csv', csv)).toMatchObject({
      ok: true,
      rows: MAX_BULK_USER_ROWS,
    });
  });
});

describe('counting CSV data rows', () => {
  it('discounts the header and blank lines', () => {
    expect(countCsvDataRows(CSV)).toBe(2);
    expect(countCsvDataRows('email\n\na@b.test\n\n')).toBe(1);
  });

  it('handles CRLF, which is what a spreadsheet writes', () => {
    expect(countCsvDataRows('email\r\na@b.test\r\nc@d.test\r\n')).toBe(2);
  });

  it('is zero for a header alone', () => {
    expect(countCsvDataRows('email,full_name')).toBe(0);
  });
});

describe('the template', () => {
  it('shows a filled row and an empty optional cell', () => {
    // A template with only headers leaves "what may `status` contain?"
    // unanswered, and `phone` being optional unshown.
    const [header, first] = CSV_TEMPLATE.split('\n');

    expect(header).toBe('email,full_name,phone,status');
    expect(first).toContain(',,active');
  });

  it('parses back as two data rows', () => {
    expect(countCsvDataRows(CSV_TEMPLATE)).toBe(2);
  });
});

describe('the report', () => {
  const results: BulkUserRowResult[] = [
    { row: 1, email: 'a@acme.test', status: 'created', user_id: 'u1' },
    { row: 2, email: 'b@acme.test', status: 'skipped', reason: 'already exists', user_id: null },
    { row: 3, email: null, status: 'errored', reason: 'email: required', user_id: null },
  ];

  it('filters by outcome, and “all” keeps file order', () => {
    expect(filterResults(results, 'all').map((r) => r.row)).toEqual([1, 2, 3]);
    expect(filterResults(results, 'errored').map((r) => r.row)).toEqual([3]);
    expect(filterResults(results, 'created')).toHaveLength(1);
  });

  it('exports every row, not only the failures', () => {
    // The report is the file with a verdict column, which is only true if the
    // created rows are in it.
    const csv = resultsToCsv(results).split('\n');

    expect(csv[0]).toBe('row,email,status,reason,user_id');
    expect(csv).toHaveLength(4);
    expect(csv[1]).toBe('1,a@acme.test,created,,u1');
  });

  it('escapes a reason containing a comma or a quote', () => {
    const csv = resultsToCsv([
      {
        row: 1,
        email: 'a@acme.test',
        status: 'errored',
        reason: 'status: expected "active", got "on"',
        user_id: null,
      },
    ]);

    expect(csv).toContain('"status: expected ""active"", got ""on"""');
  });

  it('writes an empty cell where the row had no address', () => {
    expect(resultsToCsv([results[2]])).toContain('3,,errored,');
  });
});
