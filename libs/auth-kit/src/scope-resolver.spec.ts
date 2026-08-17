/**
 * The coverage matrix Doc 08 §7 asks for by name: *"unit tests for
 * coverage/scope logic (the highest-risk code — test the `covers()` prefix logic
 * and deny-by-default thoroughly)"*.
 *
 * Everything here is three strings and a record. That is the point of the split
 * `scope-resolver.ts` makes: Doc 04 §3–5 is a statement about *sets of paths*,
 * and a case that seeds a tree to assert it would be testing Postgres as well,
 * more slowly, and would stop being written once the setup outgrew the claim.
 *
 * The paths are shortened for legibility (`g`, `g.a`, `g.a.1`). Real ones are
 * `n_<uuid hex>` labels (Doc 01 §3.5); nothing in the algorithm reads a label's
 * contents, and using readable ones is what makes a failing case's message tell
 * you which subtree it was about.
 */

import type { ResolvedGrants } from '@plantops/contracts';
import {
  AuthorizationOutcome,
  ScopeResolver,
  allowedPathsFor,
  coversPath,
  holdsPermission,
  pathIsWithin,
  type AuthorizationSnapshot,
  type GrantsSource,
  type SubjectClaims,
} from './scope-resolver';

const CLAIMS: SubjectClaims = {
  sub: 'subject-1',
  sty: 'user',
  cid: 'client-1',
  sid: 'session-1',
};

const APPROVE = 'gatepass.dc.approve';
const CREATE = 'gatepass.dc.create';

/** A subject bound at Plant A, holding one permission. */
const PLANT_A: ResolvedGrants = {
  permissions: [APPROVE],
  scopes: { [APPROVE]: ['g.a'] },
};

/** Doc 04 §9's answer for a subject with no bindings. */
const NOTHING: ResolvedGrants = { permissions: [], scopes: {} };

describe('pathIsWithin — Doc 04 §3 coverage', () => {
  it('a node is within itself: `covers` is reflexive', () => {
    expect(pathIsWithin('g.a', 'g.a')).toBe(true);
  });

  it('a descendant is within its ancestor, at any depth', () => {
    expect(pathIsWithin('g.a.1', 'g.a')).toBe(true);
    expect(pathIsWithin('g.a.1.x', 'g')).toBe(true);
  });

  it('an ancestor is **not** within its descendant', () => {
    expect(pathIsWithin('g.a', 'g.a.1')).toBe(false);
  });

  it('a sibling is not within a sibling', () => {
    expect(pathIsWithin('g.b', 'g.a')).toBe(false);
  });

  // The bug this function exists to make impossible. A `startsWith` without the
  // separator reports `g.ab` as living under `g.a`, which is one subtree
  // reaching into another's data with no row anywhere saying so.
  it('compares label-wise, so a shared prefix is not containment', () => {
    expect(pathIsWithin('g.ab', 'g.a')).toBe(false);
    expect(pathIsWithin('gate.a', 'g')).toBe(false);
  });
});

describe('coversPath — Doc 04 §4.2 point check', () => {
  it('grants at the bound node itself', () => {
    expect(coversPath(PLANT_A, APPROVE, 'g.a')).toBe(true);
  });

  it('grants at every node beneath it, with no extra rows', () => {
    expect(coversPath(PLANT_A, APPROVE, 'g.a.1')).toBe(true);
    expect(coversPath(PLANT_A, APPROVE, 'g.a.1.inner')).toBe(true);
  });

  it('denies a sibling subtree', () => {
    expect(coversPath(PLANT_A, APPROVE, 'g.b')).toBe(false);
  });

  it('denies the ancestor of the bound node', () => {
    expect(coversPath(PLANT_A, APPROVE, 'g')).toBe(false);
  });

  // Doc 04 §9's asymmetry, in one case: scope inherits downwards, the
  // permission dimension inherits not at all.
  it('does not carry one permission over to another at the same node', () => {
    expect(coversPath(PLANT_A, CREATE, 'g.a')).toBe(false);
  });

  it('is false for a subject with no bindings, everywhere', () => {
    expect(coversPath(NOTHING, APPROVE, 'g')).toBe(false);
    expect(coversPath(NOTHING, APPROVE, 'g.a.1')).toBe(false);
  });

  it('accepts a target covered by any one of several bindings', () => {
    const two: ResolvedGrants = {
      permissions: [APPROVE],
      scopes: { [APPROVE]: ['g.a', 'g.c'] },
    };
    expect(coversPath(two, APPROVE, 'g.c.9')).toBe(true);
    expect(coversPath(two, APPROVE, 'g.b')).toBe(false);
  });
});

describe('holdsPermission / allowedPathsFor', () => {
  it('reports the flat permission list', () => {
    expect(holdsPermission(PLANT_A, APPROVE)).toBe(true);
    expect(holdsPermission(PLANT_A, CREATE)).toBe(false);
  });

  // Doc 04 §5. A module puts this straight into `<@ ANY($1)`, so an empty array
  // must mean "no rows" — which it does, because `= ANY('{}')` matches nothing.
  it('hands back the covering paths for query narrowing', () => {
    expect(allowedPathsFor(PLANT_A, APPROVE)).toEqual(['g.a']);
  });

  it('is an empty array — never undefined — for a permission not held', () => {
    expect(allowedPathsFor(PLANT_A, CREATE)).toEqual([]);
    expect(allowedPathsFor(NOTHING, APPROVE)).toEqual([]);
  });
});

describe('ScopeResolver.decide — the rule PermissionGuard enforces', () => {
  /** A source that answers from a fixed grant set and a fixed node table. */
  const sourceOf = (
    grants: ResolvedGrants,
    tree: Record<string, string> = {},
  ): GrantsSource => ({
    authorize: (_claims, scopeNodeId): Promise<AuthorizationSnapshot> =>
      Promise.resolve(
        scopeNodeId === undefined
          ? { grants }
          : { grants, targetPath: tree[scopeNodeId] ?? null },
      ),
  });

  const resolve = (grants: ResolvedGrants, tree?: Record<string, string>) =>
    new ScopeResolver(sourceOf(grants, tree));

  it('allows an unscoped route when the permission is held', async () => {
    const decision = await resolve(PLANT_A).decide(CLAIMS, { permission: APPROVE });
    expect(decision.outcome).toBe(AuthorizationOutcome.ALLOWED);
  });

  // Deny-by-default (Doc 04 §9), which is the property with no code of its own:
  // an empty grant set falls out of the membership test, not out of a branch.
  it('denies deny-by-default: no binding, no access', async () => {
    const decision = await resolve(NOTHING).decide(CLAIMS, { permission: APPROVE });
    expect(decision.outcome).toBe(AuthorizationOutcome.PERMISSION_DENIED);
  });

  it('reports PERMISSION_DENIED before it ever looks at the scope', async () => {
    const decision = await resolve(PLANT_A, { n1: 'g.a' }).decide(
      CLAIMS,
      { permission: CREATE, scopeFrom: 'params.id' },
      'n1',
    );
    // Not SCOPE_DENIED: the subject would not hold it anywhere, and telling them
    // "not here" would imply there is a "here" that would work.
    expect(decision.outcome).toBe(AuthorizationOutcome.PERMISSION_DENIED);
  });

  it('allows a scoped route at a covered node', async () => {
    const decision = await resolve(PLANT_A, { gate1: 'g.a.1' }).decide(
      CLAIMS,
      { permission: APPROVE, scopeFrom: 'params.id' },
      'gate1',
    );
    expect(decision).toEqual({
      outcome: AuthorizationOutcome.ALLOWED,
      permission: APPROVE,
      scopeNodeId: 'gate1',
    });
  });

  it('reports SCOPE_DENIED when the permission is held elsewhere', async () => {
    const decision = await resolve(PLANT_A, { gate9: 'g.b.9' }).decide(
      CLAIMS,
      { permission: APPROVE, scopeFrom: 'params.id' },
      'gate9',
    );
    expect(decision.outcome).toBe(AuthorizationOutcome.SCOPE_DENIED);
  });

  // A node this subject cannot see is not a coverage question: the handler runs
  // under the same RLS context, finds nothing, and answers the 404 or 409
  // Doc 06 §2 fixes for it. Refusing here would move a status code on every
  // scoped route and reveal exactly as much.
  it('defers an invisible node to the handler rather than refusing it', async () => {
    const decision = await resolve(PLANT_A, {}).decide(
      CLAIMS,
      { permission: APPROVE, scopeFrom: 'params.id' },
      'somebody-elses-node',
    );
    expect(decision.outcome).toBe(AuthorizationOutcome.ALLOWED);
  });

  it('refuses a scoped route whose request named no node', async () => {
    const decision = await resolve(PLANT_A).decide(CLAIMS, {
      permission: APPROVE,
      scopeFrom: 'body.scope_node_id',
    });
    expect(decision.outcome).toBe(AuthorizationOutcome.SCOPE_DENIED);
  });

  it('permits the absence where the route said absence is legitimate', async () => {
    const decision = await resolve(PLANT_A).decide(CLAIMS, {
      permission: APPROVE,
      scopeFrom: 'body.parent_id',
      scopeOptional: true,
    });
    expect(decision.outcome).toBe(AuthorizationOutcome.ALLOWED);
  });

  it('does not ask the source for a path the route never wanted', async () => {
    const authorize = jest.fn(() => Promise.resolve({ grants: PLANT_A }));
    const resolver = new ScopeResolver({ authorize });

    await resolver.decide(CLAIMS, { permission: APPROVE });

    expect(authorize).toHaveBeenCalledWith(CLAIMS, undefined);
  });

  it('exposes allowedPaths and covers over the same source', async () => {
    const resolver = resolve(PLANT_A, { gate1: 'g.a.1', gate9: 'g.b.9' });

    await expect(resolver.allowedPaths(CLAIMS, APPROVE)).resolves.toEqual(['g.a']);
    await expect(resolver.covers(CLAIMS, APPROVE, 'gate1')).resolves.toBe(true);
    await expect(resolver.covers(CLAIMS, APPROVE, 'gate9')).resolves.toBe(false);
    // `covers` is the point check, not the guard: an unknown node is `false`
    // here, the way `POST /iam/permissions/check` answers it.
    await expect(resolver.covers(CLAIMS, APPROVE, 'unknown')).resolves.toBe(false);
  });
});
