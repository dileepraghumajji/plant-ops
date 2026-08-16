/**
 * The CSV grammar, case by case (`csv.util.ts`).
 *
 * These run without a database and without an application, because everything
 * they assert is a property of the reader alone. That matters more here than for
 * most units: `bulk-upload.service.ts` promises a per-row verdict, and a verdict
 * is only as trustworthy as the reader's account of which row is which. A parser
 * that silently mis-splits one line makes the whole report wrong in a way no
 * integration test would notice — every row would still get a verdict.
 *
 * The `\r\n` cases are written with explicit escapes rather than by relying on
 * this file's own line endings, which a `.gitattributes` or an editor can
 * change under them.
 */

import { CsvParseError, parseCsv } from './csv.util';

describe('parseCsv', () => {
  describe('the header', () => {
    it('lowercases and trims it, because matching is by name', () => {
      const { headers } = parseCsv('  Email , FULL_NAME ,phone\na@b.test,A B,1');

      expect(headers).toEqual(['email', 'full_name', 'phone']);
    });

    it('strips a UTF-8 BOM, which is what a Windows spreadsheet writes', () => {
      // Left in place, the first column would be named U+FEFF followed by
      // "email", and every row would report a missing address — for a byte
      // nobody can see. Written as an escape, since a literal one in this file
      // is exactly as invisible here as it is in a CSV.
      const { headers } = parseCsv('\uFEFFemail,full_name\na@b.test,A B');

      expect(headers).toEqual(['email', 'full_name']);
    });

    it('refuses an empty document', () => {
      expect(() => parseCsv('')).toThrow(CsvParseError);
      expect(() => parseCsv('\n\n')).toThrow(CsvParseError);
    });

    it('reads a header with no rows after it', () => {
      expect(parseCsv('email,full_name').records).toEqual([]);
    });
  });

  describe('rows', () => {
    it('numbers data rows from one, so row 1 is the first person', () => {
      const { records } = parseCsv('email,full_name\na@b.test,A\nc@d.test,C');

      expect(records.map(({ row, line }) => ({ row, line }))).toEqual([
        { row: 1, line: 2 },
        { row: 2, line: 3 },
      ]);
    });

    it('does not trim values — that is the field schema’s job', () => {
      const { records } = parseCsv('email,full_name\n  a@b.test , A B ');

      expect(records[0].values).toEqual(['  a@b.test ', ' A B ']);
    });

    it('reads a last row that has no trailing newline', () => {
      expect(parseCsv('email\na@b.test').records).toHaveLength(1);
    });

    it('does not invent a row from a trailing newline', () => {
      expect(parseCsv('email\na@b.test\n').records).toHaveLength(1);
    });

    it('keeps empty fields, including a line of nothing but commas', () => {
      const { records } = parseCsv('email,full_name,phone\n,,');

      expect(records[0].values).toEqual(['', '', '']);
    });

    it('reads a row narrower than the header without padding it', () => {
      // The caller decides what a missing trailing column means; a reader that
      // padded would be answering that question on its behalf.
      expect(parseCsv('email,full_name,phone\na@b.test,A').records[0].values).toEqual([
        'a@b.test',
        'A',
      ]);
    });

    it('reads a row wider than the header, leaving the mismatch to the caller', () => {
      expect(parseCsv('email,full_name\na@b.test,A,extra').records[0].values).toEqual([
        'a@b.test',
        'A',
        'extra',
      ]);
    });
  });

  describe('blank lines', () => {
    it('skips them without spending a row number', () => {
      const { records } = parseCsv('email\n\na@b.test\n\n\nc@d.test\n');

      expect(records).toEqual([
        { row: 1, line: 3, values: ['a@b.test'] },
        { row: 2, line: 6, values: ['c@d.test'] },
      ]);
    });

    it('does not treat an explicitly quoted empty field as a blank line', () => {
      // `""` is a row with one empty field; a bare empty line is not a row. The
      // difference is invisible in the values and matters to the row numbering.
      const { records } = parseCsv('email\n""\na@b.test');

      expect(records.map(({ row, values }) => ({ row, values }))).toEqual([
        { row: 1, values: [''] },
        { row: 2, values: ['a@b.test'] },
      ]);
    });
  });

  describe('line endings', () => {
    it.each([
      ['LF', '\n'],
      ['CRLF', '\r\n'],
      ['CR', '\r'],
    ])('reads %s', (_case, ending) => {
      const { records } = parseCsv(
        ['email,full_name', 'a@b.test,A', 'c@d.test,C'].join(ending),
      );

      expect(records.map(({ values }) => values)).toEqual([
        ['a@b.test', 'A'],
        ['c@d.test', 'C'],
      ]);
    });

    it('counts CRLF as one ending, not two', () => {
      const { records } = parseCsv('email\r\na@b.test\r\nc@d.test');

      expect(records.map(({ line }) => line)).toEqual([2, 3]);
    });
  });

  describe('quoting', () => {
    it('keeps a delimiter inside a quoted field', () => {
      const { records } = parseCsv('full_name,email\n"Rao, Gita",g@acme.test');

      expect(records[0].values).toEqual(['Rao, Gita', 'g@acme.test']);
    });

    it('keeps a line break inside a quoted field, and the row starts where it opened', () => {
      const { records } = parseCsv('note,email\n"line one\nline two",g@acme.test\nx,y@z.test');

      expect(records[0].values).toEqual(['line one\nline two', 'g@acme.test']);
      // Row 2 begins on line 4, because row 1 spanned lines 2 and 3.
      expect(records.map(({ row, line }) => ({ row, line }))).toEqual([
        { row: 1, line: 2 },
        { row: 2, line: 4 },
      ]);
    });

    it('unescapes a doubled quote', () => {
      const { records } = parseCsv('full_name\n"She said ""go"""');

      expect(records[0].values).toEqual(['She said "go"']);
    });

    it('reads an empty quoted field', () => {
      expect(parseCsv('email,phone\n"a@b.test",""').records[0].values).toEqual([
        'a@b.test',
        '',
      ]);
    });

    it('treats a quote inside an unquoted field as an ordinary character', () => {
      // A name like `Jo"n` is a typo for the report to name, not a document to
      // refuse — quoting only begins at the start of a field.
      expect(parseCsv('full_name\nJo"n').records[0].values).toEqual(['Jo"n']);
    });

    it('refuses an unterminated quoted field, naming the line it opened on', () => {
      let thrown: unknown;
      try {
        parseCsv('email,full_name\na@b.test,A\nc@d.test,"never closed');
      } catch (error) {
        thrown = error;
      }

      // The whole rest of the document is inside that field, so there is no
      // honest row-by-row account of it to give — it is a `400`, not a report.
      expect(thrown).toBeInstanceOf(CsvParseError);
      expect((thrown as CsvParseError).line).toBe(3);
    });

    it('refuses text after a closing quote', () => {
      expect(() => parseCsv('full_name\n"Rao"Gita')).toThrow(CsvParseError);
    });
  });
});
