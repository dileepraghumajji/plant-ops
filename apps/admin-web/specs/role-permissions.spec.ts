import type { RolePermissionDTO } from '@plantops/contracts';

import {
  buildPicker,
  filterPicker,
  inertReason,
  matchesSearch,
  selectionChanged,
} from '../src/lib/role-permissions';

function permission(
  overrides: Partial<RolePermissionDTO> & Pick<RolePermissionDTO, 'id' | 'key'>,
): RolePermissionDTO {
  return {
    name: overrides.key,
    description: null,
    is_active: true,
    application_id: 'app-gatepass',
    application_key: 'gatepass',
    application_name: 'Gate Pass',
    application_enabled: true,
    ...overrides,
  };
}

const create = permission({ id: 'p1', key: 'gatepass.dc.create', name: 'Create DC' });
const approve = permission({ id: 'p2', key: 'gatepass.dc.approve', name: 'Approve DC' });
const visitorIssue = permission({
  id: 'p3',
  key: 'visitor.pass.issue',
  name: 'Issue pass',
  application_id: 'app-visitor',
  application_key: 'visitor',
  application_name: 'Visitor',
});

/** Mapped once, then the application was switched off for this tenant. */
const inertByApp = permission({
  id: 'p4',
  key: 'weighbridge.ticket.print',
  name: 'Print ticket',
  application_id: 'app-weigh',
  application_key: 'weighbridge',
  application_name: 'Weighbridge',
  application_enabled: false,
});

/** Mapped once, then a manifest retired the key. */
const inertByRetirement = permission({
  id: 'p5',
  key: 'gatepass.dc.void',
  name: 'Void DC',
  is_active: false,
});

describe('why a mapped permission grants nothing', () => {
  it('says nothing about a live one', () => {
    expect(inertReason(create)).toBeNull();
  });

  it('blames the disabled application first', () => {
    // Both can be true at once; the application is the one the admin can act on,
    // and re-enabling it restores everything at a stroke (Doc 02 §7).
    expect(inertReason({ ...inertByApp, is_active: false })).toBe('application-disabled');
  });

  it('blames the retired key when the application is fine', () => {
    expect(inertReason(inertByRetirement)).toBe('permission-retired');
  });
});

describe('building the picker', () => {
  it('groups by application and marks what the role holds', () => {
    const groups = buildPicker([create, approve, visitorIssue], [approve]);

    expect(groups.map((group) => group.applicationName)).toEqual([
      'Gate Pass',
      'Visitor',
    ]);
    expect(
      groups[0].permissions.map((row) => [row.permission.id, row.selected]),
    ).toEqual([
      ['p1', false],
      ['p2', true],
    ]);
  });

  it('keeps a mapped permission the catalog cannot offer', () => {
    // The failure this merge exists to prevent: hiding it would show the role as
    // smaller than it is, and a save would silently unmap what was never shown.
    const groups = buildPicker([create], [create, inertByApp]);

    const weighbridge = groups.find((group) => group.applicationKey === 'weighbridge');
    expect(weighbridge?.permissions).toHaveLength(1);
    expect(weighbridge?.permissions[0]).toMatchObject({
      selected: true,
      inert: 'application-disabled',
    });
  });

  it('marks a retired key inert without disowning its group', () => {
    const groups = buildPicker([create], [create, inertByRetirement]);

    const gatepass = groups[0];
    expect(gatepass.inert).toBe(false);
    expect(
      gatepass.permissions.find((row) => row.permission.id === 'p5')?.inert,
    ).toBe('permission-retired');
  });

  it('sorts inert groups last, where the decisions are not', () => {
    const groups = buildPicker([visitorIssue], [inertByApp, visitorIssue]);

    expect(groups.map((group) => group.applicationKey)).toEqual([
      'visitor',
      'weighbridge',
    ]);
    expect(groups[1].inert).toBe(true);
  });

  it('lets the catalog’s copy of a row win over the role’s', () => {
    // Both endpoints return the same permission; the catalog's is the one whose
    // flags describe the present.
    const stale = { ...create, is_active: false };
    const groups = buildPicker([create], [stale]);

    expect(groups[0].permissions[0].permission.is_active).toBe(true);
    expect(groups[0].permissions[0].selected).toBe(true);
  });

  it('is empty when the tenant has nothing enabled and the role holds nothing', () => {
    expect(buildPicker([], [])).toEqual([]);
  });
});

describe('searching the picker', () => {
  const groups = buildPicker([create, approve, visitorIssue], []);

  it('matches a key, a name and an application', () => {
    expect(matchesSearch(create, 'dc.create')).toBe(true);
    expect(matchesSearch(create, 'Create DC')).toBe(true);
    expect(matchesSearch(create, 'gate pass')).toBe(true);
    expect(matchesSearch(create, 'weighbridge')).toBe(false);
  });

  it('keeps a whole group when its name matches', () => {
    // "show me Gate Pass" is a different request from "show me rows containing
    // the word", and a picker that answered the second would hide most of the
    // group the operator just asked for.
    const filtered = filterPicker(groups, 'Gate Pass');

    expect(filtered).toHaveLength(1);
    expect(filtered[0].permissions).toHaveLength(2);
  });

  it('narrows within a group when only rows match', () => {
    const filtered = filterPicker(groups, 'approve');

    expect(filtered).toHaveLength(1);
    expect(filtered[0].permissions.map((row) => row.permission.id)).toEqual(['p2']);
  });

  it('drops a group with nothing to show rather than rendering it empty', () => {
    expect(filterPicker(groups, 'nothing-matches-this')).toEqual([]);
  });

  it('returns everything for a blank term', () => {
    expect(filterPicker(groups, '   ')).toHaveLength(2);
  });
});

describe('whether a save would do anything', () => {
  it('is false for the set the role already holds', () => {
    // A no-op PUT writes nothing and audits nothing, so the button stays
    // disabled rather than teaching the operator that pressing it did something.
    expect(selectionChanged([create, approve], new Set(['p1', 'p2']))).toBe(false);
  });

  it('does not depend on order', () => {
    expect(selectionChanged([create, approve], new Set(['p2', 'p1']))).toBe(false);
  });

  it('is true when one is added, removed, or swapped', () => {
    expect(selectionChanged([create], new Set(['p1', 'p2']))).toBe(true);
    expect(selectionChanged([create, approve], new Set(['p1']))).toBe(true);
    expect(selectionChanged([create], new Set(['p2']))).toBe(true);
  });

  it('is true when clearing a role that carried something', () => {
    expect(selectionChanged([create], new Set())).toBe(true);
  });

  it('is false for a role that carries nothing and still does', () => {
    expect(selectionChanged([], new Set())).toBe(false);
  });
});
