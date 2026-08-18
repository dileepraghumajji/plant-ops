import { readTokenClaims } from './claims';

/** A JWT with a real header and signature shape but an arbitrary payload. */
function tokenWith(payload: unknown): string {
  const encode = (value: unknown): string =>
    Buffer.from(JSON.stringify(value))
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
  return `${encode({ alg: 'RS256', kid: 'k1' })}.${encode(payload)}.c2ln`;
}

const CLAIMS = {
  iss: 'plantops-iam',
  sub: '11111111-1111-4111-8111-111111111111',
  sty: 'user',
  cid: '22222222-2222-4222-8222-222222222222',
  sid: '33333333-3333-4333-8333-333333333333',
  iat: 1_700_000_000,
  exp: 1_700_000_900,
};

describe('readTokenClaims', () => {
  it('reads the Doc 03 §2 claims out of an access token', () => {
    expect(readTokenClaims(tokenWith(CLAIMS))).toEqual(CLAIMS);
  });

  it('reads a service token’s subject type', () => {
    const claims = readTokenClaims(tokenWith({ ...CLAIMS, sty: 'service' }));
    expect(claims?.sty).toBe('service');
  });

  it('handles non-ASCII in the payload', () => {
    // base64url decodes to bytes, not characters; a naive `atob` would mangle
    // anything outside Latin-1.
    const claims = readTokenClaims(tokenWith({ ...CLAIMS, iss: 'plantöps-iam' }));
    expect(claims?.iss).toBe('plantöps-iam');
  });

  /**
   * Every malformed input answers `null` rather than throwing. A bad token
   * means "not signed in", which the caller already handles; an exception here
   * would blank the console at render time.
   */
  it.each([
    ['null', null],
    ['not a JWT', 'hello'],
    ['too few segments', 'a.b'],
    ['payload that is not base64', 'aaa.!!!!.ccc'],
    ['payload that is not JSON', `aaa.${Buffer.from('nope').toString('base64url')}.ccc`],
  ])('answers null for %s', (_name, token) => {
    expect(readTokenClaims(token)).toBeNull();
  });

  it('answers null when a required claim is missing or wrongly typed', () => {
    expect(readTokenClaims(tokenWith({ ...CLAIMS, sub: undefined }))).toBeNull();
    expect(readTokenClaims(tokenWith({ ...CLAIMS, cid: 42 }))).toBeNull();
    expect(readTokenClaims(tokenWith({ ...CLAIMS, sty: 'robot' }))).toBeNull();
  });
});
