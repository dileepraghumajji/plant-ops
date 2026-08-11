import { GRANTS_CACHE_KEY_PREFIX, grantsCacheKey } from './grants.js';
import { SubjectType } from './jwt.js';

describe('grantsCacheKey', () => {
  it('builds the Doc 04 §6 key shape', () => {
    expect(grantsCacheKey('client-1', SubjectType.USER, 'user-9')).toBe(
      'perms:client-1:user:user-9',
    );
    expect(grantsCacheKey('client-1', SubjectType.SERVICE, 'svc-2')).toBe(
      `${GRANTS_CACHE_KEY_PREFIX}:client-1:service:svc-2`,
    );
  });

  it('separates subjects across tenants and subject types', () => {
    const a = grantsCacheKey('client-a', SubjectType.USER, 'same-id');
    const b = grantsCacheKey('client-b', SubjectType.USER, 'same-id');
    const c = grantsCacheKey('client-a', SubjectType.SERVICE, 'same-id');
    expect(new Set([a, b, c]).size).toBe(3);
  });
});
