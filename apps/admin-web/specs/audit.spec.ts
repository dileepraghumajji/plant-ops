import type { AuditRecordDTO } from '@plantops/contracts';

import {
  NO_AUDIT_FILTERS,
  actionDomain,
  actionOptions,
  describeActor,
  hasAuditFilters,
  hasPayload,
  isPlatformLevel,
  toAuditQuery,
} from '../src/lib/audit';

function record(
  overrides: Partial<AuditRecordDTO> & Pick<AuditRecordDTO, 'id' | 'action'>,
): AuditRecordDTO {
  return {
    client_id: 'c1',
    actor_type: 'user',
    actor_id: 'u1',
    target_type: 'role',
    target_id: 'r1',
    payload: {},
    created_at: '2026-08-18T09:00:00.000Z',
    ...overrides,
  };
}

describe('turning filters into a query', () => {
  it('sends nothing when nothing is filled in', () => {
    expect(toAuditQuery(NO_AUDIT_FILTERS)).toEqual({});
    expect(hasAuditFilters(NO_AUDIT_FILTERS)).toBe(false);
  });

  it('treats a blank field as absent, not as an empty filter', () => {
    // `?action=` would match nothing, and a screen whose cleared box silently
    // emptied the table is one an operator stops trusting.
    expect(toAuditQuery({ ...NO_AUDIT_FILTERS, action: '   ' })).toEqual({});
  });

  it('trims what it does send', () => {
    expect(toAuditQuery({ ...NO_AUDIT_FILTERS, action: ' auth.login.success ' })).toEqual(
      { action: 'auth.login.success' },
    );
  });

  it('composes every filter', () => {
    expect(
      toAuditQuery({
        actorId: 'u1',
        actorType: 'service_account',
        action: 'role_binding.created',
        targetType: 'role_binding',
        targetId: 'b1',
        fromLocal: '',
        toLocal: '',
      }),
    ).toEqual({
      actor_id: 'u1',
      actor_type: 'service_account',
      action: 'role_binding.created',
      target_type: 'role_binding',
      target_id: 'b1',
    });
  });

  it('converts a local wall-clock range to instants', () => {
    // The endpoint compares half-open against ISO-8601 with an offset. Sending
    // the raw `datetime-local` value would shift a compliance window by the
    // operator's UTC offset.
    const local = '2026-08-18T00:00';
    const query = toAuditQuery({ ...NO_AUDIT_FILTERS, fromLocal: local });

    expect(query.from).toBe(new Date(local).toISOString());
  });

  it('drops a date it cannot read rather than getting stuck', () => {
    // The picker cannot produce one; refusing here would leave a screen with no
    // way back to a result.
    expect(toAuditQuery({ ...NO_AUDIT_FILTERS, toLocal: 'yesterday' })).toEqual({});
  });

  it('notices that something is filtered', () => {
    expect(hasAuditFilters({ ...NO_AUDIT_FILTERS, actorType: 'platform' })).toBe(true);
    expect(hasAuditFilters({ ...NO_AUDIT_FILTERS, fromLocal: '2026-08-18T00:00' })).toBe(
      true,
    );
  });
});

describe('reading a record', () => {
  it('takes the domain from the first dotted segment', () => {
    expect(actionDomain('auth.login.success')).toBe('auth');
    expect(actionDomain('application.manifest.upserted')).toBe('application');
  });

  it('copes with an action that has no dot', () => {
    // The trail outlives the catalog that wrote it; a row from a version that
    // spelled actions differently still has to render.
    expect(actionDomain('legacy')).toBe('legacy');
  });

  it('suggests the distinct actions on screen, sorted', () => {
    const rows = [
      record({ id: '1', action: 'user.locked' }),
      record({ id: '2', action: 'auth.login.success' }),
      record({ id: '3', action: 'user.locked' }),
    ];

    expect(actionOptions(rows)).toEqual(['auth.login.success', 'user.locked']);
  });

  it('names an actor even when there is no subject to name', () => {
    // `platform.bootstrap` runs before any subject exists, and a failed login
    // names an account that may have matched nothing. An empty cell would read
    // as missing data rather than as the fact it is.
    const bootstrap = record({
      id: '1',
      action: 'platform.bootstrap',
      actor_type: 'platform',
      actor_id: null,
    });

    expect(describeActor(bootstrap)).toEqual({ label: 'Platform', id: null });
    expect(describeActor(record({ id: '2', action: 'x' }))).toEqual({
      label: 'User',
      id: 'u1',
    });
    expect(
      describeActor(record({ id: '3', action: 'x', actor_type: 'service_account' })).label,
    ).toBe('Service account');
  });

  it('marks a row that belongs to no tenant', () => {
    expect(isPlatformLevel(record({ id: '1', action: 'x', client_id: null }))).toBe(true);
    expect(isPlatformLevel(record({ id: '2', action: 'x' }))).toBe(false);
  });

  it('only offers the drawer when there is something in it', () => {
    expect(hasPayload(record({ id: '1', action: 'x' }))).toBe(false);
    expect(hasPayload(record({ id: '2', action: 'x', payload: { added: [] } }))).toBe(
      true,
    );
  });
});
