/**
 * The user request schemas (Doc 06 §8).
 *
 * These run without a database, and they pin the shape rules of a user: what a
 * caller may send, how it is normalized before it reaches a column, and — far
 * more importantly — what a caller may **not** send. The behaviour that needs
 * Postgres, which is most of this session's rules about duplicate addresses,
 * status transitions and session revocation, is `users.integration.spec.ts`.
 */

import { MAX_BULK_USER_ROWS } from '@plantops/contracts';
import {
  bulkUserUploadSchema,
  createUserSchema,
  updateUserSchema,
  usersByRoleQuerySchema,
  usersQuerySchema,
} from './dto/users.dto';

describe('user request schemas', () => {
  describe('POST /iam/users', () => {
    it('accepts the four fields Doc 09 §3.3 puts on the create form', () => {
      expect(
        createUserSchema.parse({
          email: 'gate.supervisor@acme.test',
          full_name: 'Gate Supervisor',
          phone: '+91 98765 43210',
          status: 'disabled',
        }),
      ).toEqual({
        email: 'gate.supervisor@acme.test',
        full_name: 'Gate Supervisor',
        phone: '+91 98765 43210',
        status: 'disabled',
      });
    });

    it('lowercases and trims the address, because the column stores it that way', () => {
      // `unique (client_id, email)` is only genuinely case-insensitive because
      // the stored form is normalized, and migration 0003's
      // `user_email_is_lowercase` rejects anything else outright.
      const parsed = createUserSchema.parse({
        email: '  Gate.Supervisor@ACME.test ',
        full_name: 'Gate Supervisor',
      });

      expect(parsed.email).toBe('gate.supervisor@acme.test');
    });

    it('leaves the status absent rather than defaulting it', () => {
      // An absent field and an explicit `"active"` produce the same row, and
      // `UsersService` records which of the two the operator actually chose.
      expect(
        createUserSchema.parse({ email: 'a@b.test', full_name: 'A B' }).status,
      ).toBeUndefined();
    });

    it('strips the fields that would place or promote a user', () => {
      const parsed = createUserSchema.parse({
        email: 'smuggled@acme.test',
        full_name: 'Smuggled',
        id: '00000000-0000-4000-8000-000000000003',
        client_id: '00000000-0000-4000-8000-000000000004',
        is_client_admin: true,
        password: 'hunter2',
      });

      // `client_id` would place the person in another tenant; `is_client_admin`
      // is the interim authorization flag `assertAdministrator` reads, so a
      // tolerated key there is privilege escalation through a profile form; and
      // there is no `password` on this surface at all (Doc 03 §7).
      expect(parsed).toEqual({
        email: 'smuggled@acme.test',
        full_name: 'Smuggled',
      });
    });

    it.each([
      ['no email', { full_name: 'A B' }],
      ['an address with no @', { email: 'nobody', full_name: 'A B' }],
      ['an address with a space', { email: 'a b@c.test', full_name: 'A B' }],
      ['no name', { email: 'a@b.test' }],
      ['a name that is only whitespace', { email: 'a@b.test', full_name: '   ' }],
      ['a name past the bound', { email: 'a@b.test', full_name: 'x'.repeat(161) }],
      ['a phone past the bound', { email: 'a@b.test', full_name: 'A', phone: 'x'.repeat(41) }],
      ['a status outside the enum', { email: 'a@b.test', full_name: 'A', status: 'suspended' }],
    ])('refuses %s', (_case, body) => {
      expect(createUserSchema.safeParse(body).success).toBe(false);
    });
  });

  describe('PATCH /iam/users/:id', () => {
    it('accepts a profile edit, a status change, or both', () => {
      expect(updateUserSchema.parse({ full_name: 'Shift Lead' })).toEqual({
        full_name: 'Shift Lead',
      });
      expect(updateUserSchema.parse({ status: 'locked' })).toEqual({
        status: 'locked',
      });
      expect(
        updateUserSchema.parse({ full_name: 'Shift Lead', status: 'disabled' }),
      ).toEqual({ full_name: 'Shift Lead', status: 'disabled' });
    });

    it('parses every status, including the transition the service refuses', () => {
      // Which transitions are legal depends on the row's current state
      // (Doc 03 §8), which is a question about rows — so the schema accepts
      // `active` and `UsersService` is what refuses it for a disabled account.
      expect(updateUserSchema.parse({ status: 'active' })).toEqual({
        status: 'active',
      });
    });

    it('refuses an empty body', () => {
      // A 200 that audited a change nobody made would be worse than the 400.
      expect(updateUserSchema.safeParse({}).success).toBe(false);
    });

    it('strips is_client_admin', () => {
      // Promoting somebody is an access grant, and access grants are role
      // bindings (Session 20) — not a checkbox on a profile form.
      expect(
        updateUserSchema.parse({ full_name: 'Shift Lead', is_client_admin: true }),
      ).toEqual({ full_name: 'Shift Lead' });
    });
  });

  describe('GET /iam/users', () => {
    it('coerces the pagination pair, as query strings arrive', () => {
      expect(usersQuerySchema.parse({ page: '2', limit: '50' })).toEqual({
        page: 2,
        limit: 50,
      });
    });

    it('accepts the status filter behind the "Account Locked Users" screen', () => {
      expect(usersQuerySchema.parse({ status: 'locked' })).toEqual({
        status: 'locked',
      });
    });

    it('accepts a search term and trims it', () => {
      expect(usersQuerySchema.parse({ q: '  supervisor ' })).toEqual({
        q: 'supervisor',
      });
    });

    it.each([
      ['a status outside the enum', { status: 'archived' }],
      ['a search term that trims to nothing', { q: '   ' }],
      ['a search term past the bound', { q: 'x'.repeat(161) }],
    ])('refuses %s', (_case, query) => {
      expect(usersQuerySchema.safeParse(query).success).toBe(false);
    });

    it('accepts no parameters at all', () => {
      expect(usersQuerySchema.parse({})).toEqual({});
    });
  });

  describe('GET /iam/users/by-role/:roleId', () => {
    it('coerces the pagination pair and takes nothing else', () => {
      expect(
        usersByRoleQuerySchema.parse({ page: '3', limit: '10', status: 'locked' }),
      ).toEqual({ page: 3, limit: 10 });
    });

    it('accepts no parameters at all', () => {
      expect(usersByRoleQuerySchema.parse({})).toEqual({});
    });
  });

  describe('POST /iam/users/bulk', () => {
    it('accepts a CSV document', () => {
      expect(
        bulkUserUploadSchema.parse({
          format: 'csv',
          content: 'email,full_name\na@b.test,A B',
        }),
      ).toEqual({ format: 'csv', content: 'email,full_name\na@b.test,A B' });
    });

    it('carries JSON rows through untouched, invalid ones included', () => {
      // The whole point of the endpoint is a per-row verdict, so a row that is
      // not a user must reach `BulkUploadService` rather than fail the request:
      // validating here would turn a mixed file into a 400 naming its first bad
      // row, which is the report reduced to one line.
      const users = [{ email: 'a@b.test', full_name: 'A B' }, { nonsense: true }, 42];

      expect(bulkUserUploadSchema.parse({ format: 'json', users }).users).toEqual(users);
    });

    it.each([
      ['no format', { content: 'email\na@b.test' }],
      ['a format outside the enum', { format: 'xlsx', content: 'email' }],
      ['a csv upload with no content', { format: 'csv' }],
      ['a json upload with no rows array', { format: 'json' }],
      ['an empty csv document', { format: 'csv', content: '' }],
      ['an empty rows array', { format: 'json', users: [] }],
      [
        'more rows than the bound',
        { format: 'json', users: Array.from({ length: MAX_BULK_USER_ROWS + 1 }, () => ({})) },
      ],
      [
        'a csv document past the length bound',
        { format: 'csv', content: 'x'.repeat(600_001) },
      ],
    ])('refuses %s', (_case, body) => {
      expect(bulkUserUploadSchema.safeParse(body).success).toBe(false);
    });

    it('refuses a body that carries the other arm’s field as well', () => {
      // Ignoring the surplus field would silently upload one of two documents a
      // caller sent, and they would have no way to tell which.
      const both = bulkUserUploadSchema.safeParse({
        format: 'csv',
        content: 'email\na@b.test',
        users: [{ email: 'c@d.test', full_name: 'C D' }],
      });

      expect(both.success).toBe(false);
      expect(both.error?.issues[0].path).toEqual(['users']);
    });

    it('names the missing field rather than the body', () => {
      const missing = bulkUserUploadSchema.safeParse({ format: 'json' });

      expect(missing.error?.issues[0].path).toEqual(['users']);
      expect(missing.error?.issues[0].message).toContain('required');
    });

    it('accepts exactly the bound', () => {
      const users = Array.from({ length: MAX_BULK_USER_ROWS }, (_, index) => ({
        email: `person-${index}@acme.test`,
        full_name: `Person ${index}`,
      }));

      expect(bulkUserUploadSchema.safeParse({ format: 'json', users }).success).toBe(true);
    });
  });
});
