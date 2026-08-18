import type { ResolvedGrants } from '@plantops/contracts';

import {
  anyPathCovers,
  holdsPermission,
  holdsPermissionAt,
  pathCovers,
  permissionScopes,
} from './scope-coverage';

// Labels are `n_` + UUID hex (Doc 01 §3.5); shortened here for readability.
const GROUP = 'n_aa';
const PLANT_B = 'n_aa.n_bb';
const GATE_3 = 'n_aa.n_bb.n_c3';
const PLANT_A = 'n_aa.n_a1';

describe('pathCovers', () => {
  it('covers the node itself', () => {
    expect(pathCovers(PLANT_B, PLANT_B)).toBe(true);
  });

  /** Doc 04 §4.2: a binding at Plant B reaches its gates. */
  it('covers descendants', () => {
    expect(pathCovers(PLANT_B, GATE_3)).toBe(true);
    expect(pathCovers(GROUP, GATE_3)).toBe(true);
  });

  it('does not cover ancestors or siblings', () => {
    expect(pathCovers(PLANT_B, GROUP)).toBe(false);
    expect(pathCovers(PLANT_B, PLANT_A)).toBe(false);
  });

  /**
   * The separator is what makes the prefix test a *tree* test. Without it
   * `n_aa` would appear to cover `n_aab`, a different subtree entirely — the
   * one bug a hand-rolled `startsWith` always has.
   */
  it('does not treat a label prefix as an ancestor', () => {
    expect(pathCovers('n_aa', 'n_aab')).toBe(false);
    expect(pathCovers('n_aa', 'n_aab.n_cc')).toBe(false);
  });

  it('treats an empty path as covering nothing', () => {
    expect(pathCovers('', GATE_3)).toBe(false);
    expect(pathCovers(GROUP, '')).toBe(false);
  });
});

describe('anyPathCovers', () => {
  it('is true when any granted path reaches the target', () => {
    expect(anyPathCovers([PLANT_A, PLANT_B], GATE_3)).toBe(true);
  });

  it('is false for an empty grant set', () => {
    expect(anyPathCovers([], GATE_3)).toBe(false);
  });
});

describe('grant lookups', () => {
  const grants: ResolvedGrants = {
    permissions: ['dc.approve', 'dc.read'],
    scopes: {
      'dc.approve': [PLANT_B],
      'dc.read': [GROUP],
    },
  };

  it('reports a held permission', () => {
    expect(holdsPermission(grants, 'dc.approve')).toBe(true);
    expect(holdsPermission(grants, 'dc.create')).toBe(false);
  });

  /**
   * Permission asymmetry survives (Doc 04 §5): holding `dc.approve` says
   * nothing about `dc.create`, and holding it at Plant B says nothing about
   * Plant A.
   */
  it('reports a permission at a node, respecting the tree', () => {
    expect(holdsPermissionAt(grants, 'dc.approve', GATE_3)).toBe(true);
    expect(holdsPermissionAt(grants, 'dc.approve', PLANT_A)).toBe(false);
    expect(holdsPermissionAt(grants, 'dc.create', GATE_3)).toBe(false);
  });

  it('answers false for everything before grants have loaded', () => {
    // The deliberate default: showing a control and removing it is worse than
    // showing it a moment late.
    expect(holdsPermission(undefined, 'dc.read')).toBe(false);
    expect(holdsPermissionAt(undefined, 'dc.read', GATE_3)).toBe(false);
    expect(permissionScopes(undefined, 'dc.read')).toEqual([]);
  });

  it('returns the covering paths for query narrowing', () => {
    expect(permissionScopes(grants, 'dc.read')).toEqual([GROUP]);
    expect(permissionScopes(grants, 'dc.create')).toEqual([]);
  });
});
