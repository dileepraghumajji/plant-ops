/**
 * The client-side half of the grants cache (Doc 06 §11).
 *
 * `GET /iam/permissions/resolve` is the hot path of the whole system: a module
 * authorizing a request needs the caller's grants, and `auth-kit`'s
 * `PermissionGuard` asks for them on every gated call (Doc 08 §4). Answering
 * each one over HTTP would put the IAM back on the per-request critical path,
 * which is exactly what Doc 06 §11 says not to do.
 *
 * ## Why the TTL here is short, and the server's is not
 *
 * The IAM's Redis cache holds grants for ten minutes because it is *versioned*:
 * a mutation bumps the subject's counter and the next read misses (Doc 04 §6–7),
 * so a stale answer is impossible rather than merely unlikely. This cache has no
 * such channel. It is a plain TTL, and the TTL is the entire window in which a
 * revoked permission still appears to be held. Sixty seconds keeps that window
 * roughly an order of magnitude shorter than the ten minutes the versioned cache
 * can afford, and still absorbs the burst of calls one screen or one request
 * fan-out produces, which is all a client cache is for.
 *
 * A consumer that *does* have an invalidation channel — a module subscribed to
 * `perms.invalidated` — should call {@link ResolveCache.invalidate} from it and
 * may then raise the TTL. That is why the entry point is a method rather than a
 * private detail.
 *
 * ## Single flight, per key
 *
 * Two concurrent authorizations for the same subject must produce one HTTP call,
 * for the same reason the token refresh does: the burst is the normal case, not
 * the exception. In-flight requests are shared and only the settled result is
 * cached, so a failed resolve leaves nothing behind to serve.
 */

import type { ResolvedGrants, ResolveQuery } from '@plantops/contracts';

export interface ResolveCacheOptions {
  /** Default 60. Zero disables caching without changing any call site. */
  ttlSeconds?: number;
  /** Injectable clock, so expiry is tested without timers. */
  now?: () => number;
}

/** Doc 06 §11's optional narrowing, plus the "whole grant set" case. */
const keyOf = (query: ResolveQuery): string => query.applicationId ?? '*';

const DEFAULT_TTL_SECONDS = 60;

interface Entry {
  grants: ResolvedGrants;
  expiresAt: number;
}

export class ResolveCache {
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly entries = new Map<string, Entry>();
  private readonly inFlight = new Map<string, Promise<ResolvedGrants>>();

  constructor(
    /** The uncached call — `GET /iam/permissions/resolve`. */
    private readonly load: (query: ResolveQuery) => Promise<ResolvedGrants>,
    options: ResolveCacheOptions = {},
  ) {
    this.ttlMs = (options.ttlSeconds ?? DEFAULT_TTL_SECONDS) * 1000;
    this.now = options.now ?? (() => Date.now());
  }

  /** The subject's grants, from cache when fresh. */
  async get(query: ResolveQuery = {}): Promise<ResolvedGrants> {
    const key = keyOf(query);

    const cached = this.entries.get(key);
    if (cached !== undefined && cached.expiresAt > this.now()) return cached.grants;
    this.entries.delete(key);

    const flight = this.inFlight.get(key);
    if (flight !== undefined) return flight;

    return this.reload(query);
  }

  /** Fetches unconditionally, and repopulates. Concurrent callers still share it. */
  reload(query: ResolveQuery = {}): Promise<ResolvedGrants> {
    const key = keyOf(query);
    const existing = this.inFlight.get(key);
    if (existing !== undefined) return existing;

    const flight = this.load(query)
      .then((grants) => {
        if (this.ttlMs > 0) {
          this.entries.set(key, { grants, expiresAt: this.now() + this.ttlMs });
        }
        return grants;
      })
      .finally(() => {
        this.inFlight.delete(key);
      });

    this.inFlight.set(key, flight);
    return flight;
  }

  /**
   * Drops one application's slice, or — with no argument — everything.
   *
   * Called on every token change: a new subject's grants have nothing to do
   * with the last one's, and serving them across a login would be the one
   * caching bug that hands a user somebody else's menu.
   */
  invalidate(applicationId?: string): void {
    if (applicationId === undefined) {
      this.entries.clear();
      return;
    }
    this.entries.delete(applicationId);
  }

  /** Everything, including the unfiltered entry. */
  clear(): void {
    this.entries.clear();
  }
}
