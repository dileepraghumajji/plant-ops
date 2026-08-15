/**
 * The scope-tree request schemas (Doc 06 §6).
 *
 * These run without a database, and they pin the shape rules of a node: what a
 * caller may name, and — far more importantly — what a caller may **not** send.
 * The behaviour that needs Postgres, which is nearly all of this session, is
 * `scopes.integration.spec.ts`.
 */

import { createScopeNodeSchema, updateScopeNodeSchema } from './dto/scopes.dto';

const PARENT = '00000000-0000-4000-8000-000000000001';

describe('scope-tree request schemas', () => {
  describe('POST /iam/scopes', () => {
    it('accepts a node under a parent', () => {
      const parsed = createScopeNodeSchema.parse({
        parent_id: PARENT,
        kind: 'plant',
        name: 'Plant B',
      });

      expect(parsed).toEqual({ parent_id: PARENT, kind: 'plant', name: 'Plant B' });
    });

    it('accepts a root — no parent named', () => {
      // Whether the tenant is *allowed* one is a question about rows, which the
      // service answers; the schema's job is only to let the body express it.
      const parsed = createScopeNodeSchema.parse({ kind: 'group', name: 'Acme' });

      expect('parent_id' in parsed).toBe(false);
    });

    it('strips the fields that would let a caller place a node by hand', () => {
      const parsed = createScopeNodeSchema.parse({
        parent_id: PARENT,
        kind: 'gate',
        name: 'Gate 3',
        id: '00000000-0000-4000-8000-000000000002',
        client_id: '00000000-0000-4000-8000-000000000003',
        path: 'n_deadbeef.n_cafebabe',
      });

      // `path` above all: a caller who could write it could hang a node under
      // another tenant's subtree, at which point RLS is enforcing a lie.
      expect(parsed).toEqual({ parent_id: PARENT, kind: 'gate', name: 'Gate 3' });
    });

    it.each([
      ['a name that is only whitespace', { kind: 'plant', name: '   ' }],
      ['no name', { kind: 'plant' }],
      ['no kind', { name: 'Plant B' }],
      ['a kind the enum does not have', { kind: 'region', name: 'South' }],
      ['a parent that is not a uuid', { parent_id: 'root', kind: 'gate', name: 'G' }],
    ])('refuses %s', (_case, body) => {
      expect(createScopeNodeSchema.safeParse(body).success).toBe(false);
    });

    it.each(['Plant B', 'Gate-3', "O'Brien Works", 'ప్లాంట్', 'a.b.c', 'n_deadbeef'])(
      'accepts the hostile display name %p, because a name never reaches the path',
      (name) => {
        expect(createScopeNodeSchema.safeParse({ kind: 'gate', name }).success).toBe(
          true,
        );
      },
    );
  });

  describe('PATCH /iam/scopes/:id', () => {
    it('accepts a rename, a move, or both', () => {
      expect(updateScopeNodeSchema.parse({ name: 'Plant C' })).toEqual({
        name: 'Plant C',
      });
      expect(updateScopeNodeSchema.parse({ parent_id: PARENT })).toEqual({
        parent_id: PARENT,
      });
      expect(
        updateScopeNodeSchema.parse({ name: 'Plant C', parent_id: PARENT }),
      ).toEqual({ name: 'Plant C', parent_id: PARENT });
    });

    it('refuses an empty body', () => {
      // A 200 that audited a change nobody made would be worse than the 400.
      expect(updateScopeNodeSchema.safeParse({}).success).toBe(false);
    });

    it('refuses a null parent — a node is never detached into a second root', () => {
      expect(updateScopeNodeSchema.safeParse({ parent_id: null }).success).toBe(false);
    });

    it('strips kind, metadata and path', () => {
      const parsed = updateScopeNodeSchema.parse({
        name: 'Plant C',
        kind: 'gate',
        metadata: { note: 'x' },
        path: 'n_deadbeef',
      });

      // Doc 06 §6 makes this endpoint "rename / move", and Doc 10 §4 gives the
      // scope tree no action under which any other edit could be recorded.
      expect(parsed).toEqual({ name: 'Plant C' });
    });
  });
});
