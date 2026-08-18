/**
 * The read surface's decisions that need no database (Doc 06 §12, Doc 10 §7).
 *
 * Three of them, and each is a claim the live suite would prove slowly and
 * incompletely:
 *
 * - **the surface is `GET`-only**, which is Doc 10 §7's "no mutate/delete
 *   endpoint by design" — a design statement, so it is asserted against the
 *   routing metadata rather than by observing that nobody wrote a `POST`;
 * - **the filter DTO refuses what it should**, which decides whether a
 *   mistyped action comes back as a 400 or as a silently empty page;
 * - **`auditFilter` composes**, which decides whether the four filters of
 *   Doc 06 §12 narrow together or shadow each other.
 *
 * What only a real Postgres can decide — that a client admin sees their own
 * tenant's rows and a platform admin sees everything — is
 * `audit-read.integration.spec.ts`. Nothing about RLS can be proved against a
 * fake.
 */

import { REQUIRE_PERMISSION_METADATA } from '@plantops/auth-kit';
import type { PermissionRequirement } from '@plantops/auth-kit';
import { AUDIT_EXPORT_MAX_ROWS, type AuditRecordDTO } from '@plantops/contracts';
import { scanController } from '../openapi/openapi';
import { AuditExportService } from './audit-export.service';
import { AuditQueryService, auditFilter } from './audit-query.service';
import { AuditController } from './audit.controller';
import type { AuditService } from './audit.service';
import { auditExportQuerySchema, auditQuerySchema } from './dto/audit.dto';

describe('the audit surface is read-only (Doc 10 §7)', () => {
  const routes = scanController(AuditController);

  it('exposes exactly the page and the export', () => {
    expect(routes.map((route) => `${route.verb} ${route.path}`)).toEqual([
      'get /iam/audit',
      'get /iam/audit/export',
    ]);
  });

  it('declares no verb that could change a row', () => {
    // The claim is about the *design*, so it is asserted over whatever routes
    // the class carries rather than over the two named above: a `DELETE` added
    // later fails here even if somebody updates the list in the case above.
    expect(routes.every((route) => route.verb === 'get')).toBe(true);
  });

  it('gates both routes on either tier’s audit key', () => {
    // Doc 06 §12 heads the section `iam.*.audit.read`. Both routes, the same
    // pair: a reader who may see the page may take the export of it, and the
    // two cannot drift apart.
    for (const route of routes) {
      const requirement = Reflect.getMetadata(
        REQUIRE_PERMISSION_METADATA,
        (AuditController.prototype as unknown as Record<string, object>)[
          route.handlerName
        ],
      ) as PermissionRequirement;

      expect(requirement.permissions).toEqual([
        'iam.client.audit.read',
        'iam.platform.audit.read',
      ]);
      // No scope: the trail is not anchored to the org tree, and tenant
      // visibility comes from RLS rather than from coverage (Doc 04 §10).
      expect(requirement.scopeFrom).toBeUndefined();
    }
  });
});

describe('the filter DTO (Doc 06 §12)', () => {
  it('accepts a request with no filters at all', () => {
    expect(auditQuerySchema.parse({})).toEqual({});
  });

  it('coerces the page out of the query string', () => {
    expect(auditQuerySchema.parse({ page: '2', limit: '50' })).toEqual({
      page: 2,
      limit: 50,
    });
  });

  it('refuses an action outside the catalog', () => {
    // A filter is a question, and `user.diabled` has one honest answer. A 400
    // gives it immediately; an empty page never would (`dto/audit.dto.ts`).
    expect(auditQuerySchema.safeParse({ action: 'user.diabled' }).success).toBe(false);
    expect(auditQuerySchema.safeParse({ action: 'user.disabled' }).success).toBe(true);
  });

  it('refuses a target type no writer can produce', () => {
    expect(auditQuerySchema.safeParse({ target_type: 'gatepass' }).success).toBe(false);
    expect(auditQuerySchema.safeParse({ target_type: 'user' }).success).toBe(true);
  });

  it('refuses a date without a zone', () => {
    // An audit range whose meaning depends on the reader's timezone is one
    // whose answer nobody else can reproduce.
    expect(auditQuerySchema.safeParse({ from: '2026-08-18' }).success).toBe(false);
    expect(
      auditQuerySchema.safeParse({ from: '2026-08-18T00:00:00Z' }).success,
    ).toBe(true);
    expect(
      auditQuerySchema.safeParse({ from: '2026-08-18T00:00:00+05:30' }).success,
    ).toBe(true);
  });

  it('strips a key nobody declared', () => {
    // `z.object` strips. Worth an assertion here because the thing a caller
    // would most plausibly try to smuggle in is a second predicate.
    expect(auditQuerySchema.parse({ actor_type: 'user', sql: '1=1' })).toEqual({
      actor_type: 'user',
    });
  });

  it('gives the export no page to ignore', () => {
    // An export is of the whole filter or it is refused, so `?limit=25` must not
    // be quietly accepted and dropped (`audit-export.service.ts`).
    expect(auditExportQuerySchema.parse({ limit: '25', actor_type: 'user' })).toEqual({
      actor_type: 'user',
    });
  });
});

describe('auditFilter — the predicate behind both routes', () => {
  it('is a legal statement with nothing filtered', () => {
    expect(auditFilter()).toEqual({ where: 'true', parameters: [] });
  });

  it('composes every filter with and, numbering the parameters in order', () => {
    const { where, parameters } = auditFilter({
      actor_id: 'a',
      actor_type: 'user',
      action: 'user.disabled',
      target_type: 'user',
      target_id: 't',
      client_id: 'c',
      from: '2026-08-01T00:00:00Z',
      to: '2026-09-01T00:00:00Z',
    });

    expect(parameters).toEqual([
      'a',
      'user',
      'user.disabled',
      'user',
      't',
      'c',
      '2026-08-01T00:00:00Z',
      '2026-09-01T00:00:00Z',
    ]);
    expect(where).toContain('actor_id = $1::uuid');
    expect(where).toContain('action = $3');
    expect(where).toContain('client_id = $6::uuid');
    // Half-open, so consecutive ranges neither overlap nor drop an instant.
    expect(where).toContain('created_at >= $7::timestamptz');
    expect(where).toContain('created_at < $8::timestamptz');
    expect(where.split(' and ')).toHaveLength(9);
  });

  it('renumbers when only some filters are present', () => {
    // The failure this rules out is a positional bug: an arm that hard-coded its
    // own index would bind the wrong value the moment an earlier one is absent.
    const { where, parameters } = auditFilter({ action: 'auth.logout' });

    expect(where).toBe('true and action = $1');
    expect(parameters).toEqual(['auth.logout']);
  });

  it('passes no value through as SQL text', () => {
    // Every arm interpolates a `$n` placeholder and nothing else. The values
    // reach Postgres as parameters, so a filter cannot carry a predicate.
    const { where, parameters } = auditFilter({ action: "x' or '1'='1" });

    expect(where).not.toContain("or '1'");
    expect(parameters).toEqual(["x' or '1'='1"]);
  });
});

/**
 * The export's row cap, over fakes (Doc 10 §7).
 *
 * The cap is the one behaviour of `AuditExportService` that a live suite cannot
 * reach without seeding ten thousand and one audit rows — so it is asserted
 * against a query service that simply says how many there are. What the fakes
 * make visible in exchange is the property that matters most: a refused export
 * writes **no** `audit.exported`, because there was no export.
 */
describe('AuditExportService — complete or refused, never truncated', () => {
  const queryService = (total: number, records: AuditRecordDTO[] = []) =>
    ({
      count: jest.fn(() => Promise.resolve(total)),
      chunk: jest.fn(() => Promise.resolve(records)),
    }) as unknown as AuditQueryService;

  const auditService = () =>
    ({ record: jest.fn(() => Promise.resolve()) }) as unknown as AuditService;

  it('refuses a filter matching more than the cap, and names the count', async () => {
    const audit = auditService();
    const service = new AuditExportService(
      queryService(AUDIT_EXPORT_MAX_ROWS + 1),
      audit,
    );

    await expect(service.export({})).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    // The count is in the message because the caller has to know how much to
    // narrow by; "too many" alone is not actionable.
    await expect(service.export({})).rejects.toMatchObject({
      details: [
        { message: expect.stringContaining(String(AUDIT_EXPORT_MAX_ROWS + 1)) },
      ],
    });
    // Nothing was exported, so nothing is recorded as having been.
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('exports at exactly the cap', async () => {
    // The boundary is inclusive: `> MAX` refuses, `= MAX` is the largest
    // complete answer the endpoint will give.
    const service = new AuditExportService(
      queryService(AUDIT_EXPORT_MAX_ROWS),
      auditService(),
    );

    await expect(service.export({})).resolves.toContain('id,created_at');
  });

  it('records the row count and the filter it ran', async () => {
    const audit = auditService();
    const service = new AuditExportService(queryService(0), audit);

    await service.export({ action: 'auth.logout' });

    expect(audit.record).toHaveBeenCalledWith(
      'audit.exported',
      { type: 'audit', id: null },
      { rows: 0, filter: { action: 'auth.logout' } },
    );
  });
});
