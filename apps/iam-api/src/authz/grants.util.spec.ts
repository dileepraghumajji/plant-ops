/**
 * The resolution algorithm of Doc 04 §4, stated as tests.
 *
 * This is the half of Session 21's correctness matrix that needs no database:
 * minimization, assembly, and the point check are functions over sets of
 * strings, and the SQL's only job is to hand them the right rows.
 * `authz.integration.spec.ts` proves Postgres produces those rows; this proves
 * what is done with them, which is where the algorithm actually lives.
 *
 * The paths are written as short label chains rather than real `n_<hex>` ones,
 * because every function here is label-wise and nothing depends on the label
 * *shape* — `path.util.spec.ts` is where that is pinned. Reading `a.b.c` beats
 * reading two hundred hex characters when the point of the case is which node
 * is beneath which.
 */

import {
  assembleGrants,
  grantsCover,
  minimizePaths,
  sliceGrants,
  type GrantRow,
} from './grants.util';

/** `group → plantA → gate1/gate2`, plus a sibling plant. Doc 04 §3's example. */
const GROUP = 'g';
const PLANT_A = 'g.pa';
const PLANT_B = 'g.pb';
const GATE_1 = 'g.pa.gate1';
const GATE_2 = 'g.pa.gate2';
const GATE_3 = 'g.pb.gate3';

const APPROVE = 'gatepass.dc.approve';
const CREATE = 'gatepass.dc.create';

const row = (permission_key: string, scope_path: string): GrantRow => ({
  permission_key,
  scope_path,
});

describe('minimizePaths — Doc 04 §4.1', () => {
  it('keeps a single path', () => {
    expect(minimizePaths([PLANT_A])).toEqual([PLANT_A]);
  });

  it('drops a descendant when its ancestor is present', () => {
    // The rule itself: the binding at Plant A already covers Gate 1 via `<@`,
    // so carrying the gate as well says nothing and costs a comparison on
    // every point check.
    expect(minimizePaths([PLANT_A, GATE_1])).toEqual([PLANT_A]);
    expect(minimizePaths([GATE_1, PLANT_A])).toEqual([PLANT_A]);
  });

  it('drops a whole chain down to its topmost ancestor', () => {
    expect(minimizePaths([GATE_1, PLANT_A, GROUP])).toEqual([GROUP]);
  });

  it('keeps siblings, which cover nothing of each other', () => {
    expect(minimizePaths([PLANT_A, PLANT_B])).toEqual([PLANT_A, PLANT_B]);
    expect(minimizePaths([GATE_1, GATE_2])).toEqual([GATE_1, GATE_2]);
  });

  it('keeps a duplicate exactly once rather than eliminating both', () => {
    // The bug this function is most likely to have. `isWithin` is reflexive, so
    // a rule phrased as "drop anything another path covers" removes both copies
    // and leaves the permission with no path at all — silently revoking access
    // the subject holds twice.
    expect(minimizePaths([PLANT_A, PLANT_A])).toEqual([PLANT_A]);
    expect(minimizePaths([PLANT_A, PLANT_A, GATE_1])).toEqual([PLANT_A]);
  });

  it('does not treat a label prefix as an ancestor', () => {
    // Character-wise, `g.pa` starts with `g.p`. Label-wise it does not lie
    // beneath it, and a `startsWith` implementation would collapse two
    // unrelated subtrees into one grant.
    expect(minimizePaths(['g.p', 'g.pa'])).toEqual(['g.p', 'g.pa']);
    expect(minimizePaths(['g.pa', 'g.pab'])).toEqual(['g.pa', 'g.pab']);
  });

  it('returns nothing for nothing', () => {
    expect(minimizePaths([])).toEqual([]);
  });

  it('is order-independent and sorted', () => {
    // The result is serialized into a cache entry and compared against a
    // version counter, so two resolutions of the same grants must produce
    // identical bytes.
    expect(minimizePaths([PLANT_B, GATE_1, PLANT_A])).toEqual(
      minimizePaths([PLANT_A, PLANT_B, GATE_1]),
    );
    expect(minimizePaths([PLANT_B, PLANT_A])).toEqual([PLANT_A, PLANT_B]);
  });

  it('never changes what is covered', () => {
    // The property that makes minimization safe rather than merely tidy: every
    // node covered before is covered after.
    const raw = [GROUP, PLANT_A, GATE_1, PLANT_B];
    const minimal = minimizePaths(raw);

    for (const target of [GROUP, PLANT_A, PLANT_B, GATE_1, GATE_2, GATE_3]) {
      const before = raw.some((path) => target === path || target.startsWith(`${path}.`));
      const after = minimal.some(
        (path) => target === path || target.startsWith(`${path}.`),
      );
      expect(after).toBe(before);
    }
  });
});

describe('assembleGrants — Doc 04 §4.1', () => {
  it('is the deny-by-default answer when there are no bindings', () => {
    expect(assembleGrants([])).toEqual({ permissions: [], scopes: {} });
  });

  it('groups paths by permission and minimizes each independently', () => {
    const grants = assembleGrants([
      row(APPROVE, PLANT_A),
      row(APPROVE, GATE_1),
      row(CREATE, GATE_1),
      row(CREATE, GATE_2),
    ]);

    expect(grants.scopes[APPROVE]).toEqual([PLANT_A]);
    expect(grants.scopes[CREATE]).toEqual([GATE_1, GATE_2]);
  });

  it('keeps the flat list and the map keys in step', () => {
    const grants = assembleGrants([row(APPROVE, PLANT_A), row(CREATE, PLANT_B)]);

    expect(grants.permissions).toEqual(Object.keys(grants.scopes));
    expect(grants.permissions).toEqual([APPROVE, CREATE]);
  });

  it('produces the same value whatever order the rows arrive in', () => {
    const forwards = assembleGrants([
      row(CREATE, GATE_2),
      row(APPROVE, GATE_1),
      row(APPROVE, PLANT_A),
    ]);
    const backwards = assembleGrants([
      row(APPROVE, PLANT_A),
      row(APPROVE, GATE_1),
      row(CREATE, GATE_2),
    ]);

    expect(JSON.stringify(forwards)).toBe(JSON.stringify(backwards));
  });
});

describe('grantsCover — the point check, Doc 04 §4.2', () => {
  const grants = assembleGrants([row(APPROVE, PLANT_A), row(CREATE, GATE_3)]);

  it('covers the bound node itself', () => {
    expect(grantsCover(grants, APPROVE, PLANT_A)).toBe(true);
  });

  it('covers every descendant of the bound node', () => {
    // The payoff of the physical-scope dimension: one binding at the plant
    // covers its gates with no extra rows (Doc 04 §3).
    expect(grantsCover(grants, APPROVE, GATE_1)).toBe(true);
    expect(grantsCover(grants, APPROVE, GATE_2)).toBe(true);
  });

  it('does not cover an ancestor of the bound node', () => {
    // Coverage runs downwards only. A grant at Plant A is not a grant at the
    // group that contains it.
    expect(grantsCover(grants, APPROVE, GROUP)).toBe(false);
  });

  it('does not cover a sibling subtree', () => {
    expect(grantsCover(grants, APPROVE, PLANT_B)).toBe(false);
    expect(grantsCover(grants, APPROVE, GATE_3)).toBe(false);
  });

  it('preserves the permission asymmetry — `dc.approve` does not imply `dc.create`', () => {
    // Doc 04 §9, and the single most important negative in the file: inheritance
    // exists on the scope dimension and nowhere else.
    expect(grantsCover(grants, APPROVE, GATE_1)).toBe(true);
    expect(grantsCover(grants, CREATE, GATE_1)).toBe(false);
  });

  it('refuses a permission the subject does not hold at all', () => {
    expect(grantsCover(grants, 'gatepass.dc.delete', PLANT_A)).toBe(false);
  });

  it('refuses everything when the subject holds nothing', () => {
    const nothing = assembleGrants([]);
    expect(grantsCover(nothing, APPROVE, PLANT_A)).toBe(false);
    expect(grantsCover(nothing, APPROVE, GROUP)).toBe(false);
  });

  it('does not treat a label prefix as coverage', () => {
    const prefixed = assembleGrants([row(APPROVE, 'g.p')]);
    expect(grantsCover(prefixed, APPROVE, 'g.pa')).toBe(false);
    expect(grantsCover(prefixed, APPROVE, 'g.p.a')).toBe(true);
  });
});

describe('sliceGrants — the `?applicationId=` projection', () => {
  const grants = assembleGrants([row(APPROVE, PLANT_A), row('visitor.read', GROUP)]);

  it('keeps only the named keys, with their paths intact', () => {
    expect(sliceGrants(grants, [APPROVE])).toEqual({
      permissions: [APPROVE],
      scopes: { [APPROVE]: [PLANT_A] },
    });
  });

  it('ignores keys the subject does not hold', () => {
    expect(sliceGrants(grants, [CREATE])).toEqual({ permissions: [], scopes: {} });
  });
});
