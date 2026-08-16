/**
 * The versioned grants cache (Doc 04 §6–7).
 *
 * Resolution is read-heavy and changes rarely, so the full grant set is cached
 * in Redis under `perms:{clientId}:{subjectType}:{subjectId}` with a TTL of at
 * most ten minutes. The TTL is *not* how freshness is maintained — Doc 04 §7 is
 * explicit that a grant change must take effect immediately — it is the
 * backstop for the one change that fires no event at all: a `role_binding`
 * whose `expires_at` simply passes (Doc 01 §4.5).
 *
 * ## Why a version counter and not a delete
 *
 * Doc 04 §7's recommended approach, and the reason is a write-time cost. Two of
 * the invalidation triggers — a role's permissions edited, a role deleted —
 * affect *every subject bound to that role*, which the mutation would have to
 * enumerate before it could delete their keys. A per-`(client, subject)` counter
 * moves that work to read time, where it is one extra `GET` on a pipeline that
 * was already making one.
 *
 * So a cache entry carries the counter value it was written under (`v`, the
 * {@link CachedGrants} field the contract publishes), and a read that finds the
 * authoritative counter ahead of it treats the entry as absent. Session 22 bumps
 * the counter from every row of the §7 table through
 * {@link GrantsCacheService.bump}; nothing calls it yet, which is why this file
 * ships with the counter and Session 22 ships with its callers.
 *
 * ## Every failure mode falls back to Postgres
 *
 * Redis is a supporting dependency here, not a load-bearing one
 * (`redis/redis.service.ts`), and unlike the revocation cache — where
 * uncertainty must fall to *denial*, or an outage re-enables every revoked
 * session — uncertainty about grants has a strictly better answer available:
 * ask the database, which is authoritative. So every path below swallows its
 * error, logs it, and reports a miss. A Redis outage makes resolution slower and
 * never wrong.
 *
 * The one thing that must not happen is a slow Redis making the request slower
 * than a resolve would have been, so both round-trips are bounded by
 * {@link CACHE_TIMEOUT_MS} on top of ioredis's own `enableOfflineQueue: false`.
 *
 * ## The keys, and which of them is shared
 *
 * `grantsCacheKey()` lives in `@plantops/contracts` because Doc 04 §6 publishes
 * the entry's shape and any cache holder in the fleet has to derive the same
 * name. The **version key** does not: it is this implementation's answer to §7's
 * "either fan out to affected subjects or bump a per-role version", and a
 * consumer participates in invalidation by subscribing to `perms.invalidated`
 * and deleting, never by reading a counter. It is therefore derived here, from
 * the published key, and nothing outside this file spells it — including
 * Session 22, which calls {@link GrantsCacheService.bump} rather than naming a
 * key of its own.
 *
 * Both keys land under `REDIS_KEY_PREFIX` automatically, because `RedisService`
 * configures the client with it — which is what keeps a staging deployment from
 * invalidating production's grants on a shared managed Redis.
 */

import { Inject, Injectable, Logger } from '@nestjs/common';
import type { EnvConfig } from '@plantops/config';
import {
  grantsCacheKey,
  type CachedGrants,
  type ResolvedGrants,
} from '@plantops/contracts';
import { ENV } from '../config/config.module';
import { withTimeout } from '../common/with-timeout';
import { RedisService } from '../redis/redis.service';
import type { SubjectRef } from './resolver.service';

/**
 * Budget for a cache round-trip, matching the throttle counter's.
 *
 * Short on purpose and for the same reason: this exists to make the request
 * faster, so it must never be the slowest thing in one. Past this the caller
 * resolves from Postgres, which is what it would have done on a miss anyway.
 */
const CACHE_TIMEOUT_MS = 250;

/**
 * A cache read: the entry if it is current, and the counter value it was
 * compared against.
 *
 * The version comes back on a miss as well as a hit, because the caller needs
 * it to write the entry it is about to resolve — see `resolver.service.ts` for
 * why it must be the value observed *before* the resolve. `null` means the
 * counter could not be read at all, and therefore that nothing should be
 * written: an entry stamped with a guessed version is worse than no entry.
 */
export interface CacheRead {
  grants: ResolvedGrants | null;
  version: number | null;
}

const MISS: CacheRead = { grants: null, version: null };

@Injectable()
export class GrantsCacheService {
  private readonly logger = new Logger(GrantsCacheService.name);

  constructor(
    @Inject(ENV) private readonly env: EnvConfig,
    private readonly redis: RedisService,
  ) {}

  /**
   * The subject's cached grants, if the entry is still current.
   *
   * One round-trip for both keys. They are read together rather than the value
   * first and the counter only on a hit, because the counter is needed on a miss
   * too and a second `GET` would double the latency of the common cold path.
   *
   * A malformed entry — a truncated write, a value left by an older shape of
   * this code — is a miss, not an exception. It cannot be repaired and it will
   * be overwritten by the resolve that follows.
   */
  async read(subject: SubjectRef): Promise<CacheRead> {
    const key = this.keyFor(subject);

    let entry: string | null;
    let counter: string | null;
    try {
      [entry, counter] = await withTimeout(
        this.redis.client.mget(key, versionKey(key)),
        CACHE_TIMEOUT_MS,
        'grants cache read',
      );
    } catch (error) {
      this.logger.warn(
        `Grants cache unavailable (${messageOf(error)}); resolving from Postgres`,
      );
      return MISS;
    }

    const version = counter === null ? 0 : Number(counter);
    if (!Number.isFinite(version)) return MISS;
    if (entry === null) return { grants: null, version };

    let cached: CachedGrants;
    try {
      cached = JSON.parse(entry) as CachedGrants;
    } catch {
      this.logger.warn(`Discarding an unreadable grants cache entry for ${key}`);
      return { grants: null, version };
    }

    // The whole point of the counter: an entry written before the last
    // invalidation is not stale data to be repaired, it is a miss.
    if (cached.v !== version) return { grants: null, version };

    return { grants: { permissions: cached.permissions, scopes: cached.scopes }, version };
  }

  /**
   * Stores `grants` as current for `version` (Doc 04 §6).
   *
   * A `null` version means the read could not establish one, so there is
   * nothing to stamp the entry with and it is not written — see
   * {@link CacheRead}.
   *
   * The TTL is asserted on the counter as well, and deliberately longer. If the
   * counter expired first, a live entry stamped `v: 3` would meet a missing
   * counter, be compared against 0 and be discarded — correct, but a cache that
   * quietly stops working. Outliving the entry it validates costs one small key
   * per subject and removes the failure mode entirely.
   */
  async write(
    subject: SubjectRef,
    grants: ResolvedGrants,
    version: number | null,
  ): Promise<void> {
    if (version === null) return;

    const key = this.keyFor(subject);
    const entry: CachedGrants = { ...grants, v: version };
    const ttl = this.env.GRANTS_CACHE_TTL_SECONDS;

    try {
      await withTimeout(
        this.redis.client
          .multi()
          .set(key, JSON.stringify(entry), 'EX', ttl)
          .expire(versionKey(key), ttl * 2)
          .exec(),
        CACHE_TIMEOUT_MS,
        'grants cache write',
      );
    } catch (error) {
      // Nothing to recover: the caller already has the authoritative answer and
      // the next request simply resolves again.
      this.logger.warn(`Grants cache write failed (${messageOf(error)})`);
    }
  }

  /**
   * Invalidates a subject's cached grants by moving their counter forward
   * (Doc 04 §7).
   *
   * `INCR` on a missing counter creates it at 1, which is already ahead of the
   * `v: 0` any entry written without one carries — so a subject who has never
   * been cached and a subject whose counter has expired are both invalidated
   * correctly rather than by luck.
   *
   * Never throws. Every caller is a post-commit callback
   * (`common/transaction-context.ts`): the write it announces has already
   * landed, the database is authoritative, and a failed bump must not turn a
   * successful unbind into an error. What it costs is bounded staleness until
   * the TTL, which is the backstop Doc 04 §7.1 point 5 accepts by design.
   *
   * Called by Session 22's `InvalidationService` for every row of the §7 table.
   */
  async bump(subject: SubjectRef): Promise<void> {
    const key = versionKey(this.keyFor(subject));

    try {
      await withTimeout(
        this.redis.client
          .multi()
          .incr(key)
          .expire(key, this.env.GRANTS_CACHE_TTL_SECONDS * 2)
          .exec(),
        CACHE_TIMEOUT_MS,
        'grants cache invalidation',
      );
    } catch (error) {
      this.logger.error(
        `Grants for ${this.keyFor(subject)} could not be invalidated ` +
          `(${messageOf(error)}); the entry stays live until its TTL expires`,
      );
    }
  }

  /** `perms:{clientId}:{subjectType}:{subjectId}` — Doc 04 §6, one definition. */
  private keyFor(subject: SubjectRef): string {
    return grantsCacheKey(subject.clientId, subject.type, subject.id);
  }
}

/**
 * The counter beside an entry.
 *
 * Derived from the published key rather than built from the parts again, so the
 * two cannot be namespaced differently — and so a change to the key shape in
 * `@plantops/contracts` moves both.
 */
function versionKey(key: string): string {
  return `${key}:v`;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
