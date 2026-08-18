/**
 * The CSV writer, over plain values (Doc 10 §7).
 *
 * Two claims are worth a suite of their own, and neither is about the database.
 * The first is RFC 4180 conformance, which is the difference between a file a
 * spreadsheet opens correctly and one it opens *plausibly* — a mis-escaped quote
 * shifts every subsequent column and nothing announces it. The second is formula
 * neutralisation, which is a security property of an export whose values were
 * supplied by whoever was being audited.
 */

import { AUDIT_EXPORT_COLUMNS, type AuditRecordDTO } from '@plantops/contracts';
import { auditCsv, csvField, csvRow } from './audit-csv';

const RECORD: AuditRecordDTO = {
  id: '11111111-1111-4111-8111-111111111111',
  client_id: '22222222-2222-4222-8222-222222222222',
  actor_type: 'user',
  actor_id: '33333333-3333-4333-8333-333333333333',
  action: 'user.disabled',
  target_type: 'user',
  target_id: '44444444-4444-4444-8444-444444444444',
  payload: { before: 'active', after: 'disabled' },
  created_at: '2026-08-18T09:00:00.000Z',
};

describe('csvField — RFC 4180', () => {
  it('leaves an ordinary value alone', () => {
    expect(csvField('user.disabled')).toBe('user.disabled');
  });

  it('quotes a value containing the delimiter', () => {
    expect(csvField('Acme, Inc')).toBe('"Acme, Inc"');
  });

  it('quotes and doubles an embedded quote', () => {
    // The rule that shifts every later column when it is got wrong.
    expect(csvField('say "hello"')).toBe('"say ""hello"""');
  });

  it.each([['\n'], ['\r\n']])('quotes a value containing a newline (%j)', (eol) => {
    expect(csvField(`two${eol}lines`)).toBe(`"two${eol}lines"`);
  });

  it('writes null and empty as an empty field, not as the word', () => {
    // The nullable columns mean "there was nothing to name" (Doc 10 §2), and an
    // empty cell is how a spreadsheet says that. `null` would read as a value.
    expect(csvField(null)).toBe('');
    expect(csvField('')).toBe('');
  });
});

describe('csvField — formula injection (the reason this file exists)', () => {
  it.each([
    ['=', "=cmd|'/c calc'!A1"],
    ['+', '+1+1'],
    ['-', '-1+1'],
    ['@', '@SUM(A1)'],
    ['tab', '\tSUM(A1)'],
  ])('prefixes a value beginning with %s so it stays text', (_lead, value) => {
    const written = csvField(value);
    // Either bare or quoted, but always with the text prefix ahead of the
    // character a spreadsheet would otherwise evaluate.
    expect(written.replace(/^"/, '')).toMatch(/^'/);
  });

  it('does not touch a value that merely contains one of them', () => {
    // The lead character is what a spreadsheet dispatches on. Prefixing every
    // value containing a `-` would mangle every ISO timestamp in the file.
    expect(csvField('2026-08-18T09:00:00.000Z')).toBe('2026-08-18T09:00:00.000Z');
    expect(csvField('a=b')).toBe('a=b');
  });

  it('still escapes a guarded value that also needs quoting', () => {
    expect(csvField('=a,b')).toBe(`"'=a,b"`);
  });
});

describe('auditCsv', () => {
  it('leads with the published column order', () => {
    const [header] = auditCsv([]).split('\r\n');
    expect(header).toBe(csvRow([...AUDIT_EXPORT_COLUMNS]));
  });

  it('writes the header even when nothing matched', () => {
    // An empty file and a file of zero records are different claims, and only
    // the second one is true.
    expect(auditCsv([])).toBe(`${csvRow([...AUDIT_EXPORT_COLUMNS])}\r\n`);
  });

  it('writes one CRLF-terminated row per record, in column order', () => {
    const rows = auditCsv([RECORD]).split('\r\n');

    expect(rows[1]).toBe(
      [
        RECORD.id,
        RECORD.created_at,
        RECORD.client_id,
        RECORD.actor_type,
        RECORD.actor_id,
        RECORD.action,
        RECORD.target_type,
        RECORD.target_id,
        '"{""before"":""active"",""after"":""disabled""}"',
      ].join(','),
    );
    // Terminated, not merely separated: appending chunks must not need to know
    // whether the previous one ended a line.
    expect(rows[rows.length - 1]).toBe('');
  });

  it('empties the cells of a platform-level record rather than naming them', () => {
    const platform: AuditRecordDTO = {
      ...RECORD,
      client_id: null,
      actor_type: 'platform',
      actor_id: null,
      target_type: null,
      target_id: null,
      payload: {},
    };

    const [, row] = auditCsv([platform]).split('\r\n');
    expect(row).toBe(
      `${platform.id},${platform.created_at},,platform,,${platform.action},,,{}`,
    );
  });

  it('carries a hostile payload through as text', () => {
    // The value was recorded faithfully and must be re-emitted faithfully — and
    // inertly. Both halves matter: the reviewer has to be able to see what was
    // sent.
    const hostile: AuditRecordDTO = {
      ...RECORD,
      payload: { full_name: '=HYPERLINK("http://evil","click")' },
    };

    const csv = auditCsv([hostile]);
    expect(csv).toContain('HYPERLINK');
    expect(csv).not.toMatch(/,=/);
  });
});
