/**
 * The revoked-`sid` cache (Doc 03 §6).
 *
 * Access tokens are verified by signature, which means a revoked session's
 * token keeps verifying until it expires. That is unacceptable for the case the
 * spec singles out — a shared gate terminal logged out at shift end — so every
 * request also asks whether its `sid` has been killed. The answer has to be
 * cheap enough to ask on every request, which rules out the database.
 *
 * ## One key per revocation, not one set
 *
 * Doc 03 §6 says "a Redis set / short-TTL cache". A set is the wrong half of
 * that: it grows forever and has no per-member expiry, so it must be pruned by
 * something, and the day that something stops running is the day the set is
 * either unbounded or silently emptied. One key per revoked `sid`, with a TTL,
 * prunes itself.
 *
 * The TTL is the **remaining exposure**, not the session lifetime. Once every
 * token bearing a `sid` has expired, the revocation entry protects nothing:
 * such a token is already refused for `exp`. So the entry lives for one access
 * token lifetime plus the clock-skew leeway, and then disappears. This is what
 * keeps the cache proportional to *recent* revocations rather than to all of
 * them.
 *
 * ## What a cache miss means, and what an outage means
 *
 * A miss means "not revoked" — that is the happy path and it is DB-free, which
 * is the whole design. An *error* means something different and must not be
 * confused with it: a Redis outage that reads as "not revoked" silently
 * un-revokes every session in the system for the duration. So this class throws
 * on failure rather than returning `false`, and {@link AuthGuard} decides —
 * with the database as the authority where one is reachable.
 *
 * There remains one honest gap: if Redis is *up* but has lost the key (an
 * eviction, a flush, a restart without persistence), a revoked session works
 * until its access token expires. Doc 03 §6 accepts exactly that bound —
 * "because access tokens are short-lived, the revocation window is bounded even
 * without a per-request DB hit". The database row stays authoritative, and the
 * next refresh (Session 9) consults it.
 */

import { revokedSessionKey } from '@plantops/contracts';

/**
 * The two commands this needs, and nothing else.
 *
 * Structural rather than an `ioredis` import on purpose: `auth-kit` is consumed
 * by every future module, and making it drag a Redis client in would force that
 * choice on all of them. `ioredis`'s `Redis` satisfies this as-is.
 */
export interface RevocationStore {
  set(
    key: string,
    value: string,
    mode: 'EX',
    ttlSeconds: number,
  ): Promise<unknown>;
  exists(key: string): Promise<number>;
}

/** Whatever can answer "is this session dead?" — see {@link RevocationCache}. */
export interface RevocationChecker {
  /** @throws when the answer is unknown. Never returns `false` on failure. */
  isRevoked(sessionId: string): Promise<boolean>;
}

export interface RevocationCacheOptions {
  /**
   * How long a revocation entry is kept: one access-token lifetime plus the
   * skew leeway. Longer wastes memory; shorter re-opens the session.
   */
  ttlSeconds: number;
}

export class RevocationCache implements RevocationChecker {
  constructor(
    private readonly store: RevocationStore,
    private readonly options: RevocationCacheOptions,
  ) {}

  /**
   * Marks a session dead for every verifier sharing this cache.
   *
   * Call **after** the database write commits. Publishing first would let a
   * concurrent reader see a revoked session that a rollback then restores — the
   * same post-commit ordering the scope-move invalidation requires (Doc 07 §7).
   */
  async revoke(sessionId: string): Promise<void> {
    // The value is a marker; only the key's existence carries meaning. `EX`
    // rather than a separate `EXPIRE` so a connection lost between two commands
    // cannot leave an immortal entry behind.
    await this.store.set(revokedSessionKey(sessionId), '1', 'EX', this.options.ttlSeconds);
  }

  /** @throws when the store cannot answer — see the class comment. */
  async isRevoked(sessionId: string): Promise<boolean> {
    return (await this.store.exists(revokedSessionKey(sessionId))) > 0;
  }
}
