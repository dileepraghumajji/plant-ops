import {
  isInternalPath,
  loginUrlFor,
  LOGIN_PATH,
  safeReturnTo,
} from '../src/lib/return-to';

/**
 * The open-redirect guard on the login screen's `?next=`.
 *
 * Worth its own suite because the value is attacker-supplied and the redirect
 * happens immediately after the user typed their password — the single worst
 * moment to hand control to another origin.
 */
describe('isInternalPath', () => {
  it.each(['/', '/admin/users', '/admin/users/8f2c?tab=bindings', '/login#top'])(
    'accepts %s',
    (target) => {
      expect(isInternalPath(target)).toBe(true);
    },
  );

  it.each([
    ['an absolute URL', 'https://evil.test/steal'],
    ['a scheme-less absolute URL', 'evil.test/steal'],
    ['a protocol-relative URL', '//evil.test/steal'],
    ['a backslash protocol-relative URL', String.raw`/\evil.test`],
    ['a backslash anywhere', String.raw`/admin\..\evil`],
    ['a javascript URL', 'javascript:alert(1)'],
    ['a relative path', 'admin/users'],
    ['an empty string', ''],
  ])('rejects %s', (_name, target) => {
    expect(isInternalPath(target)).toBe(false);
  });
});

describe('loginUrlFor', () => {
  it('carries an internal target as an encoded query parameter', () => {
    expect(loginUrlFor('/admin/users?status=locked')).toBe(
      `${LOGIN_PATH}?next=%2Fadmin%2Fusers%3Fstatus%3Dlocked`,
    );
  });

  it('drops a target it will not redirect to, rather than refusing to log in', () => {
    expect(loginUrlFor('https://evil.test')).toBe(LOGIN_PATH);
    expect(loginUrlFor(null)).toBe(LOGIN_PATH);
  });
});

describe('safeReturnTo', () => {
  it('returns an internal target unchanged', () => {
    expect(safeReturnTo('/admin/roles')).toBe('/admin/roles');
  });

  it('falls back to the root — which itself resolves per subject — otherwise', () => {
    expect(safeReturnTo('//evil.test')).toBe('/');
    expect(safeReturnTo(null)).toBe('/');
    expect(safeReturnTo('https://evil.test', '/admin')).toBe('/admin');
  });
});
