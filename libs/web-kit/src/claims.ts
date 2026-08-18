'use client';

/**
 * Reading the access token's claims in the browser — for display, never for a
 * decision.
 *
 * ## Why this is safe, and where the line is
 *
 * A JWT's payload is base64url, not encryption: anyone holding the token can
 * read it, and doing so tells the console the subject id, the tenant, the
 * session id and the expiry (Doc 03 §2). That is exactly what the header and
 * the session-expiry indicator need, and fetching it from `POST /iam/introspect`
 * instead would be a network round trip to learn something already in hand.
 *
 * The line is that **nothing here is verified**. The signature is not checked —
 * this library has no JWKS and no business having one. So these values may be
 * used to render, and must never be used to decide. Concretely: the console
 * does not read `cid` and conclude the user is a platform admin, and does not
 * read any claim to decide whether to allow an action. Authorisation comes from
 * `/iam/permissions/resolve` (Doc 04) and, in the end, from the server refusing
 * (Doc 09 §4 — "client-side hiding is UX, not security"). Doc 03 §2 removes the
 * temptation at the source by keeping permissions, roles and scopes *out* of
 * the token entirely.
 */

import type { JwtClaims } from '@plantops/contracts';

/** The claims, as read from an unverified token. Display only. */
export type UnverifiedClaims = JwtClaims;

/**
 * Bytes → text, without assuming `TextDecoder` exists.
 *
 * It does in every browser, and it does *not* in a jsdom test environment,
 * where jest does not expose Node's copy as a global. Percent-decoding is the
 * fallback because it needs nothing but the language: `decodeURIComponent`
 * performs the UTF-8 decode itself.
 */
function bytesToUtf8(bytes: Uint8Array): string {
  if (typeof TextDecoder === 'function') return new TextDecoder().decode(bytes);

  let percentEncoded = '';
  for (const byte of bytes) percentEncoded += `%${byte.toString(16).padStart(2, '0')}`;
  return decodeURIComponent(percentEncoded);
}

function decodeBase64Url(segment: string): string | null {
  const padded = segment.replace(/-/g, '+').replace(/_/g, '/');
  try {
    if (typeof globalThis.atob === 'function') {
      // `atob` yields one char per byte; the payload is UTF-8, so it is decoded
      // rather than used directly — a name or a label outside Latin-1 would
      // otherwise come back mangled.
      const binary = globalThis.atob(padded);
      return bytesToUtf8(Uint8Array.from(binary, (char) => char.charCodeAt(0)));
    }
    // Server rendering, where `atob` may be absent.
    return Buffer.from(padded, 'base64').toString('utf-8');
  } catch {
    return null;
  }
}

/**
 * The claims of an access token, or `null` if it is not a readable JWT.
 *
 * Every failure — wrong segment count, unparseable JSON, missing claims —
 * answers `null` rather than throwing. A malformed token means "not signed in",
 * which the caller already has to handle; an exception at render time would
 * mean a blank console.
 */
export function readTokenClaims(accessToken: string | null): UnverifiedClaims | null {
  if (accessToken === null) return null;

  const segments = accessToken.split('.');
  if (segments.length !== 3) return null;

  const json = decodeBase64Url(segments[1] ?? '');
  if (json === null) return null;

  try {
    const parsed: unknown = JSON.parse(json);
    if (typeof parsed !== 'object' || parsed === null) return null;

    const claims = parsed as Partial<JwtClaims>;
    if (
      typeof claims.sub !== 'string' ||
      typeof claims.cid !== 'string' ||
      typeof claims.sid !== 'string' ||
      (claims.sty !== 'user' && claims.sty !== 'service')
    ) {
      return null;
    }

    return {
      iss: typeof claims.iss === 'string' ? claims.iss : '',
      sub: claims.sub,
      sty: claims.sty,
      cid: claims.cid,
      sid: claims.sid,
      iat: typeof claims.iat === 'number' ? claims.iat : 0,
      exp: typeof claims.exp === 'number' ? claims.exp : 0,
    };
  } catch {
    return null;
  }
}
