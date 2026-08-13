/**
 * The refresh token's shape, and what `parseRefreshToken` refuses.
 *
 * Two properties carry the weight here. The first is that the token addresses a
 * session, because that is what lets a token of *any* generation be judged by
 * the row it belongs to (Doc 03 §4). The second is that parsing is strict, since
 * the session id it yields goes straight onto a `uuid` query parameter — a
 * malformed one that got through would surface as a 500 instead of the 401 a bad
 * token has earned.
 */

import { randomUUID } from 'node:crypto';
import {
  REFRESH_TOKEN_MAX_LENGTH,
  formatRefreshToken,
  hashRefreshSecret,
  mintRefreshSecret,
  parseRefreshToken,
} from './refresh-token.util';

describe('mintRefreshSecret', () => {
  it('produces 256 bits, base64url-encoded', () => {
    const secret = mintRefreshSecret();

    expect(secret).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(Buffer.from(secret, 'base64url')).toHaveLength(32);
  });

  it('never repeats', () => {
    const secrets = new Set(Array.from({ length: 500 }, mintRefreshSecret));
    expect(secrets.size).toBe(500);
  });
});

describe('hashRefreshSecret', () => {
  it('is deterministic, which is what makes the stored form comparable', () => {
    const secret = mintRefreshSecret();
    expect(hashRefreshSecret(secret)).toBe(hashRefreshSecret(secret));
  });

  it('does not contain the secret it hashes', () => {
    const secret = mintRefreshSecret();
    expect(hashRefreshSecret(secret)).not.toContain(secret);
  });

  it('separates two secrets that differ by one character', () => {
    expect(hashRefreshSecret('abcdefghijklmnop')).not.toBe(
      hashRefreshSecret('abcdefghijklmnoq'),
    );
  });
});

describe('formatRefreshToken / parseRefreshToken', () => {
  it('round-trips the session id and the secret', () => {
    const sessionId = randomUUID();
    const secret = mintRefreshSecret();

    expect(parseRefreshToken(formatRefreshToken(sessionId, secret))).toEqual({
      sessionId,
      secret,
    });
  });

  it('stays inside the length the DTO bounds', () => {
    const token = formatRefreshToken(randomUUID(), mintRefreshSecret());
    expect(token.length).toBeLessThanOrEqual(REFRESH_TOKEN_MAX_LENGTH);
  });

  it('is not a JWT, and does not look like one', () => {
    const token = formatRefreshToken(randomUUID(), mintRefreshSecret());

    // Nothing about a session should be readable from a string a client stores
    // for a week — and a dot-delimited token invites both readers and code to
    // try decoding it as one.
    expect(token.split('.')).toHaveLength(1);
  });

  it.each([
    ['no separator', `${randomUUID()}${mintRefreshSecret()}`],
    ['an empty secret', `${randomUUID()}~`],
    ['a short secret', `${randomUUID()}~tooshort`],
    ['a secret outside base64url', `${randomUUID()}~${'a'.repeat(20)}$$$`],
    ['a session id that is not a uuid', `not-a-uuid~${mintRefreshSecret()}`],
    ['an empty session id', `~${mintRefreshSecret()}`],
    ['nothing at all', ''],
    ['only a separator', '~'],
    ['a token past the length bound', `${randomUUID()}~${'a'.repeat(200)}`],
  ])('refuses %s', (_case, token) => {
    expect(parseRefreshToken(token)).toBeNull();
  });

  it('splits on the first separator, so a secret cannot smuggle one', () => {
    // base64url contains no `~`, so this cannot arise from a token this module
    // minted — but a caller-supplied string is not one of those.
    const sessionId = randomUUID();
    expect(parseRefreshToken(`${sessionId}~${'a'.repeat(20)}~${'b'.repeat(20)}`)).toBeNull();
  });
});
