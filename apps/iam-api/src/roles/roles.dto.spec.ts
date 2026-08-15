/**
 * The role request schemas (Doc 06 §7).
 *
 * These run without a database, and they pin the shape rules of a role: what a
 * caller may name, and — far more importantly — what a caller may **not** send.
 * The behaviour that needs Postgres, which is nearly all of this session's rules
 * about enabled applications and cascading deletes, is
 * `roles.integration.spec.ts`.
 */

import { MAX_PERMISSIONS_PER_ROLE } from '@plantops/contracts';
import {
  createRoleSchema,
  setRolePermissionsSchema,
  updateRoleSchema,
} from './dto/roles.dto';

const PERMISSION = '00000000-0000-4000-8000-000000000001';
const OTHER_PERMISSION = '00000000-0000-4000-8000-000000000002';

describe('role request schemas', () => {
  describe('POST /iam/roles', () => {
    it('accepts a name, with or without a description', () => {
      expect(createRoleSchema.parse({ name: 'Gate Supervisor' })).toEqual({
        name: 'Gate Supervisor',
      });
      expect(
        createRoleSchema.parse({ name: 'Gate Supervisor', description: 'Approves DCs' }),
      ).toEqual({ name: 'Gate Supervisor', description: 'Approves DCs' });
    });

    it('strips the fields that would let a caller place or entrench a role', () => {
      const parsed = createRoleSchema.parse({
        name: 'Smuggled',
        id: '00000000-0000-4000-8000-000000000003',
        client_id: '00000000-0000-4000-8000-000000000004',
        is_system: true,
        permission_ids: [PERMISSION],
      });

      // `client_id` would place the role under another tenant; `is_system` would
      // let a tenant mint a role it can afterwards neither rename nor delete.
      expect(parsed).toEqual({ name: 'Smuggled' });
    });

    it.each([
      ['a name that is only whitespace', { name: '   ' }],
      ['no name at all', {}],
      ['a name past the bound', { name: 'x'.repeat(161) }],
      ['a description past the bound', { name: 'Ok', description: 'x'.repeat(1001) }],
    ])('refuses %s', (_case, body) => {
      expect(createRoleSchema.safeParse(body).success).toBe(false);
    });
  });

  describe('PATCH /iam/roles/:id', () => {
    it('accepts a rename, a description edit, or both', () => {
      expect(updateRoleSchema.parse({ name: 'Shift Lead' })).toEqual({
        name: 'Shift Lead',
      });
      expect(updateRoleSchema.parse({ description: 'Runs a shift' })).toEqual({
        description: 'Runs a shift',
      });
      expect(
        updateRoleSchema.parse({ name: 'Shift Lead', description: 'Runs a shift' }),
      ).toEqual({ name: 'Shift Lead', description: 'Runs a shift' });
    });

    it('refuses an empty body', () => {
      // A 200 that audited a change nobody made would be worse than the 400.
      expect(updateRoleSchema.safeParse({}).success).toBe(false);
    });

    it('strips is_system and the permission set', () => {
      const parsed = updateRoleSchema.parse({
        name: 'Shift Lead',
        is_system: true,
        permission_ids: [PERMISSION],
      });

      // Permissions are a PUT of their own, because setting them is a
      // replacement with cross-tenant validation attached (Doc 02 §6) rather
      // than a field of the role.
      expect(parsed).toEqual({ name: 'Shift Lead' });
    });
  });

  describe('PUT /iam/roles/:id/permissions', () => {
    it('accepts a set of permission ids', () => {
      expect(
        setRolePermissionsSchema.parse({ permission_ids: [PERMISSION, OTHER_PERMISSION] }),
      ).toEqual({ permission_ids: [PERMISSION, OTHER_PERMISSION] });
    });

    it('accepts an empty set — the only way to clear a role', () => {
      expect(setRolePermissionsSchema.parse({ permission_ids: [] })).toEqual({
        permission_ids: [],
      });
    });

    it('refuses duplicates within one request', () => {
      // The primary key would collapse them silently; a picker that submits the
      // same id twice has a bug, and a 200 would hide it.
      expect(
        setRolePermissionsSchema.safeParse({ permission_ids: [PERMISSION, PERMISSION] })
          .success,
      ).toBe(false);
    });

    it.each([
      ['a missing array', {}],
      ['ids that are not uuids', { permission_ids: ['gatepass.dc.approve'] }],
      ['a null entry', { permission_ids: [null] }],
      [
        'a set past the documented bound',
        {
          permission_ids: Array.from(
            { length: MAX_PERMISSIONS_PER_ROLE + 1 },
            (_, index) =>
              `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
          ),
        },
      ],
    ])('refuses %s', (_case, body) => {
      expect(setRolePermissionsSchema.safeParse(body).success).toBe(false);
    });

    it('accepts exactly the documented maximum', () => {
      const permission_ids = Array.from(
        { length: MAX_PERMISSIONS_PER_ROLE },
        (_, index) => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
      );

      expect(setRolePermissionsSchema.safeParse({ permission_ids }).success).toBe(true);
    });
  });
});
