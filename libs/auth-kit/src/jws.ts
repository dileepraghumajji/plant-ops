/**
 * Compact JWS serialisation for RS256 (Doc 03 §1).
 *
 * Hand-written, for the same reason the RLS policies are: the failure modes
 * here are silent. A JWT library that accepts one more algorithm than we meant
 * it to, or that helpfully adds a claim, does not error — it succeeds, and the
 * mistake is only visible to someone who goes looking. The surface is small
 * enough (three base64url segments and one `crypto.verify` call) that owning it
 * outright is cheaper than auditing a dependency's option matrix on every
 * upgrade.
 *
 * It lives in `auth-kit` rather than in the IAM because the IAM signs and every
 * consuming module verifies, and those two must agree byte for byte. Two
 * implementations of "the same" JWS handling is how a signer and a verifier
 * drift into disagreeing about a padded segment — which is a token that works
 * in one process and fails in the next.
 *
 * ## The invariants that make this safe
 *
 * 1. **The algorithm is never read from the token.** {@link verifyCompactJws}
 *    verifies with RS256 and rejects any header whose `alg` is not exactly
 *    `RS256`. This is the whole of the `alg: "none"` and
 *    HS256-signed-with-the-public-key attack class, and it is closed by
 *    construction: there is no HMAC code path in this file for a forged header
 *    to select.
 * 2. **The key is never taken from the token.** The header's `kid` selects from
 *    a closed, locally-held set (`keys.service.ts` in the IAM, the fetched JWKS
 *    in a module); it is a lookup key, never key material. `jwk`/`jku`/`x5u`
 *    headers are ignored entirely.
 * 3. **Segments are validated before decoding.** Node's base64url decoder is
 *    lenient — it will quietly accept standard-base64 `+`/`/`, padding, and
 *    trailing junk — so two different strings can decode to the same bytes.
 *    That is a signature-stripping foothold on any system that compares tokens
 *    or caches by string. {@link parseCompactJws} rejects anything outside the
 *    canonical base64url alphabet.
 * 4. **Verification is over the exact received bytes.** The signing input is
 *    sliced from the original token string, never re-serialised from the parsed
 *    header and payload — re-encoding would verify a signature over a
 *    *different* document than the caller was handed.
 */

import { JWT_SIGNING_ALGORITHM } from '@plantops/contracts';
import {
  createPrivateKey,
  createPublicKey,
  sign as cryptoSign,
  verify as cryptoVerify,
  type KeyObject,
} from 'node:crypto';

/** Node's digest name for the RS256 (RSASSA-PKCS1-v1_5 + SHA-256) suite. */
const DIGEST = 'sha256';

/** `typ` on every header the IAM writes. */
const JWT_TYPE = 'JWT';

/** Canonical base64url: no padding, no `+`, no `/`, nothing else. */
const BASE64URL_SEGMENT = /^[A-Za-z0-9_-]+$/;

/** The JOSE header the IAM writes, and the only shape it accepts back. */
export interface JwsHeader {
  alg: string;
  typ?: string;
  /** Identifies the verification key within the published JWKS (Doc 03 §1). */
  kid: string;
}

/** A compact JWS taken apart, with the bytes the signature actually covers. */
export interface ParsedJws {
  header: JwsHeader;
  payload: Record<string, unknown>;
  /** `<header>.<payload>` exactly as received — the signed document. */
  signingInput: string;
  signature: Buffer;
}

/** Raised for any token this module refuses. Carries no token material. */
export class JwsFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JwsFormatError';
  }
}

function encodeSegment(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

/**
 * Decodes one segment to JSON.
 *
 * The alphabet check happens here rather than at the caller because every
 * segment needs it and a missed one is invisible: the token still verifies.
 */
function decodeSegment(segment: string, what: string): Record<string, unknown> {
  if (!BASE64URL_SEGMENT.test(segment)) {
    throw new JwsFormatError(`Token ${what} is not canonical base64url`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
  } catch {
    throw new JwsFormatError(`Token ${what} is not valid JSON`);
  }
  // `typeof null === 'object'`, and an array would pass a naive object check
  // and then silently produce `undefined` for every claim lookup.
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new JwsFormatError(`Token ${what} is not a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

/**
 * Signs `payload` into a compact JWS.
 *
 * The header is built here and cannot be influenced by the caller: `alg` is
 * always {@link JWT_SIGNING_ALGORITHM}, so nothing upstream can ask for a
 * weaker one.
 */
export function signCompactJws(
  payload: Record<string, unknown>,
  key: KeyObject,
  kid: string,
): string {
  const header: JwsHeader = { alg: JWT_SIGNING_ALGORITHM, typ: JWT_TYPE, kid };
  const signingInput = `${encodeSegment(header)}.${encodeSegment(payload)}`;
  const signature = cryptoSign(DIGEST, Buffer.from(signingInput, 'ascii'), key);
  return `${signingInput}.${signature.toString('base64url')}`;
}

/**
 * Splits a compact JWS without verifying it.
 *
 * Exposed separately because reading `kid` is what *selects* the verification
 * key — the one thing a verifier legitimately needs from an unverified token.
 * Nothing else in this codebase may act on the result: a parsed-but-unverified
 * payload is attacker-controlled JSON.
 */
export function parseCompactJws(token: string): ParsedJws {
  const segments = token.split('.');
  if (segments.length !== 3) {
    throw new JwsFormatError('Token is not a compact JWS (expected 3 segments)');
  }
  const [headerSegment, payloadSegment, signatureSegment] = segments as [
    string,
    string,
    string,
  ];

  if (!BASE64URL_SEGMENT.test(signatureSegment)) {
    throw new JwsFormatError('Token signature is not canonical base64url');
  }

  const header = decodeSegment(headerSegment, 'header');
  const payload = decodeSegment(payloadSegment, 'payload');

  if (typeof header['alg'] !== 'string') {
    throw new JwsFormatError('Token header is missing "alg"');
  }
  if (typeof header['kid'] !== 'string' || header['kid'] === '') {
    // Without a `kid` there is no way to choose a key, and guessing by trying
    // every published key turns key retention during a rotation into a
    // signature oracle. Doc 03 §1 requires the header.
    throw new JwsFormatError('Token header is missing "kid"');
  }

  return {
    header: {
      alg: header['alg'],
      typ: typeof header['typ'] === 'string' ? header['typ'] : undefined,
      kid: header['kid'],
    },
    payload,
    signingInput: `${headerSegment}.${payloadSegment}`,
    signature: Buffer.from(signatureSegment, 'base64url'),
  };
}

/**
 * Verifies a parsed JWS against one public key.
 *
 * Returns a boolean rather than throwing so the caller decides what a bad
 * signature means; it throws only for a header that is not RS256, because that
 * is a refusal to *attempt* verification rather than a failed one.
 */
export function verifyCompactJws(parsed: ParsedJws, key: KeyObject): boolean {
  if (parsed.header.alg !== JWT_SIGNING_ALGORITHM) {
    throw new JwsFormatError(
      `Unsupported token algorithm "${parsed.header.alg}" (only ${JWT_SIGNING_ALGORITHM} is accepted)`,
    );
  }
  // A public KeyObject, never a raw secret: `crypto.verify` will not perform an
  // HMAC with one, so a forged `alg: HS256` header has nothing to select even
  // if the check above were ever removed.
  return cryptoVerify(
    DIGEST,
    Buffer.from(parsed.signingInput, 'ascii'),
    key,
    parsed.signature,
  );
}

/**
 * Parses a PEM private key, raising a message that names the variable.
 *
 * The underlying OpenSSL error is deliberately *not* attached as `cause`: its
 * message can echo fragments of the input, and this input is a signing key
 * (Doc 10 §8). The variable name is what the operator needs anyway.
 */
export function privateKeyFromPem(pem: string, label: string): KeyObject {
  try {
    return createPrivateKey(pem);
  } catch {
    throw new JwsFormatError(`${label} is not a readable PEM private key`);
  }
}

/** Parses a PEM public key, raising a message that names the variable. */
export function publicKeyFromPem(pem: string, label: string): KeyObject {
  try {
    return createPublicKey(pem);
  } catch {
    throw new JwsFormatError(`${label} is not a readable PEM public key`);
  }
}
