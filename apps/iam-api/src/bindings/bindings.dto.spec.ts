/**
 * The role-binding request schemas (Doc 06 §9).
 *
 * These run without a database, and they pin the half of Session 20's rules that
 * a body can settle on its own: the subject XOR, the four uuids, a future
 * expiry, and — far more importantly — what a caller may **not** send. The half
 * that needs Postgres is every cross-tenant rule in Doc 02 §6, which is
 * `bindings.integration.spec.ts`.
 */

import { createRoleBindingSchema, roleBindingsQuerySchema } from './dto/bindings.dto';

const USER = '00000000-0000-4000-8000-000000000001';
const SERVICE_ACCOUNT = '00000000-0000-4000-8000-000000000002';
const ROLE = '00000000-0000-4000-8000-000000000003';
const NODE = '00000000-0000-4000-8000-000000000004';

/** Far enough out that a slow suite cannot walk past it mid-run. */
const FUTURE = new Date(Date.now() + 86_400_000).toISOString();
const PAST = new Date(Date.now() - 86_400_000).toISOString();

describe('role binding request schemas', () => {
  describe('POST /iam/role-bindings', () => {
    it('accepts a user binding, with or without an expiry', () => {
      expect(
        createRoleBindingSchema.parse({
          user_id: USER,
          role_id: ROLE,
          scope_node_id: NODE,
        }),
      ).toEqual({ user_id: USER, role_id: ROLE, scope_node_id: NODE });

      expect(
        createRoleBindingSchema.parse({
          user_id: USER,
          role_id: ROLE,
          scope_node_id: NODE,
          expires_at: FUTURE,
        }),
      ).toEqual({
        user_id: USER,
        role_id: ROLE,
        scope_node_id: NODE,
        expires_at: FUTURE,
      });
    });

    it('accepts a service-account binding', () => {
      // Doc 09 §3.5: a machine identity is bound to roles and scopes exactly
      // like a person, which is why the subject is a XOR rather than a user id
      // with a machine special case bolted on.
      expect(
        createRoleBindingSchema.parse({
          service_account_id: SERVICE_ACCOUNT,
          role_id: ROLE,
          scope_node_id: NODE,
        }),
      ).toEqual({
        service_account_id: SERVICE_ACCOUNT,
        role_id: ROLE,
        scope_node_id: NODE,
      });
    });

    it('refuses a body naming neither subject, and names the field', () => {
      const result = createRoleBindingSchema.safeParse({
        role_id: ROLE,
        scope_node_id: NODE,
      });

      expect(result.success).toBe(false);
      // The path matters: the pipe turns issues into `details[].field`
      // (Doc 06 §2), and "user_id is required" is actionable where "the body is
      // invalid" is not.
      expect(result.error?.issues[0].path).toEqual(['user_id']);
    });

    it('refuses a body naming both, which the check constraint would 500 on', () => {
      const result = createRoleBindingSchema.safeParse({
        user_id: USER,
        service_account_id: SERVICE_ACCOUNT,
        role_id: ROLE,
        scope_node_id: NODE,
      });

      expect(result.success).toBe(false);
      expect(result.error?.issues[0].path).toEqual(['service_account_id']);
    });

    it('refuses an expiry that has already passed', () => {
      // A grant created expired grants nothing from the instant it exists, so
      // it is a 400 about the body rather than a row somebody has to notice
      // later is inert.
      const result = createRoleBindingSchema.safeParse({
        user_id: USER,
        role_id: ROLE,
        scope_node_id: NODE,
        expires_at: PAST,
      });

      expect(result.success).toBe(false);
      expect(result.error?.issues[0].path).toEqual(['expires_at']);
    });

    it('refuses a local timestamp with no offset', () => {
      // `expires_at` is a `timestamptz`. A naive string would be read against
      // the server's zone rather than the operator's, so the grant would lapse
      // at a moment nobody chose.
      expect(
        createRoleBindingSchema.safeParse({
          user_id: USER,
          role_id: ROLE,
          scope_node_id: NODE,
          expires_at: '2999-01-01T00:00:00',
        }).success,
      ).toBe(false);
    });

    it('strips the fields that would place a grant outside the caller`s tenant', () => {
      const parsed = createRoleBindingSchema.parse({
        user_id: USER,
        role_id: ROLE,
        scope_node_id: NODE,
        id: '00000000-0000-4000-8000-000000000009',
        client_id: '00000000-0000-4000-8000-00000000000a',
        created_at: '2026-01-01T00:00:00.000Z',
      });

      // `client_id` is the one that matters: a tolerated key here would place a
      // grant in another tenant, and the only thing left behind it would be
      // RLS's `with check`, which refuses with a policy violation rather than a
      // message naming the problem.
      expect(parsed).toEqual({ user_id: USER, role_id: ROLE, scope_node_id: NODE });
    });

    it.each([
      ['no role', { user_id: USER, scope_node_id: NODE }],
      ['no scope node', { user_id: USER, role_id: ROLE }],
      ['a role id that is not a uuid', { user_id: USER, role_id: 'gate', scope_node_id: NODE }],
      [
        'a scope path in place of a node id',
        { user_id: USER, role_id: ROLE, scope_node_id: 'n_0000.n_0001' },
      ],
    ])('refuses %s', (_case, body) => {
      expect(createRoleBindingSchema.safeParse(body).success).toBe(false);
    });
  });

  describe('GET /iam/role-bindings', () => {
    it('accepts every filter Doc 06 §9 names, and none of them', () => {
      expect(roleBindingsQuerySchema.parse({})).toEqual({});
      expect(
        roleBindingsQuerySchema.parse({
          user_id: USER,
          service_account_id: SERVICE_ACCOUNT,
          role_id: ROLE,
          scope_node_id: NODE,
        }),
      ).toEqual({
        user_id: USER,
        service_account_id: SERVICE_ACCOUNT,
        role_id: ROLE,
        scope_node_id: NODE,
      });
    });

    it('coerces the pagination pair, which arrives as strings', () => {
      expect(roleBindingsQuerySchema.parse({ page: '2', limit: '10' })).toEqual({
        page: 2,
        limit: 10,
      });
    });

    it('strips a tenant selector', () => {
      // There is no `?clientId=`, here or on any client-tier surface: it would
      // look like it selected a tenant while RLS quietly ignored it.
      expect(
        roleBindingsQuerySchema.parse({
          role_id: ROLE,
          client_id: '00000000-0000-4000-8000-00000000000a',
        }),
      ).toEqual({ role_id: ROLE });
    });

    it('refuses a filter that is not a uuid', () => {
      expect(roleBindingsQuerySchema.safeParse({ user_id: 'gita' }).success).toBe(false);
    });
  });
});
