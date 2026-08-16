/**
 * The resolution request schemas (Doc 06 §11).
 *
 * Short, because these bodies are small — and the shortest assertions are the
 * most important ones: that a caller cannot name a *subject*. On every other
 * surface a stripped key is untidiness; here it would be the difference between
 * "what may I do" and "what may anyone do", with no permission check behind it
 * (Session 23 deliberately leaves these routes ungated — see
 * `authz.controller.ts`).
 */

import {
  introspectSchema,
  permissionCheckSchema,
  resolveQuerySchema,
} from './dto/authz.dto';

const NODE = '00000000-0000-4000-8000-000000000004';
const APPLICATION = '00000000-0000-4000-8000-000000000005';

describe('GET /iam/permissions/resolve', () => {
  it('accepts no filter at all', () => {
    expect(resolveQuerySchema.parse({})).toEqual({});
  });

  it('accepts an application id and refuses anything that is not one', () => {
    expect(resolveQuerySchema.parse({ applicationId: APPLICATION })).toEqual({
      applicationId: APPLICATION,
    });
    expect(resolveQuerySchema.safeParse({ applicationId: 'gatepass' }).success).toBe(
      false,
    );
  });

  it('drops a subject the caller tried to resolve on somebody else’s behalf', () => {
    const parsed = resolveQuerySchema.parse({
      applicationId: APPLICATION,
      subjectId: '00000000-0000-4000-8000-000000000001',
      clientId: '00000000-0000-4000-8000-0000000000c9',
    });

    expect(parsed).toEqual({ applicationId: APPLICATION });
  });
});

describe('POST /iam/permissions/check', () => {
  it('accepts a permission key and a node id', () => {
    expect(
      permissionCheckSchema.parse({
        permission: 'gatepass.dc.approve',
        scopeNodeId: NODE,
      }),
    ).toEqual({ permission: 'gatepass.dc.approve', scopeNodeId: NODE });
  });

  it('accepts a key no application has registered', () => {
    // Deliberate: an unknown key is a legitimate question whose answer is
    // `false`. Rejecting it as malformed would tell the caller their key is not
    // merely unheld but unknown.
    expect(
      permissionCheckSchema.safeParse({ permission: 'nothing.of.the.sort', scopeNodeId: NODE })
        .success,
    ).toBe(true);
  });

  it('refuses an empty permission, an unbounded one, and a node that is not a uuid', () => {
    expect(permissionCheckSchema.safeParse({ permission: '', scopeNodeId: NODE }).success).toBe(
      false,
    );
    expect(
      permissionCheckSchema.safeParse({ permission: 'x'.repeat(161), scopeNodeId: NODE })
        .success,
    ).toBe(false);
    expect(
      permissionCheckSchema.safeParse({ permission: 'gatepass.dc.approve', scopeNodeId: 'gate-3' })
        .success,
    ).toBe(false);
  });

  it('drops a subject', () => {
    expect(
      permissionCheckSchema.parse({
        permission: 'gatepass.dc.approve',
        scopeNodeId: NODE,
        user_id: '00000000-0000-4000-8000-000000000001',
      }),
    ).toEqual({ permission: 'gatepass.dc.approve', scopeNodeId: NODE });
  });
});

describe('POST /iam/introspect', () => {
  it('accepts any non-empty bounded string', () => {
    // No format check: deciding whether the thing is a token is what the
    // endpoint does, and a malformed one is `{ active: false }`, never a 400.
    expect(introspectSchema.parse({ token: 'not.a.jwt' })).toEqual({ token: 'not.a.jwt' });
  });

  it('refuses an empty token and an unbounded one', () => {
    expect(introspectSchema.safeParse({ token: '   ' }).success).toBe(false);
    expect(introspectSchema.safeParse({ token: 'x'.repeat(8193) }).success).toBe(false);
  });
});
