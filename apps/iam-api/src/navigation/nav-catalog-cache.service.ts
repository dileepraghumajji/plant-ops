/**
 * The versioned nav-catalog cache — Doc 05 §6's `app_nav_version`.
 *
 * ## Which of §6's two options this is, and why
 *
 * Doc 05 §6 offers two ways to make navigation cheap: cache the **computed tree**
 * per `(subject, application)`, or "compute on demand from cached grants (cheap
 * for typical catalog sizes)" — and it states a preference, "prefer this unless
 * profiling says otherwise — one less cache to invalidate".
 *
 * So there is no tree cache here. What is cached is the other operand: the
 * **catalog**, which is subject-independent. That leaves the pruning to run per
 * request from two cached inputs, and it is what gives §6's closing requirement
 * something to act on — "when a platform admin edits `nav_node` or
 * `menu_permission` for an application, bump an `app_nav_version[applicationId]`
 * and treat cached trees for that app as stale". This counter *is* that value.
 *
 * The reason the catalog is the right thing to cache rather than the tree:
 *
 * - It is **one entry per application**, not per application per subject. A
 *   tenant with four hundred people has one entry, and it is the same entry every
 *   one of them reads.
 * - It depends on **one** input, so it has one invalidation trigger — the bump
 *   below. A cached tree depends on the catalog *and* on the subject's grants, and
 *   would therefore have to be invalidated by every row of Doc 04 §7's table as
 *   well as by every catalog edit. That is the "one less cache to invalidate" §6
 *   is talking about, and it is avoided by caching the operand instead of the
 *   result.
 * - Combined with the grants cache, it makes the common navigation call **two
 *   Redis reads and no database round-trip at all** — the property
 *   `grants-source.ts` claims for the guard, for the same reason: this is called
 *   on every entry into every application.
 *
 * ## It is global, and that is a property of the tables rather than a choice
 *
 * `nav_node` and `menu_permission` are *catalog* tables: globally readable, rows
 * belonging to no client (migrations 0008 and 0009, Doc 07 §6). Which of the
 * catalog a tenant may see is decided by `client_application` enablement and by
 * resolution, both of which happen outside this cache — `navigation.service.ts`
 * checks enablement against Postgres on every call and prunes against the
 * caller's own grants. So one entry per application, shared across tenants, holds
 * nothing tenant-specific and cannot leak between them.
 *
 * ## The protocol is `grants-cache.service.ts`'s, deliberately
 *
 * An entry carrying the counter it was written under, both keys read in one
 * `MGET`, a mismatch treated as a miss, and every failure path falling back to
 * Postgres. That file argues each of those at length and the argument transfers
 * unchanged; what does not transfer is its TTL, which exists to bound
 * `role_binding.expires_at` staleness (Doc 01 §4.5). A nav catalog has no clock
 * in it, so {@link NAV_CATALOG_TTL_SECONDS} is a memory bound and the backstop
 * for a bump that Redis dropped, nothing more — hence an hour rather than ten
 * minutes.
 *
 * ## Neither key is published
 *
 * `grantsCacheKey` lives in `@plantops/contracts` because Doc 04 §6 publishes the
 * entry's shape and other processes hold grants caches. Nothing outside this
 * process holds a nav catalog: Doc 05 §7 has the frontend call `/iam/navigation`
 * and render the answer, so there is no second holder to agree with. Both keys
 * are therefore derived here and spelled nowhere else, and they land under
 * `REDIS_KEY_PREFIX` automatically because `RedisService` configures the client
 * with it.
 *
 * ## `bump()` is post-commit only, and never throws
 *
 * The callers are `registry/nav.service.ts` and `registry/manifest.service.ts`,
 * both through `afterCommit()`. Publishing a bump before the catalog edit commits
 * would let a reader repopulate this entry from the pre-change rows and re-poison
 * it — Doc 04 §7.1 rule 3's hazard, which is about grants but is a property of
 * "invalidate a cache, then commit" rather than of grants. And a failed bump must
 * not turn a successful catalog edit into a 500: the rows are committed, the
 * database is authoritative, and what is lost is bounded staleness until the TTL.
 */

import { Injectable, Logger } from '@nestjs/common';
import { withTimeout } from '../common/with-timeout';
import { RedisService } from '../redis/redis.service';
import type { NavCatalog } from './prune';

/**
 * How long an entry lives.
 *
 * An hour, because the version is what makes this cache *correct* and the TTL is
 * only what makes it *bounded*. A nav catalog is edited when somebody uploads a
 * manifest; between uploads it is immutable, so expiring it every ten minutes
 * would buy nothing and cost two queries per application per interval.
 */
export const NAV_CATALOG_TTL_SECONDS = 3_600;

/**
 * Budget for a round-trip, matching the grants cache's.
 *
 * Same reasoning: this exists to make a request faster, so it must never be the
 * slowest thing in one. Past the budget the caller reads the catalog from
 * Postgres, which is what a miss would have done anyway.
 */
const CACHE_TIMEOUT_MS = 250;

/** The stored form: a catalog, plus the counter value it was current for. */
interface CachedNavCatalog extends NavCatalog {
  v: number;
}

/**
 * A read: the catalog if it is still current, and the counter it was compared
 * against.
 *
 * The version comes back on a miss too, because the caller needs it to stamp the
 * entry it is about to build — and it must be the value observed *before* the
 * read of Postgres, for the reason `resolver.service.ts` gives about grants. A
 * `null` version means the counter could not be read at all, and therefore that
 * nothing may be written: an entry stamped with a guessed version is worse than
 * no entry.
 */
export interface NavCatalogRead {
  catalog: NavCatalog | null;
  version: number | null;
}

const MISS: NavCatalogRead = { catalog: null, version: null };

@Injectable()
export class NavCatalogCacheService {
  private readonly logger = new Logger(NavCatalogCacheService.name);

  constructor(private readonly redis: RedisService) {}

  /** The application's cached catalog, if the entry is still current. */
  async read(applicationId: string): Promise<NavCatalogRead> {
    const key = entryKey(applicationId);

    let entry: string | null;
    let counter: string | null;
    try {
      [entry, counter] = await withTimeout(
        this.redis.client.mget(key, versionKey(key)),
        CACHE_TIMEOUT_MS,
        'nav catalog cache read',
      );
    } catch (error) {
      this.logger.warn(
        `Nav catalog cache unavailable (${messageOf(error)}); reading from Postgres`,
      );
      return MISS;
    }

    const version = counter === null ? 0 : Number(counter);
    if (!Number.isFinite(version)) return MISS;
    if (entry === null) return { catalog: null, version };

    let cached: CachedNavCatalog;
    try {
      cached = JSON.parse(entry) as CachedNavCatalog;
    } catch {
      this.logger.warn(`Discarding an unreadable nav catalog entry for ${key}`);
      return { catalog: null, version };
    }

    // An entry written before the last catalog edit is not stale data to be
    // repaired, it is a miss (Doc 05 §6).
    if (cached.v !== version) return { catalog: null, version };

    return { catalog: { nodes: cached.nodes, gates: cached.gates }, version };
  }

  /**
   * Stores `catalog` as current for `version`.
   *
   * The counter's TTL is twice the entry's, for the reason the grants cache gives:
   * were the counter to expire first, a live entry stamped `v: 3` would be
   * compared against a missing counter, read as 0, and discarded — correct, but a
   * cache that has quietly stopped working.
   */
  async write(
    applicationId: string,
    catalog: NavCatalog,
    version: number | null,
  ): Promise<void> {
    if (version === null) return;

    const key = entryKey(applicationId);
    const entry: CachedNavCatalog = { ...catalog, v: version };

    try {
      await withTimeout(
        this.redis.client
          .multi()
          .set(key, JSON.stringify(entry), 'EX', NAV_CATALOG_TTL_SECONDS)
          .expire(versionKey(key), NAV_CATALOG_TTL_SECONDS * 2)
          .exec(),
        CACHE_TIMEOUT_MS,
        'nav catalog cache write',
      );
    } catch (error) {
      // Nothing to recover: the caller already holds the authoritative catalog
      // and the next request simply reads it again.
      this.logger.warn(`Nav catalog cache write failed (${messageOf(error)})`);
    }
  }

  /**
   * Moves the application's `app_nav_version` forward (Doc 05 §6).
   *
   * `INCR` on a missing counter creates it at 1, which is already ahead of the
   * `v: 0` any entry written without one carries — so an application that has
   * never been cached and one whose counter has expired are both invalidated
   * correctly rather than by luck.
   *
   * **Call only from `afterCommit()`**, and note that it never throws; see the
   * file header for both.
   */
  async bump(applicationId: string): Promise<void> {
    const key = versionKey(entryKey(applicationId));

    try {
      await withTimeout(
        this.redis.client
          .multi()
          .incr(key)
          .expire(key, NAV_CATALOG_TTL_SECONDS * 2)
          .exec(),
        CACHE_TIMEOUT_MS,
        'nav catalog invalidation',
      );
    } catch (error) {
      this.logger.error(
        `The nav catalog of application ${applicationId} could not be invalidated ` +
          `(${messageOf(error)}); cached trees stay live until their TTL expires`,
      );
    }
  }
}

/** `nav:{applicationId}` — one entry per application. */
function entryKey(applicationId: string): string {
  return `nav:${applicationId}`;
}

/**
 * The counter beside an entry.
 *
 * Derived from the entry key rather than built from the parts again, so the two
 * cannot be namespaced differently — the shape `grants-cache.service.ts` uses.
 */
function versionKey(key: string): string {
  return `${key}:v`;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
