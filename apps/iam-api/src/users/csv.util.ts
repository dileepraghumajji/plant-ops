/**
 * A CSV reader, for the `csv` arm of `POST /iam/users/bulk` (Doc 06 §8).
 *
 * ## Why this is hand-written
 *
 * Because the alternative is a dependency whose failure mode is silence. Every
 * general-purpose CSV library in the ecosystem is configurable to the point of
 * ambiguity — relaxed quoting, guessed delimiters, coerced types, rows dropped
 * or padded depending on a flag — and the whole point of this endpoint is a
 * report that says exactly what happened to each row. A reader that quietly
 * repairs a malformed line produces a report that is wrong about the one thing
 * an operator is reading it for. The grammar below is RFC 4180 with two stated
 * accommodations, it is about a hundred lines, and `csv.util.spec.ts` covers it
 * case by case.
 *
 * ## The grammar
 *
 * Fields are comma-separated. A field may be quoted with `"`, in which case it
 * may contain commas, line breaks, and `""` for a literal quote. An unquoted
 * field runs to the next comma or line break and is taken literally — a `"` in
 * the middle of one is a quote character, not the start of quoting, because a
 * name like `Jo"n` is a typo to report rather than a document to refuse.
 *
 * The two accommodations, both because real files come out of spreadsheets:
 *
 * - **Any line ending.** `\r\n`, `\n` and a bare `\r` all end a row. RFC 4180
 *   says `\r\n`; a file that has been through a Mac, a Windows editor and a
 *   `git` checkout has been through three opinions about that.
 * - **Blank lines are not rows.** A wholly empty line is skipped rather than
 *   read as one empty field. Exports routinely end with one, and an operator
 *   who left a gap between two shifts should not get a spurious `errored` row
 *   for it. Skipped lines take no row number, so {@link CsvRecord.row} still
 *   counts people and {@link CsvRecord.line} still points at the editor's
 *   gutter.
 *
 * ## What it does not do
 *
 * It does not know what a user is: no column is special, nothing is coerced, and
 * the header is returned as it was read. Mapping columns to fields and deciding
 * what a row *means* belongs to `bulk-upload.service.ts`, which is where the
 * per-row verdicts are formed — a parser that also validated would have to
 * invent a second vocabulary for the same failures.
 *
 * It also imposes no size bound. The caller does: `bulkUserUploadSchema` bounds
 * the document's length and `MAX_BULK_USER_ROWS` its row count, both before this
 * runs (`dto/users.dto.ts`).
 */

/** One data row. */
export interface CsvRecord {
  /** 1-based among data rows — the header is not row 1, and blank lines are not rows. */
  row: number;
  /** 1-based line in the file, so a message can point at where to look. */
  line: number;
  /** The fields, unquoted and unescaped, exactly as many as the line held. */
  values: readonly string[];
}

export interface CsvTable {
  /** The first non-blank line's fields, trimmed and lowercased. */
  headers: readonly string[];
  records: readonly CsvRecord[];
}

/**
 * A document that cannot be read as CSV at all.
 *
 * Distinct from a row this parser read but the caller rejects: this is the whole
 * file, and it is what `bulk-upload.service.ts` turns into a `400`. An
 * unterminated quote swallows every line after it, so there is no honest way to
 * report the rest of the document row by row.
 */
export class CsvParseError extends Error {
  constructor(message: string, readonly line: number) {
    super(message);
    this.name = 'CsvParseError';
  }
}

/** The byte-order mark a Windows spreadsheet writes in front of a UTF-8 file. */
const BOM = '\uFEFF';

/**
 * Reads `content` into a header and its data rows.
 *
 * Headers are trimmed and lowercased here rather than by the caller, because
 * header matching is case-insensitive on this surface (Doc 06 §8) and doing it
 * once at the boundary means no consumer can forget to. Field *values* are
 * returned untouched — trimming an address is `users.dto.ts`'s job, and doing it
 * twice would hide which layer is responsible for it.
 *
 * @throws {CsvParseError} when the document is not CSV: an unterminated quoted
 * field, text after a closing quote, or no header line at all.
 */
export function parseCsv(content: string): CsvTable {
  const lines = readLines(content.startsWith(BOM) ? content.slice(BOM.length) : content);

  const header = lines[0];
  if (header === undefined) {
    throw new CsvParseError(
      'The CSV is empty. The first line must be a header naming the columns.',
      1,
    );
  }

  return {
    headers: header.values.map((value) => value.trim().toLowerCase()),
    records: lines.slice(1).map((line, index) => ({
      row: index + 1,
      line: line.line,
      values: line.values,
    })),
  };
}

/** A physical line's fields, with the line number it started on. */
interface ParsedLine {
  line: number;
  values: string[];
}

/**
 * The scanner.
 *
 * One pass over the string with an explicit index rather than a split-then-fix
 * approach, because a quoted field may contain both the delimiter and the line
 * break — which is exactly the case a `split('\n').map(split(','))` reader gets
 * wrong, and gets wrong silently.
 */
function readLines(content: string): ParsedLine[] {
  const lines: ParsedLine[] = [];

  let values: string[] = [];
  let field = '';
  let lineNumber = 1;
  let startedOn = 1;
  let index = 0;
  /**
   * Whether anything at all has been read for the current line.
   *
   * Not the same as `field !== '' || values.length > 0`, which is what makes it
   * worth a variable: a line consisting of `""` — one explicitly quoted empty
   * field — leaves both of those falsy and is nevertheless a row, while a wholly
   * empty line leaves them falsy and is not.
   */
  let pending = false;
  /**
   * Whether nothing has been consumed for the current *field* yet.
   *
   * This is what makes quoting positional, which RFC 4180 requires and which the
   * header calls out: a `"` here opens a quoted field, and a `"` anywhere else is
   * an ordinary character. Without it `Jo"n` — a typo the report should name row
   * by row — would open a quoted field that swallows the rest of the document and
   * turn the whole upload into a `400`.
   */
  let atFieldStart = true;

  /** Ends the current line, discarding it when nothing was read for it. */
  const endLine = (): void => {
    if (pending) {
      values.push(field);
      lines.push({ line: startedOn, values });
    }
    values = [];
    field = '';
    pending = false;
    atFieldStart = true;
  };

  while (index < content.length) {
    const char = content[index];

    // Anything but a line break is content for the current line — including a
    // bare comma, which is a row of two empty fields rather than a blank one.
    if (char !== '\r' && char !== '\n') pending = true;

    if (char === '"' && atFieldStart) {
      const quoted = readQuotedField(content, index + 1, lineNumber);
      field += quoted.value;
      lineNumber = quoted.line;
      index = quoted.next;
      atFieldStart = false;

      // Anything but a delimiter or a line break after the closing quote means
      // the field was never really quoted, and guessing which reading was meant
      // is how a misaligned row becomes a plausible-looking user.
      const after = content[index];
      if (after !== undefined && after !== ',' && after !== '\n' && after !== '\r') {
        throw new CsvParseError(
          `Unexpected text after a closing quote on line ${lineNumber}. A quoted ` +
            'field must be followed by a comma or the end of the line, and a ' +
            'literal quote inside one is written as "".',
          lineNumber,
        );
      }
      continue;
    }

    if (char === ',') {
      values.push(field);
      field = '';
      atFieldStart = true;
      index += 1;
      continue;
    }

    if (char === '\r' || char === '\n') {
      endLine();
      // `\r\n` is one ending, not two.
      index += char === '\r' && content[index + 1] === '\n' ? 2 : 1;
      lineNumber += 1;
      startedOn = lineNumber;
      continue;
    }

    field += char;
    atFieldStart = false;
    index += 1;
  }

  // A file that does not end with a newline still ends its last row; one that
  // does has already flushed it, and `pending` is false so this does nothing.
  endLine();

  return lines;
}

/** Reads from just past an opening quote to just past its closing one. */
function readQuotedField(
  content: string,
  from: number,
  startLine: number,
): { value: string; next: number; line: number } {
  let value = '';
  let index = from;
  let line = startLine;

  while (index < content.length) {
    const char = content[index];

    if (char === '"') {
      // `""` is an escaped quote; a lone `"` closes the field.
      if (content[index + 1] === '"') {
        value += '"';
        index += 2;
        continue;
      }
      return { value, next: index + 1, line };
    }

    if (char === '\n') line += 1;
    if (char === '\r' && content[index + 1] !== '\n') line += 1;

    value += char;
    index += 1;
  }

  throw new CsvParseError(
    `A quoted field opened on line ${startLine} is never closed. Every " that ` +
      'opens a field needs a matching one, and a literal quote inside a field ' +
      'is written as "".',
    startLine,
  );
}
