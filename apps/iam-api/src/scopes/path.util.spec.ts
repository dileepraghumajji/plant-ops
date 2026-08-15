/**
 * The path rules of Doc 01 §3.5, stated as tests.
 *
 * Two of these are the session's acceptance criteria in miniature — labels are
 * id-derived even for hostile names, and a rewrite is a *label*-wise prefix
 * substitution — and the reason they are worth testing here as well as against
 * Postgres is that they are the specification the SQL is written to satisfy. The
 * integration suite proves the database agrees; this proves what it is agreeing
 * with.
 */

import { MAX_SCOPE_TREE_DEPTH, SCOPE_PATH_LABEL_PREFIX } from '@plantops/contracts';
import { scopePathLabel } from '@plantops/db';
import { randomUUID } from 'node:crypto';
import {
  childPath,
  depthAfterMove,
  isDepthAllowed,
  isWithin,
  pathDepth,
  rewritePrefix,
  rootPath,
} from './path.util';

/** ltree's own rule: `[A-Za-z0-9_]`, and never leading with a digit. */
const LEGAL_LABEL = /^[A-Za-z_][A-Za-z0-9_]*$/;

describe('scope path labels', () => {
  it('derives every label from the id, never from the name', () => {
    const id = randomUUID();

    // The functions take no name, which is the actual guarantee — there is no
    // argument through which one could reach a path. This states the
    // consequence: the label is a pure function of the id.
    expect(rootPath(id)).toBe(`${SCOPE_PATH_LABEL_PREFIX}${id.replace(/-/g, '')}`);
    expect(rootPath(id)).toBe(scopePathLabel(id));
  });

  it('produces ltree-legal labels for ids that start with a digit', () => {
    // The prefix exists for exactly this: a bare hex uuid may begin with a
    // digit, which ltree rejects outright.
    const numeric = '9f2c4a1b-0000-4000-8000-000000000000';
    expect(rootPath(numeric)).toMatch(LEGAL_LABEL);
    expect(rootPath(numeric).startsWith(SCOPE_PATH_LABEL_PREFIX)).toBe(true);
  });

  it('builds a child path by appending one label to the parent', () => {
    const parent = randomUUID();
    const child = randomUUID();

    expect(childPath(rootPath(parent), child)).toBe(
      `${scopePathLabel(parent)}.${scopePathLabel(child)}`,
    );
    expect(pathDepth(childPath(rootPath(parent), child))).toBe(2);
  });
});

describe('coverage — `path <@ prefix`', () => {
  const group = scopePathLabel(randomUUID());
  const plant = scopePathLabel(randomUUID());
  const gate = scopePathLabel(randomUUID());

  it('covers the prefix itself and everything beneath it', () => {
    expect(isWithin(group, group)).toBe(true);
    expect(isWithin(`${group}.${plant}`, group)).toBe(true);
    expect(isWithin(`${group}.${plant}.${gate}`, `${group}.${plant}`)).toBe(true);
  });

  it('does not cover a sibling whose label merely starts the same way', () => {
    // A character-wise `startsWith` would say yes here, and saying yes is how a
    // coverage test grants access to a subtree the binding never named.
    expect(isWithin('n_abcd', 'n_ab')).toBe(false);
    expect(isWithin('n_ab.n_cd', 'n_a')).toBe(false);
  });

  it('does not cover an ancestor', () => {
    expect(isWithin(group, `${group}.${plant}`)).toBe(false);
  });
});

describe('rewritePrefix — what a move does to a subtree', () => {
  const oldParent = scopePathLabel(randomUUID());
  const newParent = scopePathLabel(randomUUID());
  const plant = scopePathLabel(randomUUID());
  const department = scopePathLabel(randomUUID());
  const gate = scopePathLabel(randomUUID());

  const plantPath = `${oldParent}.${plant}`;

  it('re-hangs the moved node while keeping its own label', () => {
    expect(rewritePrefix(plantPath, plantPath, newParent)).toBe(
      `${newParent}.${plant}`,
    );
  });

  it('keeps every descendant`s tail below the moved node', () => {
    const gatePath = `${plantPath}.${department}.${gate}`;

    expect(rewritePrefix(gatePath, plantPath, newParent)).toBe(
      `${newParent}.${plant}.${department}.${gate}`,
    );
  });

  it('preserves each node`s own label, which is what the check constraint pins', () => {
    // Migration 0003 requires the last label of a path to be `n_` + that row's
    // id. A rewrite that shifted labels would be rejected by the database; this
    // is the same claim, made before the statement runs.
    const gatePath = `${plantPath}.${department}.${gate}`;
    const rewritten = rewritePrefix(gatePath, plantPath, newParent);

    expect(rewritten.split('.').at(-1)).toBe(gate);
  });

  it('refuses a path outside the subtree being moved', () => {
    expect(() => rewritePrefix(`${oldParent}.${gate}`, plantPath, newParent)).toThrow();
  });
});

describe('depth bounds', () => {
  it('measures the tree a move would produce', () => {
    // A two-level subtree (a plant with departments) hung under a node at
    // depth 3 makes a tree five levels deep.
    expect(depthAfterMove(3, 2)).toBe(5);
  });

  it('allows exactly the documented maximum and nothing beyond it', () => {
    expect(isDepthAllowed(MAX_SCOPE_TREE_DEPTH)).toBe(true);
    expect(isDepthAllowed(MAX_SCOPE_TREE_DEPTH + 1)).toBe(false);
  });
});
