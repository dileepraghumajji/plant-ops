/**
 * Local token verification against a published JWKS (Doc 03 §1, Doc 06 §11).
 *
 * This is the class that keeps the IAM off every module's request path. A
 * module fetches `/iam/.well-known/jwks.json` once, caches it for the `max-age`
 * the IAM publishes, and verifies signatures itself — so an IAM restart, a
 * network partition, or a slow IAM does not stop a gate terminal from
 * authenticating a request it has already been handed a token for.
 *
 * ## Rotation, from the verifier's side
 *
 * Doc 03 §1 puts the obligations on the *signer*: publish the new public key
 * first, wait a cache TTL, then switch. This class holds up the other end.
 *
 * - **Selection is by `kid`, never by trial.** Verifying against each published
 *   key in turn would turn key retention into a signature oracle, and would
 *   make a retired key indistinguishable from the live one in the logs.
 * - **An unknown `kid` refetches once, then rejects.** A rotation may have
 *   published that key seconds ago and this process may be holding a cache from
 *   just before it. Rejecting without looking would turn every rotation into a
 *   burst of spurious 401s lasting one cache TTL.
 * - **The refetch is rate-limited** ({@link JwksVerifierOptions.minRefetchIntervalSeconds}).
 *   Without that, a stream of tokens carrying a forged `kid` is a free way to
 *   make every module hammer the IAM — the unknown-`kid` path is reachable by
 *   anyone who can send a request.
 *
 * ## What is not here
 *
 * Revocation. `sid` is verified as present and well-formed; whether that
 * session is still live is {@link RevocationCache}'s question, asked by the
 * guard. Keeping the two apart is precisely what lets this class answer without
 * talking to anyone.
 */

import {
  JWKS_CACHE_MAX_AGE_SECONDS,
  JWT_MIN_RSA_KEY_BITS,
  JWT_SIGNING_ALGORITHM,
  type JwkDTO,
  type JwtClaims,
} from '@plantops/contracts';
import { createPublicKey, type KeyObject } from 'node:crypto';
import {
  TokenRejection,
  TokenVerificationError,
  assertClaimsAcceptable,
  readAccessTokenClaims,
} from './claims';
import { JwsFormatError, parseCompactJws, verifyCompactJws } from './jws';

/**
 * Anything that can turn a bearer token into claims.
 *
 * The IAM implements this over its own local key material — it *is* the signer,
 * so fetching its own JWKS over HTTP would be a pointless round-trip — and
 * every other process implements it with {@link JwksVerifier}. The guard
 * depends on this interface and not on either one.
 */
export interface TokenVerifier {
  /** @throws {TokenVerificationError} */
  verify(token: string, now?: Date): JwtClaims | Promise<JwtClaims>;
}

export interface JwksVerifierOptions {
  /** Absolute URL of the IAM's `/iam/.well-known/jwks.json`. */
  jwksUri: string;
  /** Expected `iss`. A token from another deployment must not verify here. */
  issuer: string;
  /** How long a fetched key set stays fresh. Defaults to the published max-age. */
  cacheMaxAgeSeconds?: number;
  /**
   * Floor between JWKS fetches triggered by an unknown `kid`. Defaults to 30 s.
   * This is a DoS control, not a tuning knob — see the class comment.
   */
  minRefetchIntervalSeconds?: number;
  /** Injectable for tests and for callers with their own HTTP stack. */
  fetch?: typeof globalThis.fetch;
}

const DEFAULT_MIN_REFETCH_INTERVAL_SECONDS = 30;

interface KeyCache {
  keys: ReadonlyMap<string, KeyObject>;
  fetchedAtMs: number;
}

export class JwksVerifier implements TokenVerifier {
  private cache?: KeyCache;
  /** In-flight fetch, so a burst of misses makes one request, not N. */
  private inFlight?: Promise<KeyCache>;

  private readonly maxAgeMs: number;
  private readonly minRefetchMs: number;
  private readonly http: typeof globalThis.fetch;

  constructor(private readonly options: JwksVerifierOptions) {
    this.maxAgeMs =
      (options.cacheMaxAgeSeconds ?? JWKS_CACHE_MAX_AGE_SECONDS) * 1000;
    this.minRefetchMs =
      (options.minRefetchIntervalSeconds ?? DEFAULT_MIN_REFETCH_INTERVAL_SECONDS) *
      1000;
    this.http = options.fetch ?? globalThis.fetch;
  }

  /** @throws {TokenVerificationError} */
  async verify(token: string, now: Date = new Date()): Promise<JwtClaims> {
    const parsed = parse(token);

    let key = await this.keyFor(parsed.header.kid, now);
    if (key === undefined) {
      // The unknown-`kid` path: one refetch, then the rejection stands.
      key = await this.keyFor(parsed.header.kid, now, { forceRefetch: true });
    }
    if (key === undefined) {
      throw new TokenVerificationError(
        TokenRejection.UNKNOWN_KEY,
        'Token was signed with a key that is not published',
      );
    }

    let signatureValid: boolean;
    try {
      signatureValid = verifyCompactJws(parsed, key);
    } catch (error) {
      throw new TokenVerificationError(
        TokenRejection.UNSUPPORTED_ALGORITHM,
        error instanceof Error ? error.message : 'Unsupported token algorithm',
      );
    }
    if (!signatureValid) {
      throw new TokenVerificationError(
        TokenRejection.BAD_SIGNATURE,
        'Token signature does not verify',
      );
    }

    const claims = readAccessTokenClaims(parsed.payload);
    assertClaimsAcceptable(claims, this.options.issuer, now);
    return claims;
  }

  private async keyFor(
    kid: string,
    now: Date,
    { forceRefetch = false } = {},
  ): Promise<KeyObject | undefined> {
    const ageMs = this.cache ? now.getTime() - this.cache.fetchedAtMs : Infinity;
    const stale = ageMs >= this.maxAgeMs;
    // A forced refetch still respects the floor: the trigger is attacker-
    // reachable, so "an unknown kid arrived" must not mean "fetch now".
    const mayRefetch = forceRefetch ? ageMs >= this.minRefetchMs : stale;

    if (this.cache === undefined || mayRefetch) {
      const cache = await this.refresh(now);
      return cache.keys.get(kid);
    }
    return this.cache.keys.get(kid);
  }

  /** Fetches the key set, collapsing concurrent callers onto one request. */
  private refresh(now: Date): Promise<KeyCache> {
    this.inFlight ??= this.fetchKeys(now)
      .then((cache) => {
        this.cache = cache;
        return cache;
      })
      .finally(() => {
        this.inFlight = undefined;
      });
    return this.inFlight;
  }

  private async fetchKeys(now: Date): Promise<KeyCache> {
    let payload: unknown;
    try {
      const response = await this.http(this.options.jwksUri, {
        headers: { accept: 'application/jwk-set+json, application/json' },
      });
      if (!response.ok) {
        throw new Error(`JWKS endpoint answered ${response.status}`);
      }
      payload = await response.json();
    } catch (error) {
      // A fetch failure is not "no keys": clearing the cache here would turn a
      // brief IAM outage into a fleet-wide auth outage, when the keys already
      // held are almost certainly still correct. Keep what we have and let the
      // caller's `kid` lookup decide.
      if (this.cache !== undefined) return this.cache;
      throw new TokenVerificationError(
        TokenRejection.UNKNOWN_KEY,
        `Could not fetch JWKS: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const keys = new Map<string, KeyObject>();
    for (const jwk of readJwks(payload)) {
      const imported = importJwk(jwk);
      if (imported !== undefined) keys.set(jwk.kid, imported);
    }
    return { keys, fetchedAtMs: now.getTime() };
  }
}

function parse(token: string) {
  try {
    return parseCompactJws(token);
  } catch (error) {
    if (error instanceof JwsFormatError) {
      throw new TokenVerificationError(TokenRejection.MALFORMED, error.message);
    }
    throw error;
  }
}

function readJwks(payload: unknown): JwkDTO[] {
  const keys = (payload as { keys?: unknown })?.keys;
  if (!Array.isArray(keys)) return [];
  return keys.filter(
    (jwk): jwk is JwkDTO =>
      typeof jwk === 'object' &&
      jwk !== null &&
      typeof (jwk as JwkDTO).kid === 'string' &&
      (jwk as JwkDTO).kid !== '',
  );
}

/**
 * Turns one JWKS entry into a usable key, or drops it.
 *
 * Dropping rather than throwing: one unusable entry — a future EC key, an
 * encryption key, a malformed member — must not make the whole key set
 * unavailable and take every token down with it.
 *
 * The size floor is not ceremony. RS256 is only as strong as the modulus, and a
 * verifier that accepts whatever the endpoint serves would accept a 512-bit key
 * that can be factored, at which point anyone can mint tokens this process
 * trusts. A key too small to be safe is not a key.
 */
function importJwk(jwk: JwkDTO): KeyObject | undefined {
  if (jwk.kty !== 'RSA') return undefined;
  if (jwk.use !== undefined && jwk.use !== 'sig') return undefined;
  if (jwk.alg !== undefined && jwk.alg !== JWT_SIGNING_ALGORITHM) return undefined;
  // A published JWKS carries public parameters only. A member that looks like a
  // private key is a misconfigured (or hostile) endpoint, and importing it
  // would hand this process signing capability it must never have.
  if ('d' in jwk) return undefined;

  try {
    const key = createPublicKey({ key: jwk as never, format: 'jwk' });
    const bits = key.asymmetricKeyDetails?.modulusLength ?? 0;
    return bits >= JWT_MIN_RSA_KEY_BITS ? key : undefined;
  } catch {
    return undefined;
  }
}
